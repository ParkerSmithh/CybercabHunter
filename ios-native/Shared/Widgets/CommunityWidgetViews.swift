import SwiftUI
import WidgetKit

// My Spotting Progress, Community Activity and Community Leaderboard. Text and
// numbers only (no photos). Data: Shared/Widgets/WidgetModels.swift.

// MARK: - My Spotting Progress

struct SpottingProgressView: View {
    let data: SpottingProgressData
    let size: WidgetSize
    var stale = false

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.community("progress"))
    }

    @ViewBuilder private var content: some View {
        if !data.signedIn {
            WidgetMessage(icon: "person.crop.circle.badge.questionmark", title: "Sign in to see your progress",
                          message: size == .small ? "Open Cybercab Hunter and sign in." : "Open Cybercab Hunter and sign in to see your Spotter rank, level, XP and streak here.")
        } else {
            switch size {
            case .medium: medium
            case .large: large
            default: small
            }
        }
    }

    private var rankColor: Color { WidgetPalette.rank(data.rankKey) }

    private var rank: some View {
        HStack(spacing: 5) {
            Image(systemName: "shield.lefthalf.filled").font(.system(size: 12, weight: .bold)).foregroundStyle(rankColor)
            Text(data.rankName).font(ServiceFont.inter(13, .bold)).foregroundStyle(rankColor).lineLimit(1).minimumScaleFactor(0.8)
        }
    }

    private var levelLine: some View {
        HStack {
            Text("Level \(data.level)").foregroundStyle(WidgetPalette.ink)
            Spacer(minLength: 4)
            if let span = data.levelSpan { Text("\(data.levelInto.formatted()) / \(span.formatted()) XP").foregroundStyle(WidgetPalette.fog) }
        }
        .font(ServiceFont.inter(11, .semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
    }

    private func streak(_ n: Int?, _ unit: String, _ done: Bool?) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "flame.fill").font(.system(size: 12, weight: .bold)).foregroundStyle((n ?? 0) > 0 ? WidgetPalette.gold : WidgetPalette.fog).widgetAccentable()
            Text(n.map { "\($0)-\(unit)" } ?? "—").font(ServiceFont.inter(13, .bold)).foregroundStyle(WidgetPalette.ink).monospacedDigit()
            Text("streak").font(ServiceFont.inter(11, .medium)).foregroundStyle(WidgetPalette.fog)
            if done == true { Image(systemName: "checkmark.circle.fill").font(.system(size: 10)).foregroundStyle(WidgetPalette.up) }
        }
        .lineLimit(1).minimumScaleFactor(0.8)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "star.fill", title: "My progress")
            Spacer(minLength: 4)
            rank
            WidgetNumber(value: data.xp, size: 32).padding(.top, 2)
            Text("XP").font(ServiceFont.inter(10, .bold)).tracking(0.8).foregroundStyle(WidgetPalette.fog)
            Spacer(minLength: 6)
            levelLine
            WidgetBar(progress: data.levelProgress, height: 5).padding(.top, 4)
        }
    }

    private var medium: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 0) {
                WidgetEyebrow(icon: "star.fill", title: "My spotting progress")
                Spacer(minLength: 4)
                rank
                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    WidgetNumber(value: data.xp, size: 32)
                    Text("XP").font(ServiceFont.inter(11, .bold)).foregroundStyle(WidgetPalette.fog)
                }
                Spacer(minLength: 4)
                levelLine
                WidgetBar(progress: data.levelProgress, height: 6).padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                Text("STREAKS").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
                streak(data.dailyStreak, "day", data.dailyDone)
                streak(data.weeklyStreak, "week", data.weeklyDone)
                Spacer(minLength: 0)
                if let next = data.nextRankName, let needed = data.nextRankNeeded {
                    Text("\(needed.formatted()) XP to \(next)").font(ServiceFont.inter(10.5, .medium)).foregroundStyle(WidgetPalette.fog).lineLimit(2).minimumScaleFactor(0.8)
                }
            }
            .frame(width: 128, alignment: .leading)
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "star.fill", title: "My spotting progress")
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    rank
                    HStack(alignment: .lastTextBaseline, spacing: 4) {
                        WidgetNumber(value: data.xp, size: 40)
                        Text("XP").font(ServiceFont.inter(12, .bold)).foregroundStyle(WidgetPalette.fog)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    streak(data.dailyStreak, "day", data.dailyDone)
                    streak(data.weeklyStreak, "week", data.weeklyDone)
                }
            }
            .padding(.top, 8)
            levelLine.padding(.top, 10)
            WidgetBar(progress: data.levelProgress, height: 7).padding(.top, 5)
            if let next = data.nextRankName, let needed = data.nextRankNeeded {
                Text("\(needed.formatted()) XP to \(next)").font(ServiceFont.inter(11, .medium)).foregroundStyle(WidgetPalette.fog).padding(.top, 5)
            }
            Rectangle().fill(WidgetPalette.line).frame(height: 1).padding(.vertical, 10)
            Text("WEEKLY MISSIONS").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
            VStack(spacing: 7) {
                if data.weekly.isEmpty { Text("No weekly missions right now.").font(ServiceFont.inter(12, .medium)).foregroundStyle(WidgetPalette.fog).frame(maxWidth: .infinity, alignment: .leading) }
                ForEach(Array(data.weekly.prefix(3).enumerated()), id: \.offset) { _, m in mission(m) }
                if let today = data.daily.first {
                    Text("TODAY").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 2)
                    mission(today)
                }
            }
            .padding(.top, 6)
            Spacer(minLength: 4)
            WidgetFreshness(date: data.fetchedAt, stale: stale)
        }
    }

    private func mission(_ m: SpottingProgressData.Mission) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Image(systemName: m.done ? "checkmark.circle.fill" : "circle.dotted").font(.system(size: 11, weight: .bold)).foregroundStyle(m.done ? WidgetPalette.up : WidgetPalette.fog)
                Text(m.title).font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.ink).lineLimit(1)
                Spacer(minLength: 4)
                Text("\(min(m.progress, m.required))/\(m.required) · +\(m.reward) XP").font(ServiceFont.inter(10.5, .semibold)).foregroundStyle(WidgetPalette.fog).monospacedDigit().lineLimit(1)
            }
            WidgetBar(progress: m.required > 0 ? Double(m.progress) / Double(m.required) : 0, height: 4, color: m.done ? WidgetPalette.up : WidgetPalette.gold)
        }
    }
}

