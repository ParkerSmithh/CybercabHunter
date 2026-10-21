import Foundation
import Observation

/// Community Social: the feed, its filters and sort, the sidebar, and every
/// action on a post (public/js/social.js). Posts are held once, by id, so a
/// like in a post's own screen shows in the feed too, and an action changes
/// that one post rather than reloading the feed. Likes and saves update at
/// once and roll back if the server refuses. The server decides everything:
/// who may edit, delete, pin or remove, and every count.
@MainActor
@Observable
final class SocialFeedModel {
    enum Filter: String, CaseIterable, Identifiable, Sendable {
        case foryou, latest, photos, reviews, saved
        var id: String { rawValue }
        var title: String {
            switch self {
            case .foryou: "For You"
            case .latest: "Latest"
            case .photos: "Photos"
            case .reviews: "Reviews"
            case .saved: "Saved"
            }
        }
        /// Photos, Reviews and Saved take Newest / Most popular; the others are orders in themselves.
        var sortable: Bool { self == .photos || self == .reviews || self == .saved }
        var note: String? {
            switch self {
            case .foryou: "Ranked by recent likes and comments"
            case .latest: "Newest posts first"
            default: nil
            }
        }
    }

    enum Sort: String, CaseIterable, Identifiable, Sendable {
        case new, popular
        var id: String { rawValue }
        var title: String { self == .new ? "Newest" : "Most popular" }
    }

    enum Phase: Equatable { case idle, loading, loaded, failed, signInRequired }

    static let pageSize = 10
    private static let sortKey = "cchSocialSort"

    var api: APIClient
    private(set) var filter: Filter = .foryou
    /// Remembered on this device (a convenience, like the website's localStorage).
    private(set) var sort: Sort = Sort(rawValue: UserDefaults.standard.string(forKey: SocialFeedModel.sortKey) ?? "") ?? .new
    private(set) var phase: Phase = .idle
    private(set) var feedIDs: [String] = []
    private(set) var posts: [String: SocialPost] = [:]
    private(set) var nextCursor: String?
    private(set) var loadingMore = false
    private(set) var moreFailed = false
    private(set) var viewer = SocialViewer(signedIn: false, moderator: false)
    private(set) var sidebar: SocialSidebar?
    private(set) var sidebarFailed = false
    private(set) var topContributors: [Leaderboard.Entry]?
    private(set) var topFailed = false
    /// Posts with a like / save request in flight (a second tap waits).
    private(set) var busy: Set<String> = []
    var toast: Toast?

    struct Toast: Equatable, Identifiable { let id = UUID(); let text: String; var isError = false }

    private var feedToken = 0
    private var started = false

    init(api: APIClient) { self.api = api }

    var feed: [SocialPost] { feedIDs.compactMap { posts[$0] } }

    // MARK: Loading

    func start(signedIn: Bool) async {
        guard !started else { return }
        started = true
        viewer = SocialViewer(signedIn: signedIn, moderator: false)
        async let f: Void = reload()
        async let s: Void = loadSidebar()
        async let t: Void = loadTop()
        _ = await (f, s, t)
    }

    func refreshAll() async {
        async let f: Void = reload()
        async let s: Void = loadSidebar()
        async let t: Void = loadTop()
        _ = await (f, s, t)
    }

    func select(_ next: Filter) async {
        guard next != filter else { return }
        filter = next
        await reload()
    }

    func select(_ next: Sort) async {
        guard next != sort else { return }
        sort = next
        UserDefaults.standard.set(next.rawValue, forKey: Self.sortKey)
        await reload()
    }

    /// Page 1 of the current filter (a newer request supersedes an older one).
    func reload() async {
        feedToken += 1
        let token = feedToken
        phase = .loading
        moreFailed = false
        do {
            let page = try await fetch(cursor: nil)
            guard token == feedToken else { return }
            feedIDs = []
            absorb(page)
            phase = .loaded
        } catch is CancellationError {
            if token == feedToken, phase == .loading { phase = feedIDs.isEmpty ? .idle : .loaded }
        } catch APIError.unauthorized where filter == .saved {
            guard token == feedToken else { return }
            feedIDs = []; nextCursor = nil; phase = .signInRequired
        } catch {
            guard token == feedToken else { return }
            feedIDs = []; nextCursor = nil; phase = .failed
        }
    }

