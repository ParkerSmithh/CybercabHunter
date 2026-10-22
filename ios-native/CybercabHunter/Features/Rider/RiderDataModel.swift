import Foundation
import Observation

/// GET /api/profile (worker/profile.js): the signed-in rider's own ride
/// statistics. Only the parts the website's Rider Data page shows.
struct RiderData: Decodable, Sendable, Equatable {
    struct User: Decodable, Sendable, Equatable {
        let displayName: String?
        let handle: String?
        let avatarUrl: String?
        let joinedAt: String?
    }
    struct Summary: Decodable, Sendable, Equatable {
        let tripCount: Int
        let firstRideDate: String?
        let lastRideDate: String?
        let totalDistance: Double?
        let avgDistance: Double?
        let longestRideDistance: Double?
        let uniqueVehicles: Int?
        let totalDurationMinutes: Double?
        let avgDurationMinutes: Double?
        let ridesWithDerivedDuration: Int?
    }
    struct City: Decodable, Sendable, Equatable {
        let serviceArea: String
        let rideCount: Int
        let totalDistance: Double?
        let ridesWithDistance: Int
        let firstRideDate: String?
    }
    struct Spending: Decodable, Sendable, Equatable {
        let currency: String
        let currencySource: String?
        let freeCount: Int
        let totalCents: Double
        let avgCents: Double
        let medianCents: Double
    }
    struct Month: Decodable, Sendable, Equatable {
        let month: String
        let rideCount: Int
        let totalDistance: Double?
        let ridesWithDistance: Int?
    }
    struct Coverage: Decodable, Sendable, Equatable {
        let rides: Int
        let withFare: Int
        let withDistance: Int
        let withDuration: Int
        let withCity: Int
        let withDate: Int
        let withVehicle: Int
    }
    let user: User
    let contributions: Int?
    let rideSummary: Summary?
    let cities: [City]
    let spending: [Spending]
    let monthlyActivity: [Month]
    let coverage: Coverage
    let underReview: Int
}

/// GET /api/trips: the rider's rides, newest first, 10 a page.
struct TripsPage: Decodable, Sendable, Equatable {
    struct Trip: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let rideDate: String?
        let city: String?
        let distance: Double?
        let fareAmountCents: Int?
        let currency: String?
        let vehiclePlate: String?
        let source: String?
        let corrected: Bool?
        let status: String?
    }
    struct Pagination: Decodable, Sendable, Equatable { let page: Int; let total: Int; let totalPages: Int }
    let trips: [Trip]
    let pagination: Pagination
}

/// The Rider Data page (public/rider-data.html, js/rider-data.js). Four
/// states kept apart, as on the site: loading, an error (NOT signed out),
/// signed out, and the data (which includes "no counted rides yet").
/// Missing values show as an em dash, never as 0.
@MainActor
@Observable
final class RiderDataModel {
    enum State: Equatable { case loading, failed(String), signedOut, ready }
    static let pageSize = 10

    private(set) var state: State = .loading
    private(set) var data: RiderData?
    private(set) var rides: TripsPage?
    private(set) var ridesFailed = false
    private(set) var page = 1
    /// The ride whose "Remove this ride?" prompt is open.
    var pendingDelete: String?
    private(set) var removing: String?
    var actionError: String?
    private(set) var isModerator = false
    private(set) var teslaLinked = false

    func load(api: APIClient, skeleton: Bool = true) async {
        if skeleton || data == nil { state = .loading }
        async let p = Self.attempt { try await api.get("/api/profile", as: RiderData.self, authenticated: true, fresh: true) }
        async let r = Self.attempt { try await api.get("/api/trips", query: Self.pageQuery(self.page), as: TripsPage.self, authenticated: true, fresh: true) }
        async let m: MeResponse? = try? api.get("/api/me", authenticated: true, fresh: true)
        async let a: ModerationAccess? = try? api.get("/api/moderation/access", authenticated: true)
        let (profile, trips, me, access) = await (p, r, m, a)
        switch (profile, trips) {
        case (.failure(APIError.unauthorized), _), (_, .failure(APIError.unauthorized)):
            state = .signedOut
        case (.success(let d), .success(let t)):
            data = d; rides = t; page = t.pagination.page; pendingDelete = nil; ridesFailed = false
            teslaLinked = me?.authenticated == true && me?.tesla?.connected == true
            isModerator = access?.moderator == true
            state = .ready
        case (.failure(let e), _), (_, .failure(let e)):
            if case .http(let status, _) = e as? APIError {
                state = .failed("The server had a problem (code \(status)). You're still signed in, and your data is safe. Try again in a moment.")
            } else {
                state = .failed("We couldn't reach Cybercab Hunter. Check your connection and try again.")
            }
        }
    }