// MARK: - Community Activity

struct CommunityActivityView: View {
    let data: CommunityActivityData
    let size: WidgetSize
    var stale = false

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.community("social"))
    }

    @ViewBuilder private var content: some View {
        switch size {
        case .medium: medium
        case .large: large
        default: small
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "person.3.fill", title: "Community")
            Spacer(minLength: 4)
            WidgetNumber(value: data.verifiedThisWeek, size: 42)
            Text("verified sightings this week").font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.mist).lineLimit(2)
            Spacer(minLength: 6)
            Text(data.postsThisWeek.map { "\($0) \($0 == 1 ? "post" : "posts") this week" } ?? "Posts: —")
                .font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.gold).monospacedDigit().lineLimit(1)
            WidgetFreshness(date: data.fetchedAt, stale: stale).padding(.top, 3)
        }
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                WidgetEyebrow(icon: "bubble.left.and.bubble.right.fill", title: "Community", detail: data.feed.title)
                Spacer(minLength: 0)
            }
            if data.recent.isEmpty {
                noPosts
            } else {
                ForEach(data.recent.prefix(2)) { post in Link(destination: WidgetLink.post(post.id)) { row(post, lines: 1) } }
                Spacer(minLength: 0)
            }
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "bubble.left.and.bubble.right.fill", title: "Community activity", detail: data.feed.title)
            HStack(alignment: .top, spacing: 10) {
                WidgetStat(value: data.postsThisWeek, label: "Posts · week", size: 22, color: WidgetPalette.gold).frame(maxWidth: .infinity, alignment: .leading)
                WidgetStat(value: data.contributors, label: "Contributors", size: 22).frame(maxWidth: .infinity, alignment: .leading)
                WidgetStat(value: data.verifiedThisWeek, label: "Verified · week", size: 22).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 8)
            Rectangle().fill(WidgetPalette.line).frame(height: 1).padding(.vertical, 10)
            if data.recent.isEmpty && data.trending.isEmpty {
                noPosts
            } else {
                if !data.trending.isEmpty {
                    Text("TRENDING").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
                    VStack(spacing: 6) { ForEach(data.trending.prefix(2)) { post in Link(destination: WidgetLink.post(post.id)) { row(post, lines: 1) } } }.padding(.top, 5)
                }
                let recent = data.recent.filter { r in !data.trending.prefix(2).contains { $0.id == r.id } }
                if !recent.isEmpty {
                    Text("RECENT").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog).padding(.top, data.trending.isEmpty ? 0 : 10)
                    VStack(spacing: 6) { ForEach(recent.prefix(data.trending.isEmpty ? 4 : 2)) { post in Link(destination: WidgetLink.post(post.id)) { row(post, lines: 1) } } }.padding(.top, 5)
                }
            }
            Spacer(minLength: 4)
            WidgetFreshness(date: data.fetchedAt, stale: stale)
        }
    }

    private var noPosts: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No discussions yet").font(ServiceFont.inter(14, .bold)).foregroundStyle(WidgetPalette.ink)
            Text("Start one in the Community tab. Meanwhile: \(data.verifiedThisWeek.map { "\($0) verified sightings" } ?? "—") and \(data.missionsThisWeek.map { "\($0) missions completed" } ?? "—") this week.")
                .font(ServiceFont.inter(11.5, .medium)).foregroundStyle(WidgetPalette.fog).lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func row(_ post: CommunityActivityData.Post, lines: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(CommunityActivityData.categoryTitle(post.category).uppercased())
                    .font(ServiceFont.inter(8.5, .bold)).tracking(0.4).foregroundStyle(chip(post.category))
                    .padding(.horizontal, 5).padding(.vertical, 1.5)
                    .background(chip(post.category).opacity(0.14), in: .capsule)
                Text([post.author, WidgetTime.ago(post.createdAt)].compactMap { $0 }.joined(separator: " · "))
                    .font(ServiceFont.inter(10, .medium)).foregroundStyle(WidgetPalette.fog).lineLimit(1)
                Spacer(minLength: 0)
                Label("\(post.comments)", systemImage: "bubble.left").font(ServiceFont.inter(10, .semibold)).foregroundStyle(WidgetPalette.fog).labelStyle(.titleAndIcon)
            }
            Text(post.excerpt).font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.ink).lineLimit(lines)
        }
        .padding(.horizontal, 9).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 9))
    }

    private func chip(_ category: String) -> Color {
        switch category {
        case "sighting": WidgetPalette.gold
        case "review": WidgetPalette.up
        case "question": Color(red: 138 / 255, green: 180 / 255, blue: 248 / 255)
        case "news": Color(red: 196 / 255, green: 167 / 255, blue: 255 / 255)
        default: WidgetPalette.mist
        }
    }
}

