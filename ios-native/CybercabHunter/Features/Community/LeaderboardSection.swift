import SwiftUI
import Observation

/// The leaderboards (public/js/community.js, worker/community.js): the boards
/// the server lists (Top Overall first), top 10 each. Riders who turned their
/// public profile off are never sent, so they never appear.
@MainActor
@Observable
final class LeaderboardModel {
    enum State: Equatable { case loading, ready(Leaderboard), failed }
    private(set) var boards: [String: State] = [:]
    private(set) var list: [Leaderboard.Board] = []
    var current = "overall"
    /// A board another section asked for ("Top XP on the Leaderboard").
    var pendingBoard: String?

    func load(api: APIClient, force: Bool = false) async {
        if let pending = pendingBoard { current = pending; pendingBoard = nil }
        if force { boards = [:] }
        await select(current, api: api)
    }

    func select(_ id: String, api: APIClient) async {
        current = id
        if case .ready = boards[id] { return }
        boards[id] = .loading
        do {
            let b: Leaderboard = try await api.get("/api/community/leaderboard", query: id == "overall" ? [] : [URLQueryItem(name: "board", value: id)], fresh: true)
            boards[id] = .ready(b)
            list = b.boards
        } catch is CancellationError { boards[id] = nil }
        catch { boards[id] = .failed }
    }
}

struct LeaderboardSection: View {
    let model: LeaderboardModel
    @Environment(SessionStore.self) private var session
    @State private var expanded: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            let state = model.boards[model.current]
            let board: Leaderboard? = if case .ready(let b)? = state { b } else { nil }
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "trophy").font(.system(size: 18, weight: .semibold)).foregroundStyle(Color.brandGold).frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text((board?.label ?? "Top Overall").uppercased()).displayTitle(20).accessibilityIdentifier("boardTitle")
                        Spacer()
                        if let board { Text(board.entries.count >= 10 ? "Top 10" : "\(board.entries.count) ranked").font(.inter(11.5)).foregroundStyle(Color.chCaption) }
                    }
                    if let help = board?.help, !help.isEmpty { Text(help).font(.inter(12)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true) }
                }
            }
            if !model.list.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.list) { b in
                            PillToggle(title: b.label, selected: b.id == model.current, compact: true) {
                                expanded = nil
                                Task { await model.select(b.id, api: session.api) }
                            }
                            .accessibilityIdentifier("board-\(b.id)")
                        }
                    }
                }
            }
            switch state {
            case .ready(let b)?:
                if b.entries.isEmpty {
                    EmptyStateCard(title: b.board == "discovered" ? "No discoveries yet" : "No riders here yet",
                                   text: b.board == "discovered" ? "Be the first: ride in a Cybercab and add your receipt, or submit a sighting of one that isn't in the registry yet." : "Add a Cybercab ride receipt to get on the board.")
                }
                VStack(spacing: 8) {
                    ForEach(b.entries) { e in
                        LeaderboardRow(entry: e, board: b, tied: b.entries.filter { $0.rank == e.rank }.count > 1,
                                       expanded: expanded == e.id) { withAnimation(.snappy) { expanded = expanded == e.id ? nil : e.id } }
                    }
                }
                if !b.entries.isEmpty && b.entries.count < 10 {
                    Text("Room for \(10 - b.entries.count) more on this board. Spot a Cybercab or add a ride receipt to join it.").font(.inter(12)).foregroundStyle(Color.chFog)
                }
                if let t = b.totals {
                    Text("\(Format.plural(b.entries.count, "rider", "riders")) ranked on this board · \(Format.plural(t.spotters, "spotter", "spotters")) credited with a discovery (\(Format.plural(t.vehicles, "vehicle", "vehicles")) found in all)")
                        .font(.inter(12)).foregroundStyle(Color.chCaption)
                }
            case .failed?:
                EmptyStateCard(title: "We couldn't load the leaderboard", text: "Please try again in a moment.")
            default:
                ForEach(0..<3, id: \.self) { _ in RoundedRectangle(cornerRadius: 12).fill(Color.chSurface).frame(height: 64) }
            }
            Text("Spotters are listed by name and photo. Prefer not to be listed? Turn off Community leaderboard & public profile on your Profile page, and you will be left off every Community board.")
                .font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
        }
        .task { await model.load(api: session.api) }
        .onChange(of: model.pendingBoard) { _, b in if let b { model.pendingBoard = nil; Task { await model.select(b, api: session.api) } } }
    }
}

/// A board row: medal rank, avatar, name with Spotter rank, @handle, level and
/// XP, the board's number; tapping opens the full figures and the profile link.
struct LeaderboardRow: View {
    let entry: Leaderboard.Entry
    let board: Leaderboard
    let tied: Bool
    let expanded: Bool
    let toggle: () -> Void
    @Environment(AppRouter.self) private var router