    func loadPage(_ n: Int, api: APIClient) async {
        do {
            let t: TripsPage = try await api.get("/api/trips", query: Self.pageQuery(n), authenticated: true, fresh: true)
            rides = t; page = t.pagination.page; pendingDelete = nil; ridesFailed = false
        } catch APIError.unauthorized { state = .signedOut } catch { ridesFailed = true }
    }

    /// DELETE /api/trips/:id after the inline confirmation. A 404 means it is
    /// already gone, which meets the goal too. The server re-checks ownership.
    func remove(_ id: String, api: APIClient) async {
        removing = id
        defer { removing = nil }
        let request = api.makeRequest("/api/trips/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)", method: "DELETE", authenticated: true)
        do {
            let (_, status) = try await api.exchange(request)
            pendingDelete = nil
            if (200..<300).contains(status) || status == 404 {
                actionError = status == 404 ? "That ride was already removed." : nil
                if rides?.trips.count == 1 && page > 1 { page -= 1 }
                await load(api: api, skeleton: false)
            } else if status == 401 {
                actionError = "Your session has expired. Sign in again to remove rides."
            } else {
                actionError = "Couldn't remove the ride. Nothing was changed. Try again in a moment."
            }
        } catch {
            pendingDelete = nil
            actionError = "Couldn't remove the ride. Check your connection. Nothing was changed."
        }
    }

    private static func pageQuery(_ n: Int) -> [URLQueryItem] {
        [URLQueryItem(name: "page", value: String(n)), URLQueryItem(name: "page_size", value: String(pageSize))]
    }
    private static func attempt<T: Sendable>(_ body: () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await body()) } catch { return .failure(error) }
    }

    // MARK: Notes (the site's coverage sentences)

    static func heroNote(_ d: RiderData) -> String {
        let c = d.coverage
        var notes: [String] = []
        if c.rides > 0 && c.withDistance < c.rides { notes.append("Distance recorded for \(c.withDistance) of \(Format.plural(c.rides, "ride", "rides")).") }
        if c.rides > 0 && c.withVehicle < c.rides { notes.append("Vehicle identified for \(c.withVehicle) of \(c.rides).") }
        if d.underReview > 0 { notes.append("\(Format.plural(d.underReview, "ride", "rides")) under review \(d.underReview == 1 ? "is" : "are") not counted yet.") }
        return notes.joined(separator: " ")
    }

    static func summaryNote(_ d: RiderData) -> String {
        let c = d.coverage
        var parts: [String] = []
        if c.withDistance < c.rides { parts.append("Distance recorded for \(c.withDistance) of \(Format.plural(c.rides, "ride", "rides")). Average and longest use only those.") }
        if c.withDuration < c.rides { parts.append("Duration recorded for \(c.withDuration) of \(c.rides). Time on board uses only those.") }
        if let n = d.rideSummary?.ridesWithDerivedDuration, n > 0 { parts.append("\(Format.plural(n, "duration", "durations")) calculated from pickup and dropoff times rather than stated on the receipt.") }
        if c.withDate < c.rides { parts.append("Date recorded for \(c.withDate) of \(c.rides).") }
        if c.withCity < c.rides { parts.append("City recorded for \(c.withCity) of \(c.rides).") }
        return parts.joined(separator: " ")
    }

    static func spendingNote(_ d: RiderData) -> String {
        let c = d.coverage
        var notes = ["Fares recorded for \(c.withFare) of \(Format.plural(c.rides, "ride", "rides"))."]
        if c.withFare < c.rides { notes.append("Rides with no fare on the receipt are left out. They are not counted as free.") }
        if d.spending.contains(where: { $0.currencySource != "extracted" }) { notes.append("Tesla receipts show only “$”, so US dollars are assumed.") }
        return notes.joined(separator: " ")
    }

    /// The last 12 months, oldest first: (yyyy-MM key, label, rides).
    static func months(_ d: RiderData, now: Date = .now) -> [(key: String, label: String, rides: Int)] {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = .current
        let byMonth = Dictionary(d.monthlyActivity.map { ($0.month, $0.rideCount) }, uniquingKeysWith: +)
        let start = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        return (0..<12).reversed().map { i in
            let m = cal.date(byAdding: .month, value: -i, to: start)!
            let c = cal.dateComponents([.year, .month], from: m)
            let key = String(format: "%04d-%02d", c.year!, c.month!)
            return (key, m.formatted(.dateTime.month(.abbreviated)), byMonth[key] ?? 0)
        }
    }

    static func monthlyNote(_ d: RiderData, now: Date = .now) -> String {
        let window = Set(months(d, now: now).map(\.key))
        let older = d.monthlyActivity.filter { !window.contains($0.month) }.reduce(0) { $0 + $1.rideCount }
        let undated = d.coverage.rides - d.coverage.withDate
        var notes: [String] = []
        if older > 0 { notes.append("\(Format.plural(older, "ride", "rides")) from before this window \(older == 1 ? "is" : "are") not shown here.") }
        if undated > 0 { notes.append("\(Format.plural(undated, "ride", "rides")) without a date can't be placed in a month.") }
        return notes.joined(separator: " ")
    }

    // MARK: Formatting (em dash for missing)

    static func miles(_ v: Double?) -> String { v.map { String(format: "%.1f mi", $0) } ?? "—" }
    static func count(_ v: Int?) -> String { v.map(Format.int) ?? "—" }
    static func duration(_ minutes: Double?) -> String {
        guard let minutes, minutes.isFinite, minutes >= 0 else { return "—" }
        let total = Int(minutes.rounded())
        if total < 60 { return "\(total) min" }
        return String(format: "%dh %02dm", total / 60, total % 60)
    }
    static func money(_ cents: Double?, _ currency: String?) -> String {
        guard let cents else { return "—" }
        return (cents / 100).formatted(.currency(code: currency ?? "USD").locale(Locale(identifier: "en_US")))
    }
    static func date(_ ymd: String?) -> String {
        guard let ymd, let d = Format.calendarDate(String(ymd.prefix(10))) else { return "—" }
        return d.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day().year())
    }
    static func fare(_ t: TripsPage.Trip) -> String {
        guard let c = t.fareAmountCents else { return "—" }
        return c == 0 ? "Free" : money(Double(c), t.currency)
    }
    static let sourceLabels = ["receipt_email": "Email receipt", "receipt_import": "Imported receipt"]
}

