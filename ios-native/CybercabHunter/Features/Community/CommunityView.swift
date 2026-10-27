import SwiftUI
import Observation

/// The four Community sections (public/community.html), Social first.
enum CommunitySection: String, CaseIterable, Identifiable, Sendable {
    case social, streaks, leaderboard, progress
    var id: String { rawValue }
    var title: String { rawValue.uppercased() }
    /// The hero intro per section (js/community-stats.js INTRO).
    var intro: String {
        switch self {
        case .social: "Posts, photos, questions and ride reviews from the people tracking Tesla's Cybercab."
        case .streaks: "Spot Cybercabs on consecutive days or weeks. Every verified sighting keeps your streak alive."
        case .leaderboard: "The spotters and riders who found each Cybercab first, and who have ridden the most."
        case .progress: "Earn XP for verified contributions, level up and climb from Bronze to Diamond Spotter."
        }
    }
}

/// The at-a-glance numbers (GET /api/community/summary, precomputed daily, and
/// the leaderboard's totals). A tile stays "—" if its number can't be loaded.
@MainActor
@Observable
final class CommunityStatsModel {
    private(set) var summary: CommunitySummary?
    private(set) var totals: Leaderboard.Totals?
    private var loaded = false

    func load(api: APIClient, force: Bool = false) async {
        guard force || !loaded else { return }
        loaded = true
        async let s: CommunitySummary? = try? api.get("/api/community/summary")
        async let b: Leaderboard? = try? api.get("/api/community/leaderboard", fresh: true)
        let (summary, board) = await (s, b)
        if let summary { self.summary = summary }
        if let board { totals = board.totals }
    }
}