    /// The next page (called as the last post comes into view).
    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore, phase == .loaded else { return }
        let token = feedToken
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await fetch(cursor: cursor)
            guard token == feedToken else { return }
            absorb(page)
            moreFailed = false
        } catch is CancellationError {
        } catch {
            moreFailed = true
        }
    }

    private func fetch(cursor: String?) async throws -> SocialFeedPage {
        var query = [URLQueryItem(name: "filter", value: filter.rawValue), URLQueryItem(name: "limit", value: String(Self.pageSize))]
        if filter.sortable { query.append(URLQueryItem(name: "sort", value: sort.rawValue)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await api.get("/api/social/feed", query: query, authenticated: true)
    }

    private func absorb(_ page: SocialFeedPage) {
        viewer = page.viewer
        for p in page.posts {
            posts[p.id] = p
            if !feedIDs.contains(p.id) { feedIDs.append(p.id) }
        }
        nextCursor = page.nextCursor
    }

    func loadSidebar() async {
        do { sidebar = try await api.get("/api/social/sidebar"); sidebarFailed = false } catch is CancellationError {} catch { sidebarFailed = sidebar == nil }
    }

    /// Top contributors: the top five of the Top Overall board (social.js loadTop).
    func loadTop() async {
        do {
            let board: Leaderboard = try await api.get("/api/community/leaderboard")
            topContributors = Array(board.entries.prefix(5)); topFailed = false
        } catch is CancellationError {} catch { topFailed = topContributors == nil }
    }

    /// One post (its own screen, a notification, a link). Nil when it isn't available.
    func loadPost(_ id: String) async throws -> SocialPost {
        let r: SocialPostResponse = try await api.get("/api/social/posts/\(id)", authenticated: true)
        posts[r.post.id] = r.post
        if let v = r.viewer { viewer = v }
        return r.post
    }

    func signedOut() {
        viewer = SocialViewer(signedIn: false, moderator: false)
        for (id, p) in posts { var p = p; p.liked = false; p.saved = false; posts[id] = p }
    }

    // MARK: Actions (each changes one post)

    func toggleLike(_ id: String) async {
        guard var post = posts[id], !busy.contains(id) else { return }
        let was = (post.liked, post.likeCount)
        post.liked.toggle()
        post.likeCount = max(0, post.likeCount + (post.liked ? 1 : -1))
        posts[id] = post
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let r: SocialLikeResult = try await api.send("/api/social/posts/\(id)/like", method: post.liked ? "PUT" : "DELETE")
            update(id) { $0.liked = r.liked; $0.likeCount = r.likeCount }
        } catch {
            update(id) { $0.liked = was.0; $0.likeCount = was.1 }
            fail(error)
        }
    }

    func toggleSave(_ id: String) async {
        guard var post = posts[id], !busy.contains(id) else { return }
        let want = !post.saved
        post.saved = want
        posts[id] = post
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let _: SocialOK = try await api.send("/api/social/posts/\(id)/save", method: want ? "PUT" : "DELETE")
            show(want ? "Saved. Find it under Saved." : "Removed from saved.")
            if !want, filter == .saved { feedIDs.removeAll { $0 == id } }
        } catch {
            update(id) { $0.saved = !want }
            fail(error)
        }
    }

    func setPinned(_ id: String, _ on: Bool) async {
        do {
            let _: SocialOK = try await api.send("/api/social/posts/\(id)/pin", method: on ? "PUT" : "DELETE")
            show(on ? "Pinned to the top of Social." : "Unpinned.")
            update(id) { $0.pinned = on }
            if filter == .foryou || filter == .latest { await reload() }
        } catch { fail(error) }
    }

    /// The author's delete (everything goes), or a moderator's removal (hidden, logged).
    func delete(_ id: String, asModerator: Bool, reason: String? = nil) async -> Bool {
        do {
            let body = asModerator ? JSONBody.make(reason.map { ["reason": $0] } ?? [:]) : nil
            let _: SocialOK = try await api.send("/api/social/posts/\(id)", method: "DELETE", body: body)
            show(asModerator ? "Post removed." : "Post deleted.")
            feedIDs.removeAll { $0 == id }
            posts[id] = nil
            Task { await loadSidebar() }
            return true
        } catch { fail(error); return false }
    }

    func report(_ type: String, id: String, reason: ReportReason, details: String) async -> String? {
        var body: [String: Any] = ["target_type": type, "target_id": id, "reason": reason.rawValue]
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["details"] = trimmed }
        do {
            let _: SocialOK = try await api.send("/api/social/reports", method: "POST", body: JSONBody.make(body))
            show("Thanks. Moderators will review it.")
            return nil
        } catch { return SocialText.message(for: error) }
    }

    /// A new post from the composer: shown at the top where it belongs (social.js).
    func published(_ post: SocialPost) {
        posts[post.id] = post
        let fits = filter == .latest || filter == .foryou || (filter == .photos && !post.photos.isEmpty) || (filter == .reviews && post.review != nil)
        if fits, !feedIDs.contains(post.id) {
            let pins = feedIDs.prefix { posts[$0]?.pinned == true }.count
            feedIDs.insert(post.id, at: pins)
            if phase != .loaded { phase = .loaded }
        }
        show("Posted.")
        Task { await loadSidebar() }
    }

    func edited(_ post: SocialPost) {
        posts[post.id] = post
        show("Post updated.")
    }

    func setCommentCount(_ id: String, _ n: Int) { update(id) { $0.commentCount = n } }

    func update(_ id: String, _ change: (inout SocialPost) -> Void) {
        guard var p = posts[id] else { return }
        change(&p)
        posts[id] = p
    }

    func show(_ text: String) { toast = Toast(text: text) }
    func fail(_ error: Error) {
        if error is CancellationError { return }
        toast = Toast(text: SocialText.message(for: error), isError: true)
    }
}
