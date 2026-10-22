import SwiftUI
import Observation

/// Spotter progress (public/js/progress.js, worker/progression.js): level,
/// rank, XP, missions, the rank ladder and recent XP. XP is awarded only by
/// the server, for moderator-approved contributions; Social posts, likes and
/// comments earn 0 XP. The app shows the server's numbers and never adds any.
@MainActor
@Observable
final class ProgressModel {
    enum State: Equatable { case idle, loading, signedOut, ready(MyProgress), failed }
    private(set) var state: State = .idle
    private(set) var rules: XPRules?
    private var loaded = false

    func reset() { loaded = false; state = .idle }

    func load(api: APIClient, signedIn: Bool, force: Bool = false) async {
        guard force || !loaded else { return }
        loaded = true
        if case .ready = state {} else { state = .loading }
        async let r: XPRules? = try? api.get("/api/xp/rules")
        if signedIn {
            do { state = .ready(try await api.get("/api/xp/me", authenticated: true)) }
            catch APIError.unauthorized { state = .signedOut }
            catch is CancellationError {}
            catch { state = .failed }
        } else { state = .signedOut }
        rules = await r ?? rules
    }
}

struct ProgressSection: View {
    let model: ProgressModel
    let showTopXP: () -> Void
    @Environment(SessionStore.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            CommunityPanelTitle(icon: "chart.line.uptrend.xyaxis", title: "Spotter Progress",
                                intro: "XP for verified contributions, levels and spotter ranks. Missions reset daily and every Monday (Austin time).")
            switch model.state {
            case .idle, .loading:
                PanelSkeleton(height: 150); PanelSkeleton(height: 120)
            case .failed:
                InlineMessage(text: "Couldn't load your progress. Please try again in a moment.", systemImage: "exclamationmark.triangle")
            case .signedOut:
                SignInPrompt(title: "Sign in to track your Spotter XP and missions.",
                             text: "Every verified sighting earns XP, missions add more, and your rank climbs from Bronze to Diamond Spotter.")
                if let rules = model.rules {
                    RankLadder(ranks: rules.ranks, current: nil, xp: nil)
                    block("Missions", "Optional") {
                        ForEach(rules.missions) { m in
                            MissionCard(title: m.title, description: m.description, reward: m.reward, weekly: m.period == "week", footer: m.period == "week" ? "Weekly" : "Daily")
                        }
                    }
                }
                Button("See who leads in Top XP on the Leaderboard →", action: showTopXP).font(.inter(13, .semibold))
                    .accessibilityIdentifier("topXPLink")
            case .ready(let me):
                hero(me)
                block("Daily missions", "Resets at midnight (CT)") { ForEach(me.missions.daily) { MissionCard(mission: $0, weekly: false) } }
                block("Weekly missions", "Monday to Sunday (CT)") { ForEach(me.missions.weekly) { MissionCard(mission: $0, weekly: true) } }
                RankLadder(ranks: me.ranks, current: me.rank.key, xp: me.xp)
                block("Recent XP", me.recent.isEmpty ? "" : "Latest \(me.recent.count)") {
                    if me.recent.isEmpty {
                        Text("No XP yet. Submit a Cybercab sighting; when a moderator verifies it, you earn your first \(model.rules?.rewards.first { $0.id == "verified_sighting" }?.xp ?? me.rewards.first { $0.id == "verified_sighting" }?.xp ?? 25) XP.")
                            .font(.inter(13)).foregroundStyle(Color.chFog)
                    }
                    ForEach(Array(me.recent.enumerated()), id: \.offset) { _, r in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(r.reason).font(.inter(13)).foregroundStyle(Color.chMist)
                                Text(Format.dateTime(Format.instant(r.at))).font(.inter(11)).foregroundStyle(Color.chCaption)
                            }
                            Spacer()
                            Text("\(r.amount < 0 ? "−" : "+")\(Format.int(abs(r.amount))) XP").font(.inter(13, .bold)).monospacedDigit()
                                .foregroundStyle(r.amount < 0 ? Color(hex: 0xF08A84) : Color.chOK)
                        }
                    }
                }
            }
            if let rules = model.rules {
                HowItWorks(title: "How XP works", steps: [
                    ("Only verified contributions earn XP.", "A moderator approves each sighting first; pending and rejected ones earn nothing."),
                    ("Each one pays once.", "The same Cybercab filed again the same day doesn't earn twice."),
                    ("Missions follow the day you submitted", "(Austin time), so a late approval still counts for its own day or week, and pays when approved."),
                    ("If a verified contribution is later removed,", "its XP (and any mission it completed) comes back off."),
                    ("Levels and ranks follow your total XP", "and update by themselves. XP is the only reward.")
                ], extra: rules.rewards.map { ($0.label, "+\(Format.int($0.xp)) XP") },
                safety: "Spot safely: never chase or follow a Cybercab, and never take photos while driving.")
            }
        }
        .task { await model.load(api: session.api, signedIn: session.user != nil) }
    }

    private func hero(_ m: MyProgress) -> some View {
        let pct = m.level.span.map { Double(m.level.into) / Double(max(1, $0)) } ?? 1
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                (Text("LEVEL \(m.level.n) — ").foregroundStyle(Color.chInk) + Text(m.rank.name.uppercased()).foregroundStyle(RankColor.color(m.rank.key)))
                    .font(.inter(15, .heavy)).tracking(0.3)
                    .accessibilityIdentifier("progressLevel")
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 3) { Text(Format.int(m.xp)).statNumber(24); Text("XP").font(.inter(12, .semibold)).foregroundStyle(Color.chFog) }
            }
            XPBar(fraction: pct, height: 10)
                .accessibilityLabel("Level \(m.level.n) progress")
                .accessibilityValue("\(Int((pct * 100).rounded())) percent")
            VStack(alignment: .leading, spacing: 4) {
                if let next = m.level.next {
                    (Text("\(Format.int(m.xp)) / \(Format.int(next)) XP").bold().foregroundStyle(Color.chInk) + Text(" · \(Format.int(next - m.xp)) XP to level \(m.level.n + 1)").foregroundStyle(Color.chFog))
                } else {
                    Text("Top level reached").bold().foregroundStyle(Color.chInk)
                }
                if let n = m.rank.next {
                    Text("\(Format.int(n.needed)) XP to ").foregroundStyle(Color.chFog) + Text(n.name).bold().foregroundStyle(RankColor.color(n.key))
                } else {
                    Text("Highest rank reached").foregroundStyle(Color.chFog)
                }
            }
            .font(.inter(12.5))
        }
        .dataPanel()
    }

    private func block<C: View>(_ title: String, _ trailing: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title.uppercased()).font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
                Spacer()
                Text(trailing).font(.inter(11.5)).foregroundStyle(Color.chCaption)
            }
            content()
        }
    }
}

