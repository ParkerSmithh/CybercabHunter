import SwiftUI

// Followers & Following (worker/follows.js; the website's js/follows.js): the
// follow button, the two counts, the lists and Follow Requests. Same accounts
// and same relationships as the website. The server enforces privacy; these
// screens only show what it sends.

enum FollowAPI {
    static func path(_ handle: String) -> String { "/api/follows/\(handle)" }
    static func message(_ error: Error) -> String {
        if case APIError.http(429, _) = error { return "You're doing that too often. Try again in a few minutes." }
        if case APIError.http(404, _) = error { return "That account is no longer available." }
        return "That didn't go through. Check your connection and try again."
    }
}

/// Follow / Following / Requested / Follow Back. Changes at once and goes back,
/// with a message, if the request fails; a tap while one is on its way does nothing.
struct FollowButton: View {
    let handle: String
    let isPrivate: Bool
    var small = false
    let state: FollowState
    var changed: (FollowStatus) -> Void = { _ in }
    @Environment(SessionStore.self) private var session
    @Environment(\.openSignIn) private var openSignIn
    @State private var shown: FollowState?
    @State private var busy = false
    @State private var confirming = false
    @State private var failure: String?

    private var current: FollowState { shown ?? state }

    var body: some View {
        Group {
            if current.isActive {
                Button(action: tapped) { label.foregroundStyle(Color.chInk) }
                    .buttonStyle(.bordered).tint(Color.chInk.opacity(0.5))
            } else {
                Button(current.title, action: tapped).buttonStyle(GoldButtonStyle(small: true))
            }
        }
        .controlSize(small ? .small : .regular)
        .disabled(busy)
        .accessibilityLabel(accessibility)
        .accessibilityIdentifier("followButton-\(handle)")
        .onChange(of: state) { shown = nil }
        .confirmationDialog("Unfollow @\(handle)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Unfollow", role: .destructive) { Task { await send(undo: true) } }
            Button("Keep following", role: .cancel) {}
        } message: {
            if isPrivate { Text("This account is private, so you'd need to be approved again.") }
        }
        .alert("Couldn't update", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
    }

    private var label: some View { Text(current.title).font(.inter(small ? 12.5 : 13.5, .semibold)) }

    private var accessibility: String {
        switch current {
        case .following: "Following @\(handle). Double tap to unfollow."
        case .requested: "Follow requested from @\(handle). Double tap to cancel the request."
        case .followBack: "Follow back @\(handle)"
        default: isPrivate ? "Request to follow @\(handle)" : "Follow @\(handle)"
        }
    }

    private func tapped() {
        if session.user == nil { openSignIn(); return }
        if current == .following { confirming = true; return }
        Task { await send(undo: current == .requested) }
    }

    private func send(undo: Bool) async {
        guard !busy else { return }
        let was = current
        busy = true
        shown = undo ? .follow : (isPrivate ? .requested : .following)
        defer { busy = false }
        do {
            let r: FollowStatus = try await session.api.send(FollowAPI.path(handle), method: undo ? "DELETE" : "PUT")
            shown = r.relationship
            changed(r)
        } catch APIError.unauthorized {
            shown = was
            openSignIn()
        } catch is CancellationError {
            shown = was
        } catch {
            shown = was
            failure = FollowAPI.message(error)
        }
    }
}

/// "12 Followers  3 Following", each opening its list.
struct FollowCounts: View {
    let handle: String
    let counts: FollowStatus.Counts

    var body: some View {
        HStack(spacing: 16) {
            link(.followers, value: counts.followers, label: counts.followers == 1 ? "Follower" : "Followers")
            link(.following, value: counts.following, label: "Following")
        }
    }

    private func link(_ kind: FollowListView.Kind, value: Int, label: String) -> some View {
        NavigationLink { FollowListView(handle: handle, kind: kind) } label: {
            (Text(Format.int(value)).font(.inter(14, .bold)).foregroundStyle(Color.chInk)
             + Text(" \(label)").font(.inter(14)).foregroundStyle(Color.chFog))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(Format.int(value)) \(label). Open the list.")
        .accessibilityIdentifier("followCount-\(kind.rawValue)")
    }
}

private struct FollowPersonRow: View {
    let name: String
    let handle: String?
    let avatarUrl: String?
    let rank: SpotterRank?

