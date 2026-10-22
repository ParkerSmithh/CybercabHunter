import Foundation
import Observation

/// Moderation → Gmail Link (the website's moderation.js forwarding stats and
/// js/moderation-gmail.js): rider Gmail receipt forwarding, aggregate counts
/// only. The routes never return a rider, address or email.
@MainActor
@Observable
final class GmailLinkModel {
    enum State<T: Equatable>: Equatable { case loading, ready(T), failed }

    private(set) var stats: State<ForwardingStats> = .loading
    private(set) var detail: State<ForwardingDetail> = .loading
    private(set) var accessLost: ModerationModel.Access?

    func load(api: APIClient) async {
        async let s: Void = loadStats(api: api)
        async let d: Void = loadDetail(api: api)
        _ = await (s, d)
    }

    func loadStats(api: APIClient) async {
        if case .ready = stats {} else { stats = .loading }
        do {
            let s: ForwardingStats = try await api.get("/api/moderation/forwarding-stats", authenticated: true, fresh: true)
            stats = .ready(s)
        } catch is CancellationError {
        } catch { if !lost(error) { stats = .failed } }
    }

    func loadDetail(api: APIClient) async {
        if case .ready = detail {} else { detail = .loading }
        do {
            let d: ForwardingDetail = try await api.get("/api/moderation/forwarding-detail", authenticated: true, fresh: true)
            detail = .ready(d)
        } catch is CancellationError {
        } catch { if !lost(error) { detail = .failed } }
    }

    private func lost(_ error: Error) -> Bool {
        switch error {
        case APIError.unauthorized: accessLost = .signedOut; return true
        case APIError.http(403, _): accessLost = .forbidden; return true
        default: return false
        }
    }

    /// The outcomes in the website's order. The decoder camel-cases keys, so
    /// both spellings are looked up.
    static let outcomes: [(key: String, label: String)] = [
        ("accepted", "Accepted (ride recorded)"), ("needs_review", "Needs review"), ("duplicate", "Duplicate (already had it)"),
        ("rejected", "Rejected (not a Tesla Robotaxi receipt)"), ("parse_error", "Could not be read")
    ]
    static func count(_ byStatus: [String: Int], _ key: String) -> Int { byStatus[key] ?? byStatus[APIClient.camelCase(key)] ?? 0 }

    static func percent(_ part: Int, of whole: Int) -> String { whole > 0 ? "\(Int((Double(part) / Double(whole) * 100).rounded()))%" : "—" }

    /// "Jan 5, 2026, 3:04 PM CT", or "never".
    static func when(_ iso: String?) -> String {
        guard let d = Format.instant(iso) else { return "never" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "MMM d, yyyy, h:mm a"
        return f.string(from: d) + " CT"
    }

    static func shortDay(_ ymd: String) -> String {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return ymd }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(months[max(0, min(11, parts[1] - 1))]) \(parts[2])"
    }
}
