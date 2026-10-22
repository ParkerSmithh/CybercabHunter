import SwiftUI
import Observation

/// Spotting Streaks (public/js/streaks.js, worker/streaks.js). The rider's own
/// streaks are the server's (approved sightings only, on the Austin day they
/// were submitted); the app never counts a streak itself. The countdowns and
/// "at this pace" dates are the website's arithmetic on the server's numbers.
@MainActor
@Observable
final class StreaksModel {
    enum MeState: Equatable { case idle, loading, signedOut, ready(MyStreaks), failed }
    enum BoardState: Equatable { case loading, ready(StreakBoard), failed }
    private(set) var me: MeState = .idle
    private(set) var boards: [String: BoardState] = [:]
    var board = "weekly"
    private var loaded = false

    func reset() { loaded = false; me = .idle }

    func load(api: APIClient, signedIn: Bool, force: Bool = false) async {
        guard force || !loaded else { return }
        loaded = true
        if force { boards = [:] }
        async let b: Void = loadBoard(board, api: api)
        if signedIn {
            if case .ready = me {} else { me = .loading }
            do { me = .ready(try await api.get("/api/streaks/me", authenticated: true)) }
            catch APIError.unauthorized { me = .signedOut }
            catch is CancellationError {}
            catch { me = .failed }
        } else { me = .signedOut }
        await b
    }

    func loadBoard(_ id: String, api: APIClient) async {
        board = id
        if case .ready = boards[id] { return }
        boards[id] = .loading
        do { boards[id] = .ready(try await api.get("/api/streaks/leaderboard", query: [URLQueryItem(name: "board", value: id)], fresh: true)) }
        catch is CancellationError { boards[id] = nil }
        catch { boards[id] = .failed }
    }
}

struct StreaksSection: View {
    let model: StreaksModel
    /// When spotting began (the community summary's site_start).
    var siteStart: String?
    @Environment(SessionStore.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            CommunityPanelTitle(icon: "flame", title: "Spotting Streaks",
                                intro: "Verified Cybercab sightings on consecutive days or weeks. Counted in Austin time (CT); weeks run Monday to Sunday.")
            mine
            HowItWorks(title: "How Spotting Streaks Work", steps: [
                ("Submit a Cybercab sighting", "from the Submit button: a photo or the plate of a Cybercab you saw."),
                ("Wait for a moderator to verify it.", "Only approved sightings count; pending and rejected ones don't."),
                ("It counts on the day you submitted it", "(Austin time), even if it's approved days later."),
                ("Keep it going:", "one verified sighting a day builds your daily streak; one a week (Monday to Sunday) builds your weekly streak. More sightings on the same day or week don't add extra."),
                ("Today isn't over yet:", "your streak stays alive until the day (or week) ends."),
                ("Unlock milestones", "as your streaks grow. They stay unlocked even if a streak ends.")
            ], safety: "Spot safely: never chase or follow a Cybercab, never take photos while driving, and stay on public property. Weekly streaks are made for casual spotters.")
            StreakBoardView(model: model)
        }
        .task { await model.load(api: session.api, signedIn: session.user != nil) }
    }

    @ViewBuilder private var mine: some View {
        switch model.me {
        case .idle, .loading:
            PanelSkeleton(height: 150); PanelSkeleton(height: 150)
        case .signedOut:
            SignInPrompt(title: "Sign in to track your Cybercab spotting streaks.",
                         text: "Every verified sighting you submit counts toward a daily and a weekly streak, with milestones to unlock along the way.")
        case .failed:
            InlineMessage(text: "Couldn't load your streaks. Please try again in a moment.", systemImage: "exclamationmark.triangle")
        case .ready(let m):
            StreakCard(kind: "weekly", run: m.weekly, me: m)
            StreakCard(kind: "daily", run: m.daily, me: m)
            if m.verified.sightings == 0 {
                Text("No verified sightings yet. Submit a Cybercab sighting; once a moderator approves it, your streaks start on the day you submitted it.")
                    .font(.inter(13)).foregroundStyle(Color.chFog)
            }
            ActivityCalendar(me: m, siteStart: siteStart)
            Milestones(me: m)
        }
    }
}