    private static let metrics: [(KeyPath<Leaderboard.Entry, Int?>?, KeyPath<Leaderboard.Entry, Double?>?, String)] = [
        (\.discovered, nil, "Found"), (\.rides, nil, "Rides"), (nil, \.miles, "Miles"), (\.uniqueVehicles, nil, "Cars ridden"), (\.cities, nil, "Cities"), (\.xp, nil, "Spotter XP")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    RankBadge(rank: entry.rank, tied: tied)
                    PersonAvatar(name: entry.name, url: SocialAuthor.avatarURL(entry.avatarUrl), size: 38)
                        .clipShape(.rect(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(entry.name).font(.inter(14, .semibold)).foregroundStyle(Color.chInk).lineLimit(1)
                            if let r = entry.spotterRank { Text("— \(r)").font(.inter(11.5, .bold)).foregroundStyle(RankColor.color(entry.spotterRankKey)).lineLimit(1) }
                            if tied { Text("Tied").font(.inter(10, .bold)).foregroundStyle(Color.chFog) }
                        }
                        (Text(entry.handle.map { "@\($0)" } ?? "No public profile yet").foregroundStyle(entry.handle == nil ? Color.chCaption : Color.brandGold)
                         + Text(entry.level.map { " · Level \($0) · \(Format.int(entry.xp ?? 0)) XP" } ?? "").foregroundStyle(Color.chCaption))
                            .font(.inter(12)).lineLimit(1)
                        if board.board == "overall", let rides = entry.rides {
                            Text("\(Format.int(entry.discovered ?? 0)) found · \(Format.plural(rides, "ride", "rides")) · \(Format.plural(entry.uniqueVehicles ?? 0, "car", "cars")) · \(Format.plural(entry.cities ?? 0, "city", "cities")) · \(Format.one(entry.miles ?? 0)) mi")
                                .font(.inter(11)).foregroundStyle(Color.chCaption).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(Format.one(entry.count)).statNumber(19, color: entry.rank == 1 ? .brandGold : .chInk)
                        Text(board.unit(for: entry.count).uppercased()).font(.inter(10.5)).tracking(0.4).foregroundStyle(Color.chCaption)
                    }
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.chCaption).rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .padding(10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("leaderboardRow")
            if expanded { details.padding([.horizontal, .bottom], 12).transition(.opacity) }
        }
        .background(Color.chSurface, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(entry.rank == 1 ? Color.brandGold.opacity(0.45) : Color.chInk.opacity(0.08)))
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 12) {
            MetricGrid(columns: 3) {
                ForEach(Array(Self.metrics.enumerated()), id: \.offset) { _, m in
                    if let ip = m.0, let v = entry[keyPath: ip] { Metric(label: m.2, value: Format.int(v), size: 17) }
                    if let dp = m.1, let v = entry[keyPath: dp] { Metric(label: m.2, value: Format.one(v), size: 17) }
                }
            }
            if board.board == "overall", let d = entry.discovered, let r = entry.rides, let u = entry.uniqueVehicles, let c = entry.cities, let mi = entry.miles {
                // Top Overall's points, term by term (worker/community.js overallScore).
                let terms = [(d * 10, "\(d) found × 10"), (r * 3, "\(r) \(r == 1 ? "ride" : "rides") × 3"), (u * 2, "\(u) \(u == 1 ? "car" : "cars") × 2"), (c * 5, "\(c) \(c == 1 ? "city" : "cities") × 5"), (Int((mi / 10).rounded()), "\(Format.one(mi)) mi ÷ 10")]
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(terms.enumerated()), id: \.offset) { i, t in
                        HStack { Text((i == 0 ? "" : "+ ") + t.1).foregroundStyle(Color.chFog); Spacer(); Text(Format.int(t.0)).bold().foregroundStyle(Color.chInk) }
                    }
                    Divider().overlay(Color.chLine)
                    HStack { Text("= points").foregroundStyle(Color.chFog); Spacer(); Text(Format.one(entry.score)).bold().foregroundStyle(Color.brandGold) }
                }
                .font(.inter(12)).monospacedDigit()
                .accessibilityElement(children: .combine)
                .accessibilityLabel("How \(Format.one(entry.score)) points add up")
            }
            if entry.profile, let h = entry.handle {
                Button("View @\(h)'s profile →") { router.communityPath.append(RiderRoute(handle: h)) }
                    .font(.inter(13, .semibold))
                    .accessibilityIdentifier("leaderboardProfile")
            } else {
                Text("This spotter hasn't set up a public profile yet.").font(.inter(12)).foregroundStyle(Color.chCaption)
            }
        }
    }
}