    private var row: some View {
        HStack(spacing: 10) {
            PersonAvatar(name: name, url: SocialAuthor.avatarURL(avatarUrl), size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.inter(14, .bold)).foregroundStyle(Color.chInk).lineLimit(1)
                let sub = [handle.map { "@\($0)" }, rank?.name].compactMap { $0 }.joined(separator: " · ")
                if !sub.isEmpty { Text(sub).font(.inter(12)).foregroundStyle(Color.chFog).lineLimit(1) }
            }
            Spacer(minLength: 0)
        }
    }

    var body: some View {
        if let handle {
            NavigationLink { RiderProfileView(route: RiderRoute(handle: handle)) } label: { row }.buttonStyle(.plain)
        } else {
            row
        }
    }
}

/// The accounts following someone, or the accounts they follow (paged).
struct FollowListView: View {
    enum Kind: String { case followers, following }
    let handle: String
    let kind: Kind
    @Environment(SessionStore.self) private var session
    @State private var people: [FollowPerson] = []
    @State private var cursor: String?
    @State private var hidden = 0
    @State private var phase: Phase = .loading
    @State private var loadingMore = false
    @State private var moreFailed = false
    @State private var removing: FollowPerson?
    @State private var failure: String?
    enum Phase { case loading, loaded, failed, isPrivate }