/// The site's date arithmetic on the server's numbers.
enum StreakMath {
    static let day: TimeInterval = 86400
    static func date(_ key: String) -> Date? { Format.calendarDate(key) }
    static func key(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
    /// The next tier above the current streak, how many more, and when at this pace.
    static func next(kind: String, run: MyStreaks.Run, me: MyStreaks) -> (n: Int, left: Int, when: String?)? {
        guard let n = me.tiers(kind).first(where: { $0 > run.current }) else { return nil }
        let left = n - run.current
        let ahead = run.done ? left : left - 1
        var when: String?
        if run.current > 0, let base = date(kind == "weekly" ? me.weekStart : me.today) {
            when = key(base.addingTimeInterval(Double(ahead) * (kind == "weekly" ? 7 : 1) * day))
        }
        return (n, left, when)
    }
}

struct StreakCard: View {
    let kind: String
    let run: MyStreaks.Run
    let me: MyStreaks

    private var weekly: Bool { kind == "weekly" }
    private var unit: (String, String) { weekly ? ("Week", "Weeks") : ("Day", "Days") }

    var body: some View {
        let next = StreakMath.next(kind: kind, run: run, me: me)
        let tiers = me.tiers(kind)
        let prev = tiers.last(where: { $0 <= run.current }) ?? 0
        let pct = next.map { Double(run.current - prev) / Double($0.n - prev) } ?? 1
        let justHit = run.current > 0 && tiers.contains(run.current)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: weekly ? "calendar" : "flame").foregroundStyle(Color.brandGold)
                Text(weekly ? "Weekly streak" : "Daily streak").font(.inter(13, .bold)).foregroundStyle(Color.chInk)
                if weekly {
                    Text("Easiest to keep").font(.inter(10.5, .bold)).foregroundStyle(Color.brandGold)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Color.brandGold.opacity(0.12), in: .capsule)
                }
            }
            HStack(spacing: 14) {
                ZStack {
                    Circle().stroke(Color.chInk.opacity(0.08), lineWidth: 6)
                    Circle().trim(from: 0, to: max(0, min(1, pct)))
                        .stroke(Color.brandGold, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .shadow(color: justHit ? Color.brandGold.opacity(0.8) : .clear, radius: 5)
                    Image(systemName: weekly ? "calendar" : "flame").foregroundStyle(Color.brandGold)
                }
                .frame(width: 58, height: 58)
                .animation(.smooth(duration: 0.9), value: pct)
                .accessibilityLabel(next.map { "\(Int((pct * 100).rounded()))% of the way to \($0.n)" } ?? "Every milestone unlocked")
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text("\(run.current)").statNumber(30).accessibilityIdentifier("\(kind)StreakValue")
                        Text(run.current == 1 ? unit.0 : unit.1).font(.inter(15, .semibold)).foregroundStyle(Color.chMist)
                    }
                    Text("Longest: \(Format.plural(run.longest, unit.0, unit.1))").font(.inter(12)).foregroundStyle(Color.chFog)
                    if let next {
                        (Text(Format.plural(next.left, unit.0.lowercased(), unit.1.lowercased())).bold().foregroundStyle(Color.chInk)
                         + Text(" to your \(next.n)-\(unit.0.lowercased()) streak" + (next.when.map { " · \(Format.day($0, year: false)) at this pace" } ?? "")).foregroundStyle(Color.chFog))
                            .font(.inter(12))
                    } else {
                        Text("Every milestone unlocked.").font(.inter(12, .bold)).foregroundStyle(Color.chInk)
                    }
                }
            }
            if run.done {
                Label(weekly ? "This week counts" : "Today counts", systemImage: "checkmark").font(.inter(12, .semibold)).foregroundStyle(Color.chOK)
            } else {
                Text(run.current > 0 ? (weekly ? "Keep it alive: a verified sighting by Sunday" : "Keep it alive: a verified sighting today")
                                     : (weekly ? "No verified sighting yet this week" : "No verified sighting yet today"))
                    .font(.inter(12)).foregroundStyle(Color.chFog)
            }
        }
        .dataPanel()
        .accessibilityElement(children: .contain)
    }
}

/// The activity calendar: a column per week, Monday on top (the site's
/// GitHub-style grid), from when spotting began, at least 4 weeks, at most 53.
struct ActivityCalendar: View {
    let me: MyStreaks
    var siteStart: String?
    @State private var selected: String?
    @State private var width: CGFloat = 340

