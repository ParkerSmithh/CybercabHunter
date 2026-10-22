import Foundation
import Observation

/// Moderation → Import Receipt (the website's moderation/import-receipt.html,
/// js/import-receipt.js). The moderator picks a rider by display name, then
/// sends receipt files or pasted text through the same receipt pipeline as
/// that rider. Nothing is made public here; the server checks the role.
@MainActor
@Observable
final class ImportReceiptModel {
    static let maxItems = 25
    static let maxItemChars = 2_000_000   // worker/receipt-import.js

    struct File: Identifiable, Equatable { let id = UUID(); let name: String; let content: String; let isEml: Bool }

    var query = "" { didSet { if query != oldValue { searchSeq += 1 } } }
    private(set) var riders: [RiderSearchResult.Rider] = []
    private(set) var riderStatus = ""
    private(set) var rider: RiderSearchResult.Rider?
    private(set) var files: [File] = []
    var pasted = ""
    private(set) var formError = ""
    private(set) var importing = false
    private(set) var result: ReceiptImportResult?
    private(set) var labels: [String] = []
    private(set) var accessLost: ModerationModel.Access?
    private var searchSeq = 0

    // MARK: Rider

    func searchRiders(api: APIClient) async {
        let q = query.trimmingCharacters(in: .whitespaces)
        let seq = searchSeq
        guard !q.isEmpty else { riders = []; riderStatus = ""; return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            let r: RiderSearchResult = try await api.get("/api/moderation/riders", query: [URLQueryItem(name: "display_name", value: String(q.prefix(100)))], authenticated: true, fresh: true)
            guard seq == searchSeq else { return }   // a slower, older search
            riders = r.riders
            riderStatus = r.riders.isEmpty ? "No rider with that display name." : ""
        } catch is CancellationError {
        } catch APIError.unauthorized { accessLost = .signedOut
        } catch APIError.http(403, _) { accessLost = .forbidden
        } catch APIError.transport {
            if seq == searchSeq { riderStatus = "Couldn't search riders. Check your connection." }
        } catch {
            if seq == searchSeq { riderStatus = "Couldn't search riders." }
        }
    }

    func choose(_ r: RiderSearchResult.Rider) { rider = r; formError = ""; riders = []; query = "" }
    func clearRider() { rider = nil }

    // MARK: Receipts

    func addFile(name: String, data: Data) {
        let content = String(decoding: data, as: UTF8.self)
        let isEml = name.lowercased().hasSuffix(".eml")
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { formError = "\(name) is empty."; return }
        if content.count > Self.maxItemChars { formError = "\(name) is too large."; return }
        files.append(File(name: name, content: content, isEml: isEml))
        formError = ""
    }

    func removeFile(_ f: File) { files.removeAll { $0.id == f.id } }

    /// The request items and their labels, or the website's message.
    func collect() -> (items: [[String: String]], labels: [String])? {
        let hasText = !pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if files.count + (hasText ? 1 : 0) > Self.maxItems { formError = "Import at most \(Self.maxItems) receipts at a time."; return nil }
        var items = files.map { ["kind": $0.isEml ? "eml" : "text", "content": $0.content] }
        var labels = files.map(\.name)
        if hasText {
            if pasted.count > Self.maxItemChars { formError = "The pasted text is too large."; return nil }
            items.append(["kind": "text", "content": pasted])
            labels.append("Pasted text")
        }
        if items.isEmpty { formError = "Choose a receipt file or paste the receipt text."; return nil }
        return (items, labels)
    }

    func submit(api: APIClient) async {
        guard !importing else { return }   // a second tap waits
        formError = ""
        guard let rider else { formError = "Choose the rider this receipt belongs to."; return }
        guard let collected = collect() else { return }
        importing = true
        defer { importing = false }
        do {
            let r: ReceiptImportResult = try await api.send("/api/moderation/receipt-import", method: "POST",
                                                            body: JSONBody.make(["rider_user_id": rider.id, "items": collected.items]))
            result = r
            labels = collected.labels
            // Keep the rider for the next receipt; clear only the receipts.
            files = []
            pasted = ""
        } catch APIError.unauthorized { accessLost = .signedOut
        } catch APIError.http(403, _) { accessLost = .forbidden
        } catch APIError.http(413, _) { formError = "That upload is too large."
        } catch APIError.http(_, "rider_not_found"?) { self.rider = nil; formError = "That rider no longer exists. Choose another."
        } catch APIError.http(_, "rider_has_no_display_name"?) { self.rider = nil; formError = "That rider has no display name, so a receipt can't be imported for them."
        } catch APIError.http(let status, _) { formError = "The import failed (code \(status)). Try again in a moment."
        } catch APIError.transport { formError = "Couldn't reach the server. Check your connection and try again."
        } catch is CancellationError {
        } catch { formError = "The import failed. Try again in a moment." }
    }

    // MARK: Labels (js/import-receipt.js)

    static let outcomes: [String: (String, Tone)] = [
        "created": ("Imported", .good), "updated": ("Updated an existing ride", .info), "duplicate": ("Already imported", .plain),
        "unidentified": ("Needs review: no ride created", .warn), "rejected": ("Not recognized as a Tesla receipt", .bad), "error": ("Import failed", .bad)
    ]
    enum Tone { case good, info, plain, warn, bad }
    static let reasons = [
        "missing_ride_identity": "The receipt's ride date or pickup time couldn't be read, so it can't be matched to a ride.",
        "not_recognized_as_tesla_receipt": "This doesn't look like a Tesla Robotaxi receipt.",
        "kept_existing_values": "This copy disagreed with values already stored and couldn't be shown to be newer, so they were kept.",
        "fare_mismatch": "The fare lines on the receipt disagree, so the ride is held for review.",
        "partial_match": "Only part of the receipt could be read, so the ride is held for review.",
        "import_failed": "The server couldn't process this receipt.",
        "extraction_failed": "The server couldn't read this receipt."
    ]

    var summary: String {
        guard let r = result else { return "" }
        let run = r.run
        var parts = ["\(run?.processed ?? 0) processed", "\(run?.added ?? 0) added"]
        if let n = run?.updated, n > 0 { parts.append("\(n) updated") }
        if let n = run?.duplicates, n > 0 { parts.append("\(n) already imported") }
        if let n = run?.needsReview, n > 0 { parts.append("\(n) need review") }
        if let n = run?.rejected, n > 0 { parts.append("\(n) rejected") }
        if let n = run?.errors, n > 0 { parts.append("\(n) failed") }
        let who = r.rider.map { "Added to \($0.displayName)'s Rider Data · " } ?? ""
        return who + parts.joined(separator: " · ")
    }

    static func date(_ d: String?) -> String {
        guard let d, let m = d.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/),
              let date = Calendar.current.date(from: DateComponents(year: Int(m.1), month: Int(m.2), day: Int(m.3))) else { return "—" }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
    static func time(_ t: String?) -> String {
        guard let t, let m = t.prefixMatch(of: /(\d{1,2}):(\d{2})/), let h = Int(m.1) else { return "—" }
        return "\(h % 12 == 0 ? 12 : h % 12):\(m.2) \(h < 12 ? "AM" : "PM")"
    }
    static func distance(_ d: Double?, _ unit: String?) -> String { d.map { String(format: "%.1f %@", $0, unit ?? "mi") } ?? "—" }
    static func fare(_ cents: Int?, _ currency: String?) -> String {
        guard let cents else { return "—" }
        return (Double(cents) / 100).formatted(.currency(code: currency ?? "USD").locale(Locale(identifier: "en_US")))
    }
}
