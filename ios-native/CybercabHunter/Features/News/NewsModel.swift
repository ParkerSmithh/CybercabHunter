import Foundation
import Observation

/// GET /api/news (worker/news.js): Cybercab and robotaxi headlines, newest
/// first, picked and summarized automatically; each links OUT to the
/// original publisher. Public, edge-cached.
struct NewsPage: Decodable, Sendable, Equatable {
    struct Also: Decodable, Sendable, Equatable { let title: String?; let url: String; let source: String; let sourceType: String?; let publishedAt: String? }
    struct Story: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let url: String
        let source: String
        let sourceType: String?
        let publishedAt: String
        let excerpt: String?
        let thumbUrl: String?
        let imageUrl: String?
        let importance: Int?
        let tags: [String]?
        let also: [Also]?

        var isMajor: Bool { importance == 2 }
        /// Only https links are opened (news.js safeUrl).
        var link: URL? { url.lowercased().hasPrefix("https://") ? URL(string: url) : nil }
        /// The site's own thumbnail first (/news-img/<id>.webp), then the feed's image (https), else the outlet's initial.
        var thumbnail: URL? {
            if let t = thumbUrl, t.range(of: #"^/news-img/[0-9a-fA-F-]{36}\.webp$"#, options: .regularExpression) != nil { return AppConfig.webURL(t) }
            if let i = imageUrl, i.lowercased().hasPrefix("https://") { return URL(string: i) }
            return nil
        }
        var initial: String { String(source.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased() }
        var outlets: [Also] { (also ?? []).filter { $0.url.lowercased().hasPrefix("https://") } }
    }
    let stories: [Story]
    let nextCursor: String?
    let disclosure: String?
}

/// The News screen (public/news.html, js/news.js).
@MainActor
@Observable
final class NewsModel {
    enum Filter: String { case all, major }
    enum State: Equatable { case loading, ready, failed }

    var filter: Filter = .all
    var query = ""
    private(set) var state: State = .loading
    private(set) var stories: [NewsPage.Story] = []
    private(set) var top: [NewsPage.Story] = []
    private(set) var cursor: String?
    private(set) var loadingMore = false
    private(set) var disclosure: String?
    /// The stats bar, counted from the pages (each nil until known).
    private(set) var statStories: Int?
    private(set) var statMajorWeek: Int?
    private(set) var statSources: Int?
    private var generation = 0

    private func query(more: Bool) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: "20")]
        if filter == .major { items.append(URLQueryItem(name: "importance", value: "2")) }
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { items.append(URLQueryItem(name: "q", value: String(q.prefix(80)))) }
        if more, let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return items
    }

    /// The first page for the current filter and search (a newer request replaces an older one).
    func reload(api: APIClient) async {
        generation += 1
        let gen = generation
        state = .loading
        stories = []
        cursor = nil
        do {
            let page: NewsPage = try await api.get("/api/news", query: query(more: false))
            guard gen == generation else { return }
            stories = page.stories
            cursor = page.nextCursor
            disclosure = page.disclosure ?? disclosure
            state = .ready
        } catch is CancellationError {
        } catch {
            if gen == generation { state = .failed }
        }
    }

    func loadMore(api: APIClient) async {
        guard let _ = cursor, !loadingMore, state == .ready else { return }
        loadingMore = true
        defer { loadingMore = false }
        let gen = generation
        guard let page: NewsPage = try? await api.get("/api/news", query: query(more: true)), gen == generation else { return }
        stories += page.stories.filter { s in !stories.contains { $0.id == s.id } }
        cursor = page.nextCursor
    }

    /// "Top stories": the four newest Major stories.
    func loadTop(api: APIClient) async {
        if let page: NewsPage = try? await api.get("/api/news", query: [URLQueryItem(name: "importance", value: "2"), URLQueryItem(name: "limit", value: "6")]) {
            top = Array(page.stories.prefix(4))
        }
    }

    /// The stats bar (js/news.js loadStats): up to 12 pages of 50.
    func loadStats(api: APIClient, now: Date = .now) async {
        var cursor: String?, pages = 0, count = 0, major = 0
        var sources = Set<String>()
        let weekAgo = now.addingTimeInterval(-7 * 86400)
        repeat {
            var items = [URLQueryItem(name: "limit", value: "50")]
            if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
            guard let page: NewsPage = try? await api.get("/api/news", query: items) else { return }
            for s in page.stories {
                count += 1
                if s.isMajor, let d = Format.instant(s.publishedAt), d >= weekAgo { major += 1 }
                sources.insert(s.source.lowercased())
                for o in s.also ?? [] { sources.insert(o.source.lowercased()) }
            }
            cursor = page.nextCursor
            pages += 1
        } while cursor != nil && pages < 12
        statStories = count; statMajorWeek = major; statSources = sources.count
    }

    // MARK: Labels (Austin time)

    static let central = TimeZone(identifier: "America/Chicago")!
    static func dayLabel(_ iso: String, now: Date = .now) -> String {
        guard let d = Format.instant(iso) else { return "" }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = central
        if cal.isDate(d, inSameDayAs: now) { return "Today" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(d, inSameDayAs: y) { return "Yesterday" }
        return d.formatted(Date.FormatStyle(timeZone: central).weekday(.wide).month(.abbreviated).day())
    }
    static func ago(_ iso: String?, now: Date = .now) -> String {
        guard let d = Format.instant(iso) else { return "" }
        let m = Int((now.timeIntervalSince(d) / 60).rounded())
        if m < 1 { return "just now" }
        if m < 60 { return "\(m)m ago" }
        let h = Int((Double(m) / 60).rounded())
        if h < 24 { return "\(h)h ago" }
        return d.formatted(Date.FormatStyle(timeZone: central).month(.abbreviated).day().hour().minute()) + " CT"
    }
    static let typeLabel = ["official": "Official", "social": "Social", "press": "Press"]

    /// The feed in day groups, newest first.
    var days: [(label: String, stories: [NewsPage.Story])] {
        var out: [(String, [NewsPage.Story])] = []
        for s in stories {
            let d = Self.dayLabel(s.publishedAt)
            if out.last?.0 == d { out[out.count - 1].1.append(s) } else { out.append((d, [s])) }
        }
        return out
    }
}