    var body: some View {
        let counts = Dictionary(me.calendar.days.map { ($0.date, $0.count) }, uniquingKeysWith: +)
        let today = StreakMath.date(me.today) ?? .now
        let monday = StreakMath.date(me.weekStart) ?? today
        let gap: CGFloat = 4
        let fit = Int((width - 28) / (11 + gap))
        let lived = livedWeeks(monday: monday)
        let weeks = max(4, min(53, fit, lived ?? 53))
        let cell = max(11, min(26, floor((width - 28) / CGFloat(weeks)) - gap))
        let first = monday.addingTimeInterval(-Double(weeks - 1) * 7 * StreakMath.day)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("ACTIVITY").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
                Spacer()
                Text("\(Format.plural(me.verified.sightings, "verified sighting", "verified sightings")) on \(Format.plural(me.verified.days, "day", "days"))"
                     + (siteStart != nil && (lived ?? 54) <= 53 ? " · since \(Format.day(siteStart, year: false)), when spotting began" : ""))
                    .font(.inter(11.5)).foregroundStyle(Color.chCaption)
            }
            HStack(alignment: .top, spacing: gap) {
                VStack(alignment: .leading, spacing: gap) {
                    ForEach(0..<7, id: \.self) { d in
                        Text(["Mon", "", "Wed", "", "Fri", "", ""][d]).font(.inter(9)).foregroundStyle(Color.chCaption).frame(width: 24, height: cell, alignment: .leading)
                    }
                }
                ForEach(0..<weeks, id: \.self) { w in
                    VStack(spacing: gap) {
                        ForEach(0..<7, id: \.self) { d in
                            let t = first.addingTimeInterval(Double(w * 7 + d) * StreakMath.day)
                            let key = StreakMath.key(t)
                            if t > today {
                                RoundedRectangle(cornerRadius: 3).strokeBorder(Color.chInk.opacity(0.05)).frame(width: cell, height: cell)
                            } else {
                                let n = counts[key] ?? 0
                                Button { selected = key } label: {
                                    RoundedRectangle(cornerRadius: 3).fill(fill(n))
                                        .shadow(color: n > 3 ? Color.brandGold.opacity(0.5) : .clear, radius: 4)
                                        .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(key == me.today ? Color.chInk.opacity(0.7) : key == selected ? Color.brandGold : .clear, lineWidth: 1.2))
                                        .frame(width: cell, height: cell)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(Format.day(key)): \(n > 0 ? Format.plural(n, "verified sighting", "verified sightings") : "no verified sightings")")
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if abs($0 - width) > 20 { width = $0 } }
            HStack(alignment: .top) {
                Group {
                    if let s = selected {
                        let n = counts[s] ?? 0
                        Text(Self.weekday(s)).bold().foregroundStyle(Color.chInk) + Text(" · \(n > 0 ? Format.plural(n, "verified sighting", "verified sightings") : "no verified sightings")").foregroundStyle(Color.chFog)
                    } else {
                        Text("Tap a day to see its verified sightings.").foregroundStyle(Color.chFog)
                    }
                }
                .font(.inter(12))
                Spacer()
                HStack(spacing: 3) {
                    Text("Less").font(.inter(10)).foregroundStyle(Color.chCaption)
                    ForEach([0, 1, 2, 4], id: \.self) { RoundedRectangle(cornerRadius: 2).fill(fill($0)).frame(width: 10, height: 10) }
                    Text("More").font(.inter(10)).foregroundStyle(Color.chCaption)
                }
                .accessibilityHidden(true)
            }
        }
        .dataPanel()
    }

    private func fill(_ n: Int) -> Color {
        switch n {
        case 0: Color.chInk.opacity(0.06)
        case 1: Color.brandGold.opacity(0.45)
        case 2...3: Color.brandGold.opacity(0.72)
        default: Color.brandGold
        }
    }

    /// Weeks since the first sighting anyone submitted (the summary's site_start), if known.
    private func livedWeeks(monday: Date) -> Int? {
        guard let start = StreakMath.date(siteStart ?? "") else { return nil }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let back = (cal.component(.weekday, from: start) + 5) % 7          // days since that week's Monday
        let startMonday = start.addingTimeInterval(-Double(back) * StreakMath.day)
        return Int((monday.timeIntervalSince(startMonday) / (7 * StreakMath.day)).rounded(.down)) + 1
    }

    static func weekday(_ key: String) -> String {
        guard let d = Format.calendarDate(key) else { return key }
        return d.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).weekday(.wide).month(.abbreviated).day())
    }
}

