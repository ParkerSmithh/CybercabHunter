import Foundation
import Observation

/// Moderation → News (the website's js/moderation-news.js; worker/news.js):
/// every collected story, hidden ones too, with Hide / Unhide and Feature /
/// Unfeature; the allow, block, publisher, Major-keyword and thumbnail lists;
/// "Run the next ingest step now". The server is moderator-gated.
@MainActor
@Observable
final class NewsModerationModel {
    enum State: Equatable { case idle, loading, ready, failed(String) }

    private(set) var state: State = .idle
    private(set) var stories: [NewsModeration.Story] = []
    private(set) var nextCursor: String?
    private(set) var runLine = ""
    private(set) var blockedCount = ""
    private(set) var loadingMore = false
    private(set) var running = false
    private(set) var saving = false
    /// Stories with a Hide / Feature request in flight.
    private(set) var busy: Set<String> = []
    private(set) var accessLost: ModerationModel.Access?

    // The lists being edited (saved together with "Save lists").
    var allow = ""
    var block = ""
    private(set) var publishers: [String] = []
    var publisherInput = ""
    var majorKeywords = ""
    var thumbBlocklist = ""
    var configNote = ""

    func load(api: APIClient) async {
        if state != .ready { state = .loading }
        do {
            let d: NewsModeration = try await api.get("/api/moderation/news", query: [URLQueryItem(name: "limit", value: "50")], authenticated: true, fresh: true)
            stories = d.stories
            nextCursor = d.nextCursor
            runLine = Self.runLine(d.lastRun, prune: d.lastPrune)
            if let n = d.lastRun?.blockedPublisher { blockedCount = "Last run: \(Format.plural(n, "story", "stories")) blocked by publisher." } else { blockedCount = "" }
            apply(d.config)
            state = .ready
        } catch is CancellationError {
        } catch APIError.unauthorized { accessLost = .signedOut
        } catch APIError.http(403, _) { accessLost = .forbidden
        } catch { state = .failed("Couldn't load the news.") }
    }

    func loadMore(api: APIClient) async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let d: NewsModeration = try? await api.get("/api/moderation/news", query: [URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "cursor", value: cursor)], authenticated: true, fresh: true) {
            stories += d.stories.filter { s in !stories.contains { $0.id == s.id } }
            nextCursor = d.nextCursor
        }
    }

    private func apply(_ c: NewsModeration.Config) {
        allow = c.allow
        block = c.block
        publishers = c.publisherBlocklist
        thumbBlocklist = (c.thumbBlocklist ?? []).joined(separator: "\n")
        majorKeywords = (c.majorKeywords ?? []).joined(separator: "\n")
    }

    /// hide | unhide | feature | unfeature; the list reloads after (the site's behavior).
    func act(_ story: NewsModeration.Story, _ action: String, api: APIClient) async {
        guard !busy.contains(story.id) else { return }
        busy.insert(story.id)
        defer { busy.remove(story.id) }
        do {
            let _: SocialOK = try await api.send("/api/moderation/news/\(story.id)", method: "POST", body: JSONBody.make(["action": action]))
            await reloadFirstPage(api: api)
        } catch APIError.unauthorized { accessLost = .signedOut
        } catch APIError.http(403, _) { accessLost = .forbidden
        } catch {}
    }

    /// Reloads the first page but keeps the lists being edited.
    private func reloadFirstPage(api: APIClient) async {
        guard let d: NewsModeration = try? await api.get("/api/moderation/news", query: [URLQueryItem(name: "limit", value: "50")], authenticated: true, fresh: true) else { return }
        stories = d.stories
        nextCursor = d.nextCursor
        runLine = Self.runLine(d.lastRun, prune: d.lastPrune)
    }

    func runNow(api: APIClient) async {
        guard !running else { return }
        running = true
        defer { running = false }
        let _: SocialOK? = try? await api.send("/api/moderation/news/run", method: "POST")
        await reloadFirstPage(api: api)
    }

    // MARK: Lists

    func addPublisher() {
        let v = publisherInput.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        guard !v.isEmpty else { return }
        if !publishers.contains(where: { $0.lowercased() == v.lowercased() }) { publishers.append(String(v.prefix(80))) }
        publisherInput = ""
        configNote = "Not saved yet."
    }

    func removePublisher(_ name: String) {
        publishers.removeAll { $0 == name }
        configNote = "Not saved yet."
    }

    static func lines(_ text: String) -> [String] {
        text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    func save(api: APIClient) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        let body: [String: Any] = ["allow": allow, "block": block, "publisher_blocklist": publishers,
                                   "thumb_blocklist": Self.lines(thumbBlocklist), "major_keywords": Self.lines(majorKeywords)]
        do {
            let r: NewsConfigSaved = try await api.send("/api/moderation/news-config", method: "PUT", body: JSONBody.make(body))
            publishers = r.config.publisherBlocklist
            thumbBlocklist = (r.config.thumbBlocklist ?? []).joined(separator: "\n")
            majorKeywords = (r.config.majorKeywords ?? []).joined(separator: "\n")
            configNote = "Saved. The next run uses these lists."
        } catch APIError.http(400, "empty_allowlist"?) {
            configNote = "The allowlist needs at least one rule."
        } catch APIError.unauthorized { accessLost = .signedOut
        } catch APIError.http(403, _) { accessLost = .forbidden
        } catch { configNote = "Couldn't save." }
    }

    // MARK: Labels

    /// "Jan 5, 3:04 PM CT", as the site shows times here.
    static func when(_ iso: String?) -> String {
        guard let d = Format.instant(iso) else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "MMM d, h:mm a"
        return f.string(from: d) + " CT"
    }

    /// The website's run summary line (moderation-news.js load()).
    static func runLine(_ lr: NewsModeration.Run?, prune: NewsModeration.Prune?) -> String {
        guard let lr else { return "The ingest has not run yet." }
        var s = "Last step \(when(lr.at))"
        if let feeds = lr.feeds, feeds.count == 1 { s += " (\(feeds[0]))" }
        s += ": \(lr.fetched ?? 0) fetched, \(lr.kept ?? 0) kept, \(lr.dropped ?? 0) dropped"
        if let b = lr.blockedPublisher { s += " (\(b) by publisher)" }
        s += ", \(lr.new ?? 0) new"
        if (lr.notModified ?? 0) > 0 { s += ", feed unchanged" }
        if let e = lr.errors, !e.isEmpty { s += " · \(e.count) feed errors" }
        if let ai = lr.ai { s += ". AI check: \(ai.checked ?? 0) asked, \(ai.promoted ?? 0) promoted" + ((ai.failed ?? 0) > 0 ? ", \(ai.failed ?? 0) failed" : "") }
        if let r = lr.rescored { s += ". Rescored: \(r) changed" }
        if let th = lr.thumbs { s += ". Thumbnails: \(th.done ?? 0) made, \(th.failed ?? 0) failed, \(th.skipped ?? 0) skipped" + (th.unavailable == true ? " (storage not bound)" : "") }
        if let p = prune, let day = p.day { s += ". Last prune \(day): \(p.storiesPruned ?? 0) stories, \(p.thumbsDeleted ?? 0) thumbnails deleted" }
        return s + "."
    }
}
