import SwiftUI
import Observation

/// The rider's Social notifications (worker/social.js): likes, comments,
/// replies, @mentions and the moderators' announcement. In-app only: the
/// website has no push notifications (that needs APNs, see PLAN.md).
@MainActor
@Observable
final class NotificationsModel {
    private(set) var unread = 0
    private(set) var items: [SocialNotifications.Item]?
    private(set) var failed = false

    func reset() { unread = 0; items = nil }

    func refreshCount(api: APIClient) async {
        if let r: SocialUnread = try? await api.get("/api/social/notifications", query: [URLQueryItem(name: "count_only", value: "1")], authenticated: true) {
            unread = r.unread
        }
    }

    func load(api: APIClient) async {
        do {
            let r: SocialNotifications = try await api.get("/api/social/notifications", authenticated: true)
            items = r.notifications
            unread = r.unread
            failed = false
        } catch is CancellationError {
        } catch { failed = items == nil }
    }

    func markAllRead(api: APIClient) async {
        let _: SocialOK? = try? await api.send("/api/social/notifications/read", method: "POST", body: JSONBody.make(["all": true]))
        await load(api: api)
    }

    func markRead(_ item: SocialNotifications.Item, api: APIClient) async {
        guard !item.read, let i = items?.firstIndex(where: { $0.id == item.id }) else { return }
        items?[i].read = true
        unread = max(0, unread - 1)
        let _: SocialOK? = try? await api.send("/api/social/notifications/read", method: "POST", body: JSONBody.make(["ids": [item.id]]))
    }
}

struct NotificationsView: View {
    let model: NotificationsModel
    let open: (CommunityLink) -> Void
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                if let items = model.items {
                    if items.isEmpty {
                        Text("No notifications yet. Likes, comments, replies and @mentions on your posts show up here.")
                            .font(.inter(13)).foregroundStyle(Color.chFog)
                            .listRowBackground(Color.clear)
                    }
                    ForEach(items) { item in
                        Button { tap(item) } label: { row(item) }
                            .listRowBackground(item.read ? Color.chSurface2 : Color.brandGold.opacity(0.06))
                            .accessibilityIdentifier("notification-\(item.type)")
                    }
                } else if model.failed {
                    Text("Notifications could not be loaded.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                } else {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.chSurface2)
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if model.unread > 0 {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Mark all read") { Task { await model.markAllRead(api: session.api) } }
                            .accessibilityIdentifier("markAllRead")
                    }
                }
            }
            .task { await model.load(api: session.api) }
            .refreshable { await model.load(api: session.api) }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ n: SocialNotifications.Item) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                switch n.type {
                case "like": Image(systemName: "heart.fill")
                case "mention": Text("@").font(.inter(15, .heavy))
                case "announcement": Image(systemName: "pin.fill")
                default: Image(systemName: "bubble.left.fill")
                }
            }
            .font(.system(size: 13))
            .foregroundStyle(Color.brandGold)
            .frame(width: 30, height: 30)
            .background(Color.chInk.opacity(0.06), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                (Text(n.actor?.official == true ? "Cybercab Hunter" : n.actor?.name ?? "Someone").bold().foregroundStyle(Color.chInk)
                    + Text(" \(n.text)").foregroundStyle(Color.chMist))
                    .font(.inter(13.5))
                if let excerpt = n.excerpt, !excerpt.isEmpty {
                    Text(excerpt).font(.inter(12.5)).foregroundStyle(Color.chCaption).lineLimit(1)
                }
                Text(SocialText.relative(n.createdAt)).font(.inter(11.5)).foregroundStyle(Color.chCaption)
            }
            Spacer(minLength: 0)
            if !n.read { Circle().fill(Color.brandGold).frame(width: 8, height: 8).padding(.top, 6).accessibilityLabel("Unread") }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func tap(_ item: SocialNotifications.Item) {
        Task { await model.markRead(item, api: session.api) }
        if let target = item.target { open(.post(target)); return }
        // The announcement: its own link (a site page opens natively), else Community.
        let url = AppConfig.webURL(item.url)
        if let link = CommunityLink(url: url) { open(link) } else { dismiss(); openURL(url) }
    }
}

/// Find riders (GET /api/rider-search): only riders with a public profile.
struct RiderSearchView: View {
    let open: (String) -> Void
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [RiderSearch.Result]?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            List {
                if failed {
                    Text("Search is unavailable right now. Try again in a moment.").foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                } else if let results {
                    if results.isEmpty && !query.isEmpty {
                        Text("No public profiles match “\(query)”.").foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                    }
                    ForEach(results) { r in
                        Button { open(r.handle) } label: {
                            HStack(spacing: 10) {
                                PersonAvatar(name: r.name, url: SocialAuthor.avatarURL(r.avatarUrl), size: 34)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(r.name).font(.inter(14, .bold)).foregroundStyle(Color.chInk)
                                    Text("@\(r.handle)").font(.inter(12.5)).foregroundStyle(Color.brandGold)
                                }
                            }
                        }
                        .listRowBackground(Color.chSurface)
                        .accessibilityIdentifier("riderResult")
                    }
                } else {
                    Text("Only riders with a public profile are listed.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                }
            }
            .font(.inter(15))
            .scrollContentBackground(.hidden)
            .background(Color.chSurface2)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find riders by name")
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .navigationTitle("Find riders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task(id: query) { await search() }
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { results = nil; return }
        do {
            try await Task.sleep(for: .milliseconds(200))
            let r: RiderSearch = try await session.api.get("/api/rider-search", query: [URLQueryItem(name: "q", value: String(q.prefix(40)))], authenticated: true)
            results = r.results
            failed = false
        } catch is CancellationError {
        } catch { failed = true }
    }
}