/// Community (the website's /community): Social, Streaks, Leaderboard and
/// Progress, all native. Every number and post comes from the Worker.
struct CommunityView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var section: CommunitySection = .social
    @State private var visited: Set<CommunitySection> = [.social]
    @State private var social: SocialFeedModel?
    @State private var stats = CommunityStatsModel()
    @State private var notifications = NotificationsModel()
    @State private var streaks = StreaksModel()
    @State private var board = LeaderboardModel()
    @State private var progress = ProgressModel()
    @State private var showingNotifications = false
    @State private var showingRiderSearch = false

    var body: some View {
        ZStack {
            ForEach(CommunitySection.allCases) { s in
                if visited.contains(s) {
                    sectionScroll(s)
                        .opacity(section == s ? 1 : 0)
                        .allowsHitTesting(section == s)
                        .accessibilityHidden(section != s)
                }
            }
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showingRiderSearch = true } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel("Find riders")
                    .accessibilityIdentifier("findRiders")
            }
            if session.user != nil {
                ToolbarItem(placement: .topBarTrailing) { bell }
            }
        }
        .navigationDestination(for: PostRoute.self) { route in
            if let social { PostDetailView(route: route, social: social) }
        }
        .navigationDestination(for: RiderRoute.self) { RiderProfileView(route: $0) }
        .navigationDestination(for: VehicleRoute.self) { VehicleDetailView(route: $0) }
        .overlay(alignment: .top) { if let social { ToastOverlay(social: social) } }
        .sheet(isPresented: $showingNotifications) {
            NotificationsView(model: notifications) { target in
                showingNotifications = false
                router.open(target)
            }
        }
        .sheet(isPresented: $showingRiderSearch) {
            RiderSearchView { handle in
                showingRiderSearch = false
                router.communityPath.append(RiderRoute(handle: handle))
            }
        }
        .task {
            if social == nil { social = SocialFeedModel(api: session.api) }
            if let s = router.communitySection { select(s); router.communitySection = nil }
            async let a: Void = social!.start(signedIn: session.user != nil)
            async let b: Void = stats.load(api: session.api)
            _ = await (a, b)
        }
        // Unread count: on show, every 3 minutes while open and active (the site's poll).
        .task(id: session.user?.id) {
            guard session.user != nil else { notifications.reset(); return }
            while !Task.isCancelled {
                if scenePhase == .active && router.selectedTab == .community { await notifications.refreshCount(api: session.api) }
                try? await Task.sleep(for: .seconds(180))
            }
        }
        .onChange(of: session.user?.id) { old, new in
            guard old != new, let social else { return }
            if new == nil { social.signedOut() }
            Task { await social.reload() }
            streaks.reset(); progress.reset()
            if visited.contains(.streaks) { Task { await streaks.load(api: session.api, signedIn: new != nil) } }
            if visited.contains(.progress) { Task { await progress.load(api: session.api, signedIn: new != nil) } }
        }
        .onChange(of: router.communitySection) { _, s in if let s { select(s); router.communitySection = nil } }
        // The rider renamed themselves, changed their photo or privacy: what
        // Community shows about them reloads, past this device's HTTP cache.
        // (The edge's own 5-minute leaderboard cache and the daily streak
        // snapshot are the server's: PLAN.md, Phase 5.1.)
        .onReceive(NotificationCenter.default.publisher(for: .profileChanged)) { _ in
            Task {
                async let s: Void? = social?.refreshAll()
                async let b: Void = board.load(api: session.api, force: true)
                async let t: Void = stats.load(api: session.api, force: true)
                _ = await (s, b, t)
                if visited.contains(.streaks) { await streaks.load(api: session.api, signedIn: session.user != nil, force: true) }
            }
        }
    }

    private var bell: some View {
        Button { showingNotifications = true } label: {
            Image(systemName: "bell")
                .overlay(alignment: .topTrailing) {
                    if notifications.unread > 0 {
                        Text(notifications.unread > 99 ? "99+" : "\(notifications.unread)")
                            .font(.inter(10, .heavy)).monospacedDigit()
                            .foregroundStyle(Color(hex: 0x1A1204))
                            .padding(.horizontal, 4).frame(minWidth: 17, minHeight: 17)
                            .background(Color.brandGold, in: .capsule)
                            .offset(x: 10, y: -9)
                    }
                }
        }
        .accessibilityLabel(notifications.unread > 0 ? "Notifications, \(notifications.unread) unread" : "Notifications")
        .accessibilityIdentifier("notificationsBell")
    }

    private func select(_ s: CommunitySection) {
        withAnimation(.snappy(duration: 0.22)) { section = s }
        visited.insert(s)
    }

    // MARK: One section's scroll view (keeps its own position)

    private func sectionScroll(_ s: CommunitySection) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                switch s {
                case .social:
                    if let social { SocialSection(social: social) }
                case .streaks: StreaksSection(model: streaks, siteStart: stats.summary?.sightings?.siteStart)
                case .leaderboard: LeaderboardSection(model: board)
                case .progress: ProgressSection(model: progress, showTopXP: { board.pendingBoard = "xp"; select(.leaderboard) })
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .refreshable { await refresh(s) }
        .accessibilityIdentifier("communityScroll-\(s.rawValue)")
    }

    private func refresh(_ s: CommunitySection) async {
        async let st: Void = stats.load(api: session.api, force: true)
        switch s {
        case .social: await social?.refreshAll()
        case .streaks: await streaks.load(api: session.api, signedIn: session.user != nil, force: true)
        case .leaderboard: await board.load(api: session.api, force: true)
        case .progress: await progress.load(api: session.api, signedIn: session.user != nil, force: true)
        }
        await st
        if session.user != nil { await notifications.refreshCount(api: session.api) }
    }

    // MARK: Header: hero, sections, at-a-glance tiles

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Eyebrow(text: "Cybercab Hunter community")
                    Text("COMMUNITY").displayTitle(30)
                    Text(section.intro).font(.inter(14)).foregroundStyle(Color.chFog)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .accessibilityIdentifier("communityIntro")
                }
                Spacer(minLength: 0)
                // The website's Community hero (images/CybercabFlipped.png) on a soft gold glow.
                CommunityHeroCar()
            }
            // All four on screen at any text size: the roomiest layout that fits wins
            // (no horizontal scrolling, labels never shortened).
            ViewThatFits(in: .horizontal) {
                sectionRow(padding: 12, spacing: 8, fill: false)
                sectionRow(padding: 8, spacing: 5, fill: false)
                sectionRow(padding: 4, spacing: 4, fill: true)
            }
            .sensoryFeedback(.selection, trigger: section)
            tiles
        }
        .padding(.top, 8)
    }

    private func sectionRow(padding: CGFloat, spacing: CGFloat, fill: Bool) -> some View {
        HStack(spacing: spacing) {
            ForEach(CommunitySection.allCases) { s in
                let on = section == s
                Button { select(s) } label: {
                    Text(s.title)
                        .font(.inter(12, .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(fill ? 0.7 : 1)
                        .padding(.horizontal, padding)
                        .frame(maxWidth: fill ? .infinity : nil, minHeight: 34)
                        .foregroundStyle(on ? Color.chBackground : Color.chMist)
                        .background(on ? Color.chInk : Color.clear, in: .capsule)
                        .overlay(Capsule().strokeBorder(on ? Color.clear : Color.chHair2))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("section-\(s.rawValue)")
            }
        }
        .fixedSize(horizontal: !fill, vertical: false)
    }

    @ViewBuilder private var tiles: some View {
        let summary = stats.summary
        MetricGrid(columns: 2) {
            switch section {
            case .social:
                let s = social?.sidebar?.stats
                Metric(label: "Posts", value: Format.int(s?.posts), note: "Shared by the community")
                Metric(label: "Contributors", value: Format.int(s?.contributors), note: "People who have posted")
                Metric(label: "Posts this week", value: Format.int(s?.postsThisWeek), note: "In the last 7 days")
                Metric(label: "Ride reviews", value: s?.averageRating.map { String(format: "%.1f", $0) } ?? "—", unit: s?.averageRating == nil ? nil : "/ 5",
                       note: s.map { $0.reviews > 0 ? "Across \(Format.plural($0.reviews, "ride review", "ride reviews"))" : "No ride reviews yet" } ?? "Average rating")
            case .streaks:
                let st = summary?.streaks
                Metric(label: "Active weekly streaks", value: Format.int(st?.activeWeekly), note: st.map { $0.activeWeekly == 1 ? "Spotter on a weekly run" : "Spotters on a weekly run" } ?? "Spotters on a weekly run")
                Metric(label: "Active daily streaks", value: Format.int(st?.activeDaily), note: st.map { $0.activeDaily == 1 ? "Spotter on a daily run" : "Spotters on a daily run" } ?? "Spotters on a daily run")
                Metric(label: "Longest streak", value: Format.int(st?.recordDaily), note: st.map { $0.recordDaily == 1 ? "Day in a row, all-time" : "Days in a row, all-time" } ?? "Days in a row, all-time")
                Metric(label: "Verified this week", value: Format.int(st?.verifiedThisWeek), note: "Approved since Monday")
            case .leaderboard:
                let t = stats.totals, s = summary?.sightings
                Metric(label: "Credited spotters", value: Format.int(t?.spotters), note: "With a vehicle discovery")
                Metric(label: "Vehicles discovered", value: Format.int(t?.vehicles), note: "First spotted or ridden")
                Metric(label: "Verified sightings", value: Format.int(s?.verified), note: "Approved, all-time")
                Metric(label: "Photos submitted", value: Format.int(s?.photosSubmitted), note: "Sighting photos sent in")
                Metric(label: "Cities covered", value: Format.int(s?.cities), note: "With a verified sighting")
            case .progress:
                let x = summary?.xp
                Metric(label: "XP earned", value: Format.int(x?.total), note: "By every spotter, all-time")
                Metric(label: "Spotters with XP", value: Format.int(x?.spotters), note: "From verified contributions")
                Metric(label: "Missions this week", value: Format.int(x?.missionsThisWeek), note: "Completed since Monday")
                let top = x.flatMap { $0.spotters > 0 ? $0.topRank : nil }
                Metric(label: "Top rank", value: top?.replacingOccurrences(of: " Spotter", with: "") ?? "—", note: "The highest spotter rank",
                       valueColor: top.map { RankColor.color(RankColor.key(fromName: $0)) } ?? .chInk)
            }
        }
        .padding(16)
        .background(Color.chSurface, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.chInk.opacity(0.08)))
        .accessibilityIdentifier("communityTiles")
    }
}

/// The Community hero's car slides in once (css/community.css cch-car-in:
/// from 28 px right, 97% scale, transparent, over 0.9 s). Reduce Motion: no slide.
private struct CommunityHeroCar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    var body: some View {
        Image("CommunityCybercab").resizable().scaledToFit().frame(width: 104)
            .background(Circle().fill(Color.brandGold.opacity(0.16)).blur(radius: 22))
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(x: shown || reduceMotion ? 0 : 28)
            .scaleEffect(shown || reduceMotion ? 1 : 0.97)
            .onAppear { withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.9).delay(0.1)) { shown = true } }
            .accessibilityHidden(true)
    }
}
