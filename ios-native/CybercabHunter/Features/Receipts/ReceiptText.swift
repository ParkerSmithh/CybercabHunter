import Foundation
import Vision
import PDFKit
import UIKit

// Turns a scanned, photographed or shared receipt into text, ON THE DEVICE,
// for the server's own receipt parser (/api/rides/import/preview). This is
// not a second parser: it only reads the words; the Worker decides what they
// mean, with the same rules as forwarded email. Nothing leaves the phone
// until the rider imports, and no third-party service sees the receipt.
enum ReceiptText {
    struct Source: Equatable, Sendable {
        /// "text" (recognized or plain text) or "eml" (a saved email message).
        let kind: String
        let content: String
        /// True when the words came from text recognition (worth a closer look).
        let recognized: Bool
    }
    enum Failure: Error, Equatable { case unreadable, noText, tooLarge }

    /// The server's per-receipt limit (worker/receipt-import.js MAX_ITEM_CHARS) is far above this.
    static let maxChars = 200_000
    static let maxPDFPages = 6

    static func from(_ data: Data) async throws -> Source {
        switch ReceiptShareInbox.kind(of: data) {
        case .pdf?: return try await pdf(data)
        case .image?: return try await image(data)
        case .text?: return try text(data)
        case nil:
            // Text with nothing in it is "no text", not an unreadable file.
            if let s = String(data: data, encoding: .utf8), s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw Failure.noText }
            throw Failure.unreadable
        }
    }

    static func text(_ data: Data) throws -> Source {
        guard let s = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { throw Failure.unreadable }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw Failure.noText }
        guard trimmed.count <= maxChars * 10 else { throw Failure.tooLarge }
        return Source(kind: looksLikeEmail(trimmed) ? "eml" : "text", content: looksLikeEmail(trimmed) ? s : String(trimmed.prefix(maxChars)), recognized: false)
    }

    /// A saved email (.eml): headers, a blank line, then the body.
    static func looksLikeEmail(_ s: String) -> Bool {
        // "\r\n" is ONE Character in Swift, so normalize before looking for header lines.
        let head = String(s.prefix(4000)).replacingOccurrences(of: "\r\n", with: "\n").lowercased()
        return head.hasPrefix("from:") || head.hasPrefix("received:") || head.hasPrefix("return-path:") || head.hasPrefix("delivered-to:") || head.hasPrefix("mime-version:")
            ? head.contains("\nsubject:") || head.hasPrefix("subject:") : false
    }

    /// A PDF's own text layer (a "Print to PDF" of the email has one), page by
    /// page; a scanned PDF without one is rendered and recognized instead.
    static func pdf(_ data: Data) async throws -> Source {
        guard let doc = PDFDocument(data: data), doc.pageCount > 0 else { throw Failure.unreadable }
        var lines: [String] = []
        for i in 0..<min(doc.pageCount, maxPDFPages) { if let s = doc.page(at: i)?.string { lines.append(s) } }
        let joined = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty { return Source(kind: "text", content: String(joined.prefix(maxChars)), recognized: false) }
        var recognized: [String] = []
        for i in 0..<min(doc.pageCount, maxPDFPages) {
            guard let page = doc.page(at: i) else { continue }
            let box = page.bounds(for: .mediaBox)
            let scale = min(2, 2400 / max(box.width, box.height, 1))
            let image = page.thumbnail(of: CGSize(width: box.width * scale, height: box.height * scale), for: .mediaBox)
            if let cg = image.cgImage { recognized.append(try await recognize(cg)) }
        }
        let text = recognized.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw Failure.noText }
        return Source(kind: "text", content: String(text.prefix(maxChars)), recognized: true)
    }

    static func image(_ data: Data) async throws -> Source {
        guard let ui = UIImage(data: data), let cg = downscaled(ui) else { throw Failure.unreadable }
        let text = try await recognize(cg).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw Failure.noText }
        return Source(kind: "text", content: String(text.prefix(maxChars)), recognized: true)
    }

    static func images(_ list: [UIImage]) async throws -> Source {
        var parts: [String] = []
        for ui in list { if let cg = downscaled(ui) { parts.append(try await recognize(cg)) } }
        let text = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw Failure.noText }
        return Source(kind: "text", content: String(text.prefix(maxChars)), recognized: true)
    }

    /// At most 3000 px on the long side: enough for receipt text, kind to memory.
    static func downscaled(_ image: UIImage, maxSide: CGFloat = 3000) -> CGImage? {
        let size = image.size
        let scale = min(1, maxSide / max(size.width, size.height, 1))
        if scale >= 1, let cg = image.cgImage, image.imageOrientation == .up { return cg }
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }.cgImage
    }

    /// Apple's on-device text recognition, read top to bottom, one line per
    /// observation: the line-by-line shape the receipt parser expects.
    static func recognize(_ image: CGImage) async throws -> String {
        try await withCheckedThrowingContinuation { done in
            let request = VNRecognizeTextRequest { request, error in
                if let error { done.resume(throwing: error); return }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations
                    .sorted { a, b in abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01 ? a.boundingBox.midY > b.boundingBox.midY : a.boundingBox.minX < b.boundingBox.minX }
                    .compactMap { $0.topCandidates(1).first?.string }
                done.resume(returning: lines.joined(separator: "\n"))
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false   // keep plates, times and amounts exactly as printed
            do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { done.resume(throwing: error) }
        }
    }
}