    var body: some View {
        List {
            switch phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            case .failed:
                Text("We couldn't load this list. Check your connection and pull to try again.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
            case .isPrivate:
                Text("This account is private.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
            case .loaded:
                if people.isEmpty && hidden == 0 {
                    Text(kind == .followers ? "No followers yet." : "Not following anyone yet.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                        .accessibilityIdentifier("followListEmpty")
                }
                ForEach(people) { p in
                    HStack(spacing: 8) {
                        FollowPersonRow(name: p.name, handle: p.handle, avatarUrl: p.avatarUrl, rank: p.rank)
                        if p.followId != nil {
                            Button("Remove") { removing = p }.buttonStyle(.bordered).controlSize(.small).tint(Color.chInk.opacity(0.5))
                                .accessibilityLabel("Remove \(p.name) as a follower")
                        } else if let h = p.handle, let state = p.relationship, state != .isSelf, state != .signedOut {
                            FollowButton(handle: h, isPrivate: false, small: true, state: state)
                        }
                    }
                    .listRowBackground(Color.chSurface)
                    .onAppear { if p.id == people.last?.id { Task { await load(more: true) } } }
                    .accessibilityIdentifier("followRow")
                }
                if loadingMore { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
                if moreFailed {
                    Button("Couldn't load more. Tap to try again.") { Task { await load(more: true) } }.font(.inter(13)).listRowBackground(Color.clear)
                }
                if hidden > 0 {
                    Text("\(Format.plural(hidden, "private account", "private accounts")) not shown.").font(.inter(12.5)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                }
            }
        }
        .font(.inter(15))
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle(kind == .followers ? "Followers" : "Following")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load(more: false) }
        .refreshable { await load(more: false) }
        .confirmationDialog("Remove \(removing?.name ?? "this follower") as a follower?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) { if let p = removing { Task { await remove(p) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("They won't be told. If your account is private, they lose access right away.") }
        .alert("Couldn't update", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
    }

    private func load(more: Bool) async {
        if more {
            guard cursor != nil, !loadingMore else { return }
            loadingMore = true
        }
        defer { loadingMore = false }
        var query: [URLQueryItem] = []
        if more, let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        do {
            let page: FollowListPage = try await session.api.get("\(FollowAPI.path(handle))/\(kind.rawValue)", query: query, authenticated: true, fresh: true)
            if more {
                people += page.users.filter { p in !people.contains { $0.id == p.id } }
            } else {
                people = page.users
                hidden = page.hiddenCount ?? 0
            }
            cursor = page.nextCursor
            moreFailed = false
            phase = .loaded
        } catch is CancellationError {
        } catch APIError.http(403, _) {
            phase = .isPrivate
        } catch {
            if more { moreFailed = true } else if people.isEmpty { phase = .failed }
        }
    }

    private func remove(_ p: FollowPerson) async {
        guard let id = p.followId else { return }
        do {
            let _: FollowOK = try await session.api.send("/api/followers/\(id)", method: "DELETE")
            people.removeAll { $0.id == p.id }
        } catch {
            failure = FollowAPI.message(error)
        }
    }
}

/// Account › Follow Requests: who asked to follow you, plus your own lists.
struct FollowRequestsView: View {
    var handle: String?
    @Environment(SessionStore.self) private var session
    @State private var requests: [FollowRequestsPage.Request] = []
    @State private var cursor: String?
    @State private var phase: Phase = .loading
    @State private var working: Set<String> = []
    @State private var failure: String?
    @State private var counts: FollowStatus.Counts?
    enum Phase { case loading, loaded, failed }

    var body: some View {
        List {
            if let handle, let counts {
                Section("Your lists") { FollowCounts(handle: handle, counts: counts) }.listRowBackground(Color.chSurface)
            }
            Section {
                switch phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                case .failed:
                    Text("We couldn't load your requests. Check your connection and pull to try again.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                case .loaded:
                    if requests.isEmpty {
                        Text("No requests right now.").font(.inter(13)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                            .accessibilityIdentifier("followRequestsEmpty")
                    }
                    ForEach(requests) { r in
                        HStack(spacing: 6) {
                            FollowPersonRow(name: r.user.name, handle: r.user.handle, avatarUrl: r.user.avatarUrl, rank: r.user.rank)
                            Button("Accept") { Task { await resolve(r, accept: true) } }
                                .buttonStyle(GoldButtonStyle(small: true))
                                .accessibilityLabel("Accept \(r.user.name)").accessibilityIdentifier("acceptRequest")
                            Button("Decline") { Task { await resolve(r, accept: false) } }
                                .buttonStyle(.bordered).controlSize(.small).tint(Color.chInk.opacity(0.5))
                                .accessibilityLabel("Decline \(r.user.name)").accessibilityIdentifier("declineRequest")
                        }
                        .disabled(working.contains(r.id))
                        .listRowBackground(Color.chSurface)
                        .onAppear { if r.id == requests.last?.id { Task { await load(more: true) } } }
                    }
                }
            } header: { Text("Follow Requests") } footer: {
                Text("People asking to follow you while your profile is private. Nobody sees your private profile until you accept.")
            }
        }
        .font(.inter(15))
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle("Followers")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .alert("Couldn't update", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
    }

    private func reload() async {
        async let a: Void = load(more: false)
        async let b: Void = loadCounts()
        _ = await (a, b)
    }

    private func loadCounts() async {
        guard let handle else { return }
        if let s: FollowStatus = try? await session.api.get(FollowAPI.path(handle), authenticated: true, fresh: true) { counts = s.counts }
    }

    private func load(more: Bool) async {
        if more && cursor == nil { return }
        var query: [URLQueryItem] = []
        if more, let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        do {
            let page: FollowRequestsPage = try await session.api.get("/api/follow-requests", query: query, authenticated: true, fresh: true)
            requests = more ? requests + page.requests.filter { p in !requests.contains { $0.id == p.id } } : page.requests
            cursor = page.nextCursor
            phase = .loaded
        } catch is CancellationError {
        } catch {
            if !more && requests.isEmpty { phase = .failed }
        }
    }

    private func resolve(_ r: FollowRequestsPage.Request, accept: Bool) async {
        working.insert(r.id)
        defer { working.remove(r.id) }
        do {
            let _: FollowOK = try await session.api.send("/api/follow-requests/\(r.id)/\(accept ? "accept" : "decline")", method: "POST")
            requests.removeAll { $0.id == r.id }
            if accept { await loadCounts() }
        } catch {
            failure = FollowAPI.message(error)
        }
    }
}