/// Milestones: unlocked from the longest streak ever (they stay unlocked).
struct Milestones: View {
    let me: MyStreaks
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("MILESTONES").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
                Spacer()
                Text("\(me.milestones.filter(\.unlocked).count) of \(me.milestones.count) unlocked").font(.inter(11.5)).foregroundStyle(Color.chCaption)
                    .accessibilityIdentifier("milestonesCount")
            }
            group("weekly", "Weekly")
            group("daily", "Daily")
        }
        .dataPanel()
    }

    private func group(_ type: String, _ title: String) -> some View {
        let run = type == "daily" ? me.daily : me.weekly
        return VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.inter(12, .semibold)).foregroundStyle(Color.chFog)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(me.milestones.filter { $0.type == type }) { m in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Image(systemName: m.unlocked ? "flame.fill" : "lock").font(.system(size: 12)).foregroundStyle(m.unlocked ? Color.brandGold : Color.chCaption)
                            Text("\(m.n)-\(type == "daily" ? "Day" : "Week") Streak").font(.inter(12.5, .bold)).foregroundStyle(m.unlocked ? Color.chInk : Color.chMist)
                        }
                        Text(sub(m, run: run, type: type)).font(.inter(11)).foregroundStyle(Color.chCaption).lineLimit(2)
                        if !m.unlocked {
                            GeometryReader { g in
                                Capsule().fill(Color.chInk.opacity(0.08))
                                    .overlay(alignment: .leading) { Capsule().fill(Color.brandGold).frame(width: g.size.width * min(1, Double(run.current) / Double(m.n))) }
                            }
                            .frame(height: 4)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
                    .background(m.unlocked ? Color.brandGold.opacity(0.07) : Color.chInk.opacity(0.03), in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(m.unlocked ? Color.brandGold.opacity(0.35) : Color.chInk.opacity(0.06)))
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func sub(_ m: MyStreaks.Milestone, run: MyStreaks.Run, type: String) -> String {
        if m.unlocked { return "Unlocked \(Format.day(m.unlockedOn))" }
        if run.current > 0, let base = StreakMath.date(type == "daily" ? me.today : me.weekStart) {
            let ahead = max(0, (m.n - run.current) - (run.done ? 0 : 1))
            let when = StreakMath.key(base.addingTimeInterval(Double(ahead) * (type == "daily" ? 1 : 7) * StreakMath.day))
            return "At this pace: \(type == "weekly" ? "week of " : "")\(Format.day(when, year: false))"
        }
        let best = type == "daily" ? me.daily.longest : me.weekly.longest
        return "Best so far: \(best) / \(m.n)"
    }
}

