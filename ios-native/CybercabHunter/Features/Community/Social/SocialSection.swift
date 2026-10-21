import SwiftUI

/// The Social section (the Community page's default): the composer, the feed
/// filters and sort, the posts, and the sidebar cards, which sit under the
/// feed on phones as on the website.
struct SocialSection: View {
    let social: SocialFeedModel
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.openSignIn) private var openSignIn
    @State private var composing = false

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12, pinnedViews: []) {
            composerEntry
            filters
            feedbar
            feed
            sidebar.padding(.top, 8)
        }
        .sheet(isPresented: $composing) { ComposerView(social: social) }
    }

    // MARK: Composer entry

    @ViewBuilder private var composerEntry: some View {
        if let user = session.user {
            Button { composing = true } label: {
                HStack(spacing: 10) {
                    AvatarView(user: user, size: 34)
                    Text("What's happening in the Cybercab world?").font(.inter(15)).foregroundStyle(Color.chCaption)
                    Spacer()
                    Image(systemName: "square.and.pencil").foregroundStyle(Color.brandGold)
                }
                .padding(12)
                .background(Color.chSurface, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chInk.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Write a post")
            .accessibilityIdentifier("composeButton")
        } else {
            HStack(spacing: 10) {
                Button("Sign in") { openSignIn() }.buttonStyle(GoldButtonStyle(small: true)).accessibilityIdentifier("socialSignIn")
                Text("to post, like, comment and report. Anyone can read.").font(.inter(13)).foregroundStyle(Color.chMist)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.chSurface, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chInk.opacity(0.08)))
        }
    }

    // MARK: Filters (For You … Saved) and sort

    private var filters: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(SocialFeedModel.Filter.allCases) { f in
                        let on = f == social.filter
                        Button { Task { await social.select(f) } } label: {
                            Text(f.title)
                                .font(.inter(13.5, .semibold))
                                .foregroundStyle(on ? Color.chInk : Color.chFog)
                                .padding(.horizontal, 11).frame(minHeight: 44)
                                .overlay(alignment: .bottom) {
                                    Capsule().fill(on ? Color.brandGold : .clear).frame(height: 3).padding(.horizontal, 10)
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                        .accessibilityIdentifier("filter-\(f.rawValue)")
                    }
                }
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
        }
        .sensoryFeedback(.selection, trigger: social.filter)
    }

    @ViewBuilder private var feedbar: some View {
        HStack {
            if social.filter.sortable && !(social.filter == .saved && !social.viewer.signedIn) {
                Text("Sort").font(.inter(12.5)).foregroundStyle(Color.chCaption)
                Menu {
                    Picker("Sort", selection: Binding(get: { social.sort }, set: { s in Task { await social.select(s) } })) {
                        ForEach(SocialFeedModel.Sort.allCases) { Text($0.title).tag($0) }
                    }
                } label: {
                    HStack(spacing: 5) { Text(social.sort.title); Image(systemName: "chevron.up.chevron.down").font(.system(size: 10)) }
                        .font(.inter(12.5, .semibold)).foregroundStyle(Color.chMist)
                        .padding(.horizontal, 10).frame(minHeight: 32)
                        .overlay(Capsule().strokeBorder(Color.chHair2))
                }
                .accessibilityIdentifier("sortMenu")
            } else if let note = social.filter.note {
                Text(note).font(.inter(12.5)).foregroundStyle(Color.chCaption)
            }
            Spacer()
        }
        .frame(minHeight: 32)
    }

    // MARK: Feed

    @ViewBuilder private var feed: some View {
        let firstLoad = social.phase == .idle || (social.phase == .loading && social.feedIDs.isEmpty)
        switch social.phase {
        case _ where firstLoad:
            ForEach(0..<2, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 12).fill(Color.chSurface).frame(height: 140)
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chInk.opacity(0.06)))
                    .accessibilityLabel("Loading posts")
            }
        case .failed:
            EmptyStateCard(title: "We couldn't load posts", text: "Please try again in a moment.").accessibilityIdentifier("feedError")
        case .signInRequired:
            VStack(spacing: 12) {
                EmptyStateCard(title: "Saved posts", text: "Sign in to save posts and see them here.")
                Button("Sign in") { openSignIn() }.buttonStyle(GoldButtonStyle())
            }
            .accessibilityIdentifier("savedSignIn")
        default:
            if social.feed.isEmpty {
                EmptyStateCard(title: social.filter == .saved ? "Saved posts" : "Nothing here yet", text: SocialText.emptyFeed[social.filter] ?? "")
                    .accessibilityIdentifier("feedEmpty")
            }
            ForEach(social.feed) { post in
                PostCard(post: post, social: social)
                    .onAppear { if post.id == social.feedIDs.last { Task { await social.loadMore() } } }
            }
            .opacity(social.phase == .loading ? 0.5 : 1)
            if social.loadingMore {
                ProgressView().tint(Color.chFog).frame(maxWidth: .infinity).padding(8)
            } else if social.nextCursor != nil {
                Button(social.moreFailed ? "More posts could not be loaded. Try again" : "Load more posts") { Task { await social.loadMore() } }
                    .font(.inter(14, .semibold)).foregroundStyle(Color.chMist)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
                    .accessibilityIdentifier("loadMorePosts")
            }
        }
    }

    // MARK: Sidebar (announcement, trending, top contributors, rules)

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let ann = social.sidebar?.announcement {
                VStack(alignment: .leading, spacing: 6) {
                    Text("ANNOUNCEMENT").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.brandGold)
                    LinkedText(text: ann.body, size: 13.5)
                    if let link = ann.linkUrl.flatMap(URL.init(string:)) { Link("Read more", destination: link).font(.inter(13, .semibold)) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    RoundedRectangle(cornerRadius: 14).fill(Color.chSurface)
                        .overlay(RoundedRectangle(cornerRadius: 14).fill(LinearGradient(colors: [Color.brandGold.opacity(0.1), .clear], startPoint: .leading, endPoint: UnitPoint(x: 0.7, y: 0.5))))
                }
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.brandGold.opacity(0.35)))
                .accessibilityIdentifier("announcement")
            }
            card("Trending this week") {
                if let trending = social.sidebar?.trending {
                    if trending.isEmpty {
                        muted("Nothing trending yet this week. Likes and comments put posts here.")
                    }
                    ForEach(trending) { t in
                        Button { router.communityPath.append(PostRoute(id: t.id)) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                CategoryChip(category: t.category)
                                Text(t.excerpt.isEmpty ? "Photo post" : (t.excerpt.count >= 120 ? t.excerpt + "…" : t.excerpt))
                                    .font(.inter(13.5)).foregroundStyle(Color(hex: 0xD8DDE5)).lineLimit(2).multilineTextAlignment(.leading)
                                Text("\(Format.plural(t.likeCount, "like", "likes")) · \(Format.plural(t.commentCount, "comment", "comments"))")
                                    .font(.inter(11.5)).foregroundStyle(Color.chCaption)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } else if social.sidebarFailed {
                    muted("Trending posts could not be loaded.")
                } else { ProgressView().tint(Color.chFog) }
            }
            .accessibilityIdentifier("trending")
            card("Top contributors") {
                if let top = social.topContributors {
                    if top.isEmpty { muted("No ranked spotters yet.") }
                    ForEach(Array(top.enumerated()), id: \.element.id) { i, e in
                        TopContributorRow(n: i + 1, entry: e)
                    }
                    Button("Full leaderboard") { router.communitySection = .leaderboard }
                        .font(.inter(13, .semibold)).padding(.top, 4)
                        .accessibilityIdentifier("fullLeaderboard")
                } else if social.topFailed {
                    muted("Could not be loaded.")
                } else { ProgressView().tint(Color.chFog) }
            }
            .accessibilityIdentifier("topContributors")
            RulesCard()
        }
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased()).font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chInk.opacity(0.08)))
    }

    private func muted(_ s: String) -> some View { Text(s).font(.inter(13)).foregroundStyle(Color.chFog) }
}