/// The gold XP bar (css .xp-bar).
struct XPBar: View {
    let fraction: Double
    var height: CGFloat = 6
    var body: some View {
        GeometryReader { g in
            Capsule().fill(Color.chInk.opacity(0.08))
                .overlay(alignment: .leading) {
                    Capsule().fill(LinearGradient(colors: [Color.brandGold.opacity(0.65), .brandGold], startPoint: .leading, endPoint: .trailing))
                        .frame(width: g.size.width * max(0, min(1, fraction)))
                        .shadow(color: Color.brandGold.opacity(0.45), radius: 5)
                }
        }
        .frame(height: height)
        .animation(.smooth(duration: 0.8), value: fraction)
    }
}

/// A mission (css .mission): title, reward, description, progress and state.
struct MissionCard: View {
    let title: String
    let description: String
    let reward: Int
    let weekly: Bool
    var progress: (Int, Int)? = nil
    var status: String? = nil
    var done = false
    var footer: String? = nil

    private static let states = ["not_started": "Not started", "in_progress": "In progress", "awaiting_verification": "Awaiting verification", "completing": "Verified · XP on its way", "completed": "Completed"]

    init(title: String, description: String, reward: Int, weekly: Bool, footer: String) {
        self.title = title; self.description = description; self.reward = reward; self.weekly = weekly; self.footer = footer
    }

    init(mission m: MyProgress.Mission, weekly: Bool) {
        title = m.title; description = m.description; reward = m.reward; self.weekly = weekly
        progress = (m.progress, m.required)
        done = m.state == "completed"
        status = done ? "COMPLETED — +\(Format.int(m.reward)) XP EARNED"
            : m.state == "awaiting_verification" ? "\(m.pending) awaiting verification"
            : (Self.states[m.state] ?? "") + (m.pending > 0 ? " · \(m.pending) awaiting verification" : "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title.uppercased()).font(.inter(13, .heavy)).tracking(0.3).foregroundStyle(Color.chInk)
                Spacer()
                Text("+\(Format.int(reward)) XP").font(.inter(12, .bold)).foregroundStyle(Color.brandGold)
            }
            Text(description).font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            if let progress {
                XPBar(fraction: Double(progress.0) / Double(max(1, progress.1)))
                HStack {
                    (Text("Progress: ") + Text("\(progress.0) / \(progress.1)").bold()).font(.inter(12)).foregroundStyle(Color.chMist)
                    Spacer()
                    if let status { Text(status).font(.inter(11, done ? .bold : .medium)).foregroundStyle(done ? Color.chOK : Color.chFog).multilineTextAlignment(.trailing) }
                }
            } else if let footer {
                Text(footer).font(.inter(11.5)).foregroundStyle(Color.chCaption)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(done ? Color.chOK.opacity(0.06) : Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(done ? Color.chOK.opacity(0.35) : weekly ? Color.brandGold.opacity(0.25) : Color.chInk.opacity(0.08)))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("mission")
    }
}

/// The five ranks, in order, with the rider's own highlighted (text only, never a badge).
struct RankLadder: View {
    let ranks: [XPRules.Rank]
    let current: String?
    let xp: Int?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("SPOTTER RANKS").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
                Spacer()
                Text("By total XP").font(.inter(11.5)).foregroundStyle(Color.chCaption)
            }
            VStack(spacing: 6) {
                ForEach(ranks) { r in
                    let here = r.key == current, passed = xp.map { $0 >= r.xp } ?? false
                    HStack {
                        Text(r.name).font(.inter(13.5, .bold)).foregroundStyle(RankColor.color(r.key))
                        if here {
                            Text("You").font(.inter(10.5, .bold)).foregroundStyle(Color(hex: 0x1A1204))
                                .padding(.horizontal, 7).padding(.vertical, 2).background(Color.brandGold, in: .capsule)
                        }
                        Spacer()
                        Text("\(Format.int(r.xp)) XP").font(.inter(12)).monospacedDigit().foregroundStyle(passed ? Color.chMist : Color.chCaption)
                        Image(systemName: passed ? "checkmark.circle.fill" : "circle").font(.system(size: 13)).foregroundStyle(passed ? Color.chOK : Color.chSmoke)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(here ? Color.brandGold.opacity(0.08) : Color.chSurface, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(here ? Color.brandGold.opacity(0.45) : Color.chInk.opacity(0.06)))
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}