/// The public streak rankings (precomputed daily): Top Weekly, Top Daily, Longest All-Time.
struct StreakBoardView: View {
    let model: StreaksModel
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    private let tabs = [("weekly", "Top Weekly"), ("daily", "Top Daily"), ("longest", "Longest All-Time")]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("COMMUNITY STREAKS").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
                Spacer()
                if case .ready(let b)? = model.boards[model.board] {
                    Text(b.entries.count >= 10 ? "Top 10" : "\(b.entries.count) ranked").font(.inter(11.5)).foregroundStyle(Color.chCaption)
                }
            }
            if case .ready(let b)? = model.boards[model.board], let lead = b.entries.first {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "crown").foregroundStyle(Color.brandGold)
                    (Text(lead.name).bold().foregroundStyle(Color.chInk)
                     + Text(" holds the crown\(model.board == "longest" ? " for the longest streak" : ""): ").foregroundStyle(Color.chMist)
                     + Text(value(lead).text).bold().foregroundStyle(Color.chInk)
                     + Text(". Beat it.").foregroundStyle(Color.chMist))
                        .font(.inter(13))
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.brandGold.opacity(0.06), in: .rect(cornerRadius: 10))
            }
            HStack(spacing: 8) {
                ForEach(tabs, id: \.0) { id, label in
                    PillToggle(title: label, selected: model.board == id, compact: true) { Task { await model.loadBoard(id, api: session.api) } }
                }
            }
            switch model.boards[model.board] {
            case .ready(let b)?:
                if b.entries.isEmpty {
                    Text("No \(model.board == "longest" ? "" : "active ")streaks yet. Get a sighting verified to start one.").font(.inter(13)).foregroundStyle(Color.chFog)
                }
                ForEach(b.entries) { e in row(e) }
                if let at = Format.instant(b.computedAt) {
                    Text("Updated \(at.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day().hour().minute())) CT · daily")
                        .font(.inter(11.5)).foregroundStyle(Color.chCaption)
                }
            case .failed?:
                Text("Couldn't load the streak rankings. Please try again in a moment.").font(.inter(13)).foregroundStyle(Color.chFog)
            default:
                ProgressView().tint(Color.chFog).frame(maxWidth: .infinity)
            }
            Text("Only spotters with Community leaderboard & public profile turned on (on their Profile) are listed.")
                .font(.inter(11.5)).foregroundStyle(Color.chCaption)
        }
        .dataPanel()
        .accessibilityIdentifier("streakBoard")
    }

    private func value(_ e: StreakBoard.Entry) -> (n: Int, unit: String, text: String) {
        switch model.board {
        case "weekly": (e.weeklyCurrent, e.weeklyCurrent == 1 ? "week" : "weeks", Format.plural(e.weeklyCurrent, "week", "weeks"))
        case "daily": (e.dailyCurrent, e.dailyCurrent == 1 ? "day" : "days", Format.plural(e.dailyCurrent, "day", "days"))
        default: (e.longestDaily, e.longestDaily == 1 ? "day best" : "days best", Format.plural(e.longestDaily, "day", "days"))
        }
    }

    private func row(_ e: StreakBoard.Entry) -> some View {
        let v = value(e)
        return Button { if e.profile, let h = e.handle { router.communityPath.append(RiderRoute(handle: h)) } } label: {
            HStack(spacing: 10) {
                RankBadge(rank: e.rank, tied: e.tied)
                PersonAvatar(name: e.name, url: SocialAuthor.avatarURL(e.avatarUrl), size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(e.name).font(.inter(13.5, .bold)).foregroundStyle(Color.chInk).lineLimit(1)
                    Text("\(Format.plural(e.dailyCurrent, "day", "days")) · \(Format.plural(e.weeklyCurrent, "week", "weeks")) now · best \(Format.plural(e.longestDaily, "day", "days")) / \(Format.plural(e.longestWeekly, "week", "weeks"))")
                        .font(.inter(11)).foregroundStyle(Color.chCaption).lineLimit(2)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(v.n)").statNumber(18)
                    Text(v.unit).font(.inter(10.5)).foregroundStyle(Color.chCaption)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!(e.profile && e.handle != nil))
    }
}

/// 1 / 2 / 3 in gold, silver and bronze (css .lb-rank.is-gold …), plain after that.
struct RankBadge: View {
    let rank: Int
    var tied = false
    var body: some View {
        let style: (fg: Color, bg: AnyShapeStyle) = switch rank {
        case 1: (Color(hex: 0x1A1204), AnyShapeStyle(LinearGradient(colors: [Color(hex: 0xFFF3A6), .brandGold, Color(hex: 0xB8860B)], startPoint: .topLeading, endPoint: .bottomTrailing)))
        case 2: (Color(hex: 0x16181C), AnyShapeStyle(LinearGradient(colors: [.white, Color(hex: 0xC9CED6), Color(hex: 0x8A919C)], startPoint: .topLeading, endPoint: .bottomTrailing)))
        case 3: (Color(hex: 0x1F1006), AnyShapeStyle(LinearGradient(colors: [Color(hex: 0xF6C49A), Color(hex: 0xCD7F32), Color(hex: 0x8A4D1C)], startPoint: .topLeading, endPoint: .bottomTrailing)))
        default: (Color.chMist, AnyShapeStyle(Color.chInk.opacity(0.06)))
        }
        Text("\(rank)").font(.inter(12, .heavy)).monospacedDigit().foregroundStyle(style.fg)
            .frame(width: 28, height: 28)
            .background(style.bg, in: .rect(cornerRadius: 8))
            .shadow(color: rank == 1 ? Color.brandGold.opacity(0.45) : .clear, radius: 7)
            .accessibilityLabel("Rank \(rank)\(tied ? ", tied" : "")")
    }
}

/// A collapsed "How … works" list (the website's details element).
struct HowItWorks: View {
    let title: String
    let steps: [(String, String)]
    var extra: [(String, String)] = []
    var safety: String? = nil
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack {
                    Text(title).font(.inter(14, .bold)).foregroundStyle(Color.chInk)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.chFog).rotationEffect(.degrees(open ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(extra.enumerated()), id: \.offset) { _, row in
                        HStack { Text(row.0).foregroundStyle(Color.chMist); Spacer(); Text(row.1).bold().foregroundStyle(Color.brandGold) }.font(.inter(13))
                    }
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(i + 1).").font(.inter(13, .bold)).foregroundStyle(Color.brandGold)
                            (Text(step.0).bold().foregroundStyle(Color.chInk) + Text(" " + step.1).foregroundStyle(Color.chMist)).font(.inter(13))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let safety { Text(safety).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true) }
                }
                .transition(.opacity)
            }
        }
        .glassCard()
    }
}
