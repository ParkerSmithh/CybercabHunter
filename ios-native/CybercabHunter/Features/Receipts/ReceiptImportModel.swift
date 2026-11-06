import Foundation
import UIKit
import Observation

/// One receipt from any source (scan, camera, Photos, Files, Share Sheet):
/// read on the device -> checked by the server's own parser (preview, nothing
/// saved) -> reviewed (the rider can correct the recognized text and check
/// again) -> imported through POST /api/rides/import, the same pipeline as
/// forwarded email, so duplicates and pickup-time rules are the same.
@MainActor
@Observable
final class ReceiptImportModel {
    enum Stage: Equatable {
        case choosing
        case reading
        case checking
        case review(ReceiptPreview)
        case importing
        case done(String)
        case failed(String)
    }
    private(set) var stage: Stage = .choosing
    /// The words the parser will read; editable on the review screen.
    var text = ""
    private(set) var kind = "text"
    private(set) var recognized = false
    private(set) var note: String?

    /// Shared from another app (ReceiptShareInbox), taken once.
    /// A shared receipt is READ, not taken: it stays in the inbox (so signing in,
    /// a dropped connection or closing the screen never loses it) until it is
    /// imported or the rider discards it.
    private(set) var share: ReceiptShareInbox.Share?
    func load(share: ReceiptShareInbox.Share, api: APIClient) async {
        guard let data = ReceiptShareInbox.read(share.id) else { stage = .failed("The shared receipt is no longer available. Share it again."); return }
        self.share = share
        if share.skipped > 0 { note = "One receipt at a time: the first of the items you shared is open here." }
        await load(data: data, api: api)
    }
    func discardShare() { if let share { ReceiptShareInbox.discard(share.id); self.share = nil } }

    func load(data: Data, api: APIClient) async {
        stage = .reading
        do { apply(try await ReceiptText.from(data)) } catch { stage = .failed(Self.readFailure(error)); return }
        await check(api: api)
    }

    func load(images: [UIImage], api: APIClient) async {
        stage = .reading
        do { apply(try await ReceiptText.images(images)) } catch { stage = .failed(Self.readFailure(error)); return }
        await check(api: api)
    }

    private func apply(_ source: ReceiptText.Source) {
        text = source.content; kind = source.kind; recognized = source.recognized
    }

    /// The server's parser on the current text. Nothing is saved.
    func check(api: APIClient) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { stage = .failed("There's no receipt text to check."); return }
        stage = .checking
        do {
            let preview: ReceiptPreview = try await api.perform(request(api, "/api/rides/import/preview"))
            stage = .review(preview)
        } catch APIError.unauthorized {
            stage = .failed("Sign in to import receipts.")
        } catch APIError.http(422, _) {
            stage = .failed("Unable to read this receipt. Try a clearer photo, the PDF, or the original email.")
        } catch {
            stage = .failed("Couldn't check the receipt. Check your connection and try again.")
        }
    }

    func importNow(api: APIClient) async {
        stage = .importing
        do {
            let result: ReceiptImportRun = try await api.perform(request(api, "/api/rides/import"))
            discardShare()   // imported (or a known duplicate): the temporary copy goes
            stage = .done(Self.summary(result.run))
        } catch APIError.unauthorized {
            stage = .failed("Sign in to import receipts.")
        } catch {
            stage = .failed("The import didn't finish. Nothing was counted twice: try again.")
        }
    }

    private func request(_ api: APIClient, _ path: String) throws -> URLRequest {
        let body = try JSONSerialization.data(withJSONObject: ["items": [["kind": kind, "content": text]]])
        return api.makeRequest(path, method: "POST", jsonBody: body, authenticated: true)
    }

    func reset() { discardShare(); stage = .choosing; text = ""; note = nil; recognized = false; kind = "text" }

    static func summary(_ r: ReceiptImportRun.Run) -> String {
        if r.added > 0 { return r.added == 1 ? "New ride imported." : "\(r.added) new rides imported." }
        if r.updated > 0 { return "Your existing ride was updated." }
        if r.duplicates > 0 { return "Already imported: nothing was counted twice." }
        if r.needsReview > 0 { return "Saved for review: the receipt is missing details, so no ride was added." }
        if r.rejected > 0 { return "Receipt format not recognized. No ride was added." }
        return "The import didn't finish. Try again."
    }

    static func readFailure(_ error: Error) -> String {
        switch error as? ReceiptText.Failure {
        case .noText?: "No text was found. Try a sharper photo with the whole receipt in view."
        case .tooLarge?: "That file is too large to be a receipt."
        default: "That file couldn't be read. Use a PDF, a photo (JPEG, PNG or HEIC), or the receipt text."
        }
    }
}