/// A Top contributors row: number, avatar, name (→ profile), rank and level, points.
struct TopContributorRow: View {
    let n: Int
    let entry: Leaderboard.Entry
    @Environment(AppRouter.self) private var router
    var body: some View {
        Button { if let h = entry.handle { router.communityPath.append(RiderRoute(handle: h)) } } label: {
            HStack(spacing: 10) {
                Text("\(n)").font(.inter(12, .bold)).foregroundStyle(Color.chCaption).frame(width: 16)
                PersonAvatar(name: entry.name, url: SocialAuthor.avatarURL(entry.avatarUrl), size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.name).font(.inter(13.5, .bold)).foregroundStyle(Color.chInk).lineLimit(1)
                    if let rank = entry.spotterRank {
                        (Text(rank).foregroundStyle(RankColor.color(entry.spotterRankKey)).bold() + Text(entry.level.map { " · Level \($0)" } ?? "").foregroundStyle(Color.chCaption))
                            .font(.inter(11.5)).lineLimit(1)
                    }
                }
                Spacer()
                Text(Format.int(Int(entry.score))).font(.inter(12, .bold)).monospacedDigit().foregroundStyle(Color.brandGold)
                    .accessibilityLabel("\(Format.int(Int(entry.score))) Top Overall points")
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(entry.handle == nil)
    }
}

/// The Community rules (collapsed, as the website's details element).
struct RulesCard: View {
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack {
                    Text("COMMUNITY RULES").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.chFog).rotationEffect(.degrees(open ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("communityRules")
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(SocialText.rules, id: \.self) { rule in
                        HStack(alignment: .top, spacing: 8) {
                            Text("•").foregroundStyle(Color.chFog)
                            Text(rule).font(.inter(12.5)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(14)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chInk.opacity(0.08)))
    }
}