// MARK: - Community Leaderboard

struct LeaderboardView: View {
    let data: LeaderboardData
    let size: WidgetSize
    var stale = false

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.community("leaderboard"))
    }

    @ViewBuilder private var content: some View {
        if data.entries.isEmpty {
            WidgetMessage(icon: "trophy", title: "No spotters on the board yet", message: "Verified sightings earn XP and a place here.")
        } else {
            switch size {
            case .medium: list(3, header: "Top spotters")
            case .large: large
            default: small
            }
        }
    }

    private var small: some View {
        let top = data.entries[0]
        return VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "trophy.fill", title: "Top spotter")
            Spacer(minLength: 6)
            Image(systemName: "medal.fill").font(.system(size: 24)).foregroundStyle(WidgetPalette.medal(1)).widgetAccentable()
            Text(top.name).font(ServiceFont.inter(16, .bold)).foregroundStyle(WidgetPalette.ink).lineLimit(1).minimumScaleFactor(0.7).padding(.top, 4)
            if let r = top.rankName { Text(r).font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.rank(top.rankKey)).lineLimit(1) }
            Spacer(minLength: 4)
            HStack(alignment: .lastTextBaseline, spacing: 3) {
                WidgetNumber(value: top.xp, size: 22)
                Text("XP").font(ServiceFont.inter(10, .bold)).foregroundStyle(WidgetPalette.fog)
            }
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 0) {
            list(5, header: "Community leaderboard")
            Rectangle().fill(WidgetPalette.line).frame(height: 1).padding(.vertical, 8)
            Group {
                if let me = data.me {
                    HStack {
                        Text("You").font(ServiceFont.inter(12, .bold)).foregroundStyle(WidgetPalette.gold)
                        Text("#\(me.rank)").font(ServiceFont.inter(12, .bold)).foregroundStyle(WidgetPalette.ink)
                        Spacer()
                        Text("\(me.xp.formatted()) XP").font(ServiceFont.inter(12, .bold)).foregroundStyle(WidgetPalette.ink).monospacedDigit()
                    }
                } else {
                    Text(data.signedIn ? "You're not on the public board yet." : "Sign in to Cybercab Hunter to see your place.")
                        .font(ServiceFont.inter(11.5, .medium)).foregroundStyle(WidgetPalette.fog)
                }
            }
            WidgetFreshness(date: data.fetchedAt, stale: stale).padding(.top, 6)
        }
    }

    private func list(_ n: Int, header: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                WidgetEyebrow(icon: "trophy.fill", title: header, detail: "XP")
                Spacer(minLength: 0)
            }
            VStack(spacing: size == .large ? 7 : 5) {
                ForEach(data.entries.prefix(n)) { e in row(e) }
            }
            .padding(.top, size == .large ? 10 : 6)
            if size == .large { Spacer(minLength: 0) }
        }
    }

    private func row(_ e: LeaderboardData.Entry) -> some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().fill(WidgetPalette.medal(e.rank).opacity(e.rank <= 3 ? 0.18 : 0.08))
                Text("\(e.rank)").font(ServiceFont.inter(11, .bold)).foregroundStyle(WidgetPalette.medal(e.rank)).monospacedDigit()
            }
            .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 0) {
                Text(e.name).font(ServiceFont.inter(12.5, .bold)).foregroundStyle(data.me?.id == e.id ? WidgetPalette.gold : WidgetPalette.ink).lineLimit(1)
                Text([e.rankName, e.level.map { "Level \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    .font(ServiceFont.inter(10, .medium)).foregroundStyle(WidgetPalette.rank(e.rankKey).opacity(0.9)).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text("\(e.xp.formatted()) XP").font(ServiceFont.inter(12, .bold)).foregroundStyle(e.rank == 1 ? WidgetPalette.gold : WidgetPalette.ink).monospacedDigit().lineLimit(1)
        }
        .padding(.horizontal, size == .large ? 8 : 6).padding(.vertical, size == .large ? 6 : 3)
        .background(Color.white.opacity(e.rank <= 3 ? 0.045 : 0.025), in: .rect(cornerRadius: 9))
    }
}