/// /api/receipt-ingestion/* and /api/rides/sync-status: getting Tesla's
/// receipt emails here by Gmail forwarding (public/link-gmail.html). The app
/// never signs in to Gmail and never sees a Google token: the rider sets up a
/// forwarding filter in Gmail, and the Worker reads only the mail that arrives
/// at the rider's own address.
struct IngestionAddress: Decodable, Sendable, Equatable {
    let address: String?
    let domainConfigured: Bool?
}

struct SyncStatus: Decodable, Sendable, Equatable {
    struct Forwarding: Decodable, Sendable, Equatable {
        let setupCompletedAt: String?
        let confirmationCode: String?
        let confirmationLink: String?
        let confirmationRequestedBy: String?
        let confirmationCodeReceivedAt: String?
        let lastReceivedAt: String?
    }
    let forwarding: Forwarding
}

struct ForwardingDone: Decodable, Sendable, Equatable { let success: Bool }

@MainActor
@Observable
final class GmailForwardingModel {
    enum State: Equatable { case loading, failed(String), signedOut, ready }
    enum Address: Equatable { case ready(String), pending, revoked }

    private(set) var state: State = .loading
    private(set) var address: Address = .pending
    private(set) var status: SyncStatus.Forwarding?
    private(set) var rotating = false
    private(set) var saving = false
    var notice: (text: String, ok: Bool)?

    // The site's rule (bug 2026-10-05): linked when the CURRENT address has
    // received mail and no Gmail confirmation is waiting. Historical receipts
    // on an older address don't count.
    static func pending(_ f: SyncStatus.Forwarding) -> Bool { f.confirmationCode?.isEmpty == false || safeLink(f.confirmationLink) != nil }
    static func linked(_ f: SyncStatus.Forwarding) -> Bool { f.lastReceivedAt != nil && !pending(f) }
    /// The rider-data page's "Stop Sync" state also counts a completed setup.
    static func syncing(_ f: SyncStatus.Forwarding) -> Bool { f.setupCompletedAt != nil || linked(f) }
    /// Only https links on Google's mail-settings hosts are ever opened.
    static func safeLink(_ s: String?) -> URL? {
        guard let s, let u = URL(string: s), u.scheme == "https", ["mail-settings.google.com", "mail.google.com"].contains(u.host() ?? "") else { return nil }
        return u
    }
    var linked: Bool { status.map(Self.linked) ?? false }
    /// Poll faster while Gmail's confirmation may be on its way (link-gmail.js).
    var pollSeconds: Double { status.map { Self.pending($0) ? 20 : 8 } ?? 60 }

    func load(api: APIClient) async {
        state = .loading
        let addr = try? await api.exchange(api.makeRequest("/api/receipt-ingestion/address", authenticated: true))
        let sync: Result<SyncStatus, Error>
        do { sync = .success(try await api.get("/api/rides/sync-status", authenticated: true, fresh: true)) } catch { sync = .failure(error) }
        guard let addr else { state = .failed("We couldn't reach Cybercab Hunter. Check your connection and try again."); return }
        if addr.1 == 401 { state = .signedOut; return }
        if case .failure(APIError.unauthorized) = sync { state = .signedOut; return }
        guard case .success(let s) = sync, (200..<300).contains(addr.1) || addr.1 == 409 else {
            let code: Int = { if case .failure(APIError.http(let st, _)) = sync { return st }; return addr.1 }()
            state = .failed("The server had a problem (code \(code)). You're still signed in. Try again in a moment.")
            return
        }
        apply(addr, api: api)
        status = s.forwarding
        state = .ready
    }

    func refresh(api: APIClient) async {
        do {
            let s: SyncStatus = try await api.get("/api/rides/sync-status", authenticated: true, fresh: true)
            status = s.forwarding
        } catch APIError.unauthorized { state = .signedOut } catch {}
    }

    private func apply(_ r: (Data, Int), api: APIClient) {
        if r.1 == 409 { address = .revoked; return }
        if let a: IngestionAddress = try? api.decode(r.0), a.domainConfigured == true, let s = a.address { address = .ready(s) } else { address = .pending }
    }

    /// POST /api/receipt-ingestion/address/rotate: a fresh address; the old
    /// one stops accepting mail at once. Rides already saved are untouched.
    /// It is also how sync is stopped (the rider-data page's Stop Sync).
    func rotate(api: APIClient, stopping: Bool = false) async {
        rotating = true
        defer { rotating = false }
        guard let r = try? await api.exchange(api.makeRequest("/api/receipt-ingestion/address/rotate", method: "POST", authenticated: true)) else {
            notice = ("Couldn't \(stopping ? "stop sync" : "get a new address"). Check your connection and try again.", false); return
        }
        switch r.1 {
        case 200..<300, 409:
            apply(r, api: api)
            notice = r.1 == 409 ? ("Your forwarding address is turned off for this account.", false)
                : stopping ? ("Sync stopped. Your old forwarding address no longer accepts receipts. Existing rides are saved. Set up forwarding again with the new address to resume.", true)
                : ("New address ready. Your old one no longer works. If you set up automatic forwarding, add this address in Gmail and point your filter at it.", true)
            await refresh(api: api)
        case 401: notice = ("Your session has expired. Sign in again.", false)
        default: notice = ("Couldn't \(stopping ? "stop sync" : "get a new address"). Your current one still works. Try again in a moment.", false)
        }
    }

    /// POST /api/receipt-ingestion/setup/complete: the rider says they finished
    /// the steps. It records only that; it never claims a receipt arrived.
    func markDone(api: APIClient) async -> Bool {
        saving = true
        defer { saving = false }
        do {
            let r: ForwardingDone = try await api.send("/api/receipt-ingestion/setup/complete", method: "POST")
            if r.success { await refresh(api: api); return true }
        } catch APIError.unauthorized { state = .signedOut; return false } catch {}
        notice = ("Couldn't save your setup. Please try again.", false)
        return false
    }
}

/// The Tesla account link (worker/tesla.js): read access to the rider's
/// eligible Tesla vehicle information, NOT ride history. The website offers it
/// to moderators only; so does the app. Linking happens on Tesla's own sign-in
/// page (Safari's in-app viewer, opened with a one-time two-minute link
/// token), so the app never sees a Tesla password or token.
@MainActor
@Observable
final class TeslaLinkModel {
    private(set) var working = false
    var message: String?

    /// POST /oauth/tesla/link → the start URL with the one-time token. Never a
    /// plain start URL for a signed-in rider: that would create a second account.
    func startURL(api: APIClient) async -> URL? {
        working = true
        defer { working = false }
        struct Link: Decodable, Sendable { let linkToken: String? }
        guard let r: Link = try? await api.send("/oauth/tesla/link", method: "POST"), let token = r.linkToken else {
            message = "Could not start Tesla linking. Please try again."
            return nil
        }
        var c = URLComponents(url: AppConfig.teslaOAuthOrigin.appending(path: "oauth/tesla/start"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "link", value: token)]
        return c.url
    }

    /// POST /api/tesla/disconnect: removes the stored link on our side.
    func unlink(api: APIClient) async -> Bool {
        working = true
        defer { working = false }
        let ok = (try? await api.exchange(api.makeRequest("/api/tesla/disconnect", method: "POST", authenticated: true)))
            .map { (200..<300).contains($0.1) } ?? false
        message = ok ? nil : "Couldn't unlink Tesla. Try again in a moment."
        return ok
    }
}
