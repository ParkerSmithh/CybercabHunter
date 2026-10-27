import SwiftUI
import WidgetKit

// Fleet Statistics, Fleet Growth, Cybercab Milestones, the Lock Screen fleet
// widgets and the restyled Cybercab Daily. Data: Shared/Widgets/WidgetModels.swift.

/// What the small Fleet Statistics widget headlines (the widget's configuration).
enum FleetStatistic: String, Codable, CaseIterable, Sendable {
    case registrations, rides, sightings
    var title: String { switch self { case .registrations: "Cybercabs"; case .rides: "Rides"; case .sightings: "Sightings" } }
    var caption: String { switch self { case .registrations: "registered Cybercabs"; case .rides: "recorded rides"; case .sightings: "sightings" } }
}

// MARK: - Fleet Statistics

struct FleetStatsView: View {
    let data: FleetStatsData
    let size: WidgetSize
    var statistic: FleetStatistic = .registrations
    var stale = false

    private var detail: String? { data.city == .all ? nil : data.city.title }

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.url("registry"))
    }

    @ViewBuilder private var content: some View {
        switch size {
        case .medium: medium
        case .large: large
        default: small
        }
    }

    private var small: some View {
        let value: Int = switch statistic { case .registrations: data.registered; case .rides: data.rides; case .sightings: data.sightings }
        return VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: statistic == .registrations ? "car.side.fill" : statistic == .rides ? "steeringwheel" : "eye.fill", title: statistic.title, detail: detail)
            Spacer(minLength: 4)
            WidgetNumber(value: value, size: 46)
            Text(statistic.caption).font(ServiceFont.inter(11.5, .semibold)).foregroundStyle(WidgetPalette.mist).lineLimit(1)
            Spacer(minLength: 6)
            switch statistic {
            case .registrations: WidgetChange(change: data.added7d, period: "this week")
            case .sightings: WidgetChange(change: data.sightings7d, period: "this week")
            case .rides: Text("All time").font(ServiceFont.inter(11, .medium)).foregroundStyle(WidgetPalette.fog)
            }
            WidgetFreshness(date: data.fetchedAt, stale: stale).padding(.top, 3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { WidgetEyebrow(icon: "chart.bar.fill", title: "Fleet statistics", detail: data.city.title); Spacer(minLength: 0) }
            Spacer(minLength: 6)
            HStack(alignment: .top, spacing: 12) {
                WidgetStat(value: data.registered, label: "Registered", size: 30, color: WidgetPalette.gold, note: data.added7d.map { "+\($0) · 7 days" })
                    .frame(maxWidth: .infinity, alignment: .leading)
                Rectangle().fill(WidgetPalette.line).frame(width: 1, height: 52)
                WidgetStat(value: data.rides, label: "Rides", size: 30)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Rectangle().fill(WidgetPalette.line).frame(width: 1, height: 52)
                WidgetStat(value: data.sightings, label: "Sightings", size: 30, note: data.sightings7d.map { "+\($0) · 7 days" })
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 6)
            WidgetFreshness(date: data.fetchedAt, stale: stale)
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "chart.bar.fill", title: "Fleet statistics", detail: data.city.title)
            HStack(alignment: .center, spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    WidgetNumber(value: data.registered, size: 50)
                    Text("registered Cybercabs").font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.mist)
                    WidgetChange(change: data.added7d, period: "in 7 days", size: 12).padding(.top, 3)
                }
                Spacer(minLength: 0)
                WidgetCar(width: 128)
            }
            .padding(.top, 8)
            Rectangle().fill(WidgetPalette.line).frame(height: 1).padding(.vertical, 10)
            HStack(alignment: .top, spacing: 10) {
                WidgetStat(value: data.rides, label: "Rides", size: 24).frame(maxWidth: .infinity, alignment: .leading)
                WidgetStat(value: data.sightings, label: "Sightings", size: 24).frame(maxWidth: .infinity, alignment: .leading)
                WidgetStat(value: data.sightings7d, label: "Sightings · 7 days", size: 24).frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 8)
            if data.city == .all, let austin = data.austin, let dallas = data.dallas {
                Text("BY CITY").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
                VStack(spacing: 5) {
                    cityRow("Austin", austin)
                    cityRow("Dallas", dallas)
                }
                .padding(.top, 5)
            } else {
                Text("THIS WEEK VS LAST").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
                VStack(spacing: 5) {
                    weekRow("Cybercabs added", data.added7d, data.addedPrev7d)
                    weekRow("Sightings", data.sightings7d, data.sightingsPrev7d)
                }
                .padding(.top, 5)
            }
            Spacer(minLength: 6)
            WidgetFreshness(date: data.fetchedAt, stale: stale)
        }
    }

    private func cityRow(_ name: String, _ c: FleetStatsData.CityFigures) -> some View {
        HStack(spacing: 8) {
            Text(name).font(ServiceFont.inter(12.5, .bold)).foregroundStyle(WidgetPalette.ink).frame(width: 58, alignment: .leading)
            figure(c.registered, "cars", gold: true)
            figure(c.rides, "rides")
            figure(c.sightings, "sightings")
            Spacer(minLength: 0)
            if let a = c.added7d { Text(a > 0 ? "+\(a) · 7d" : "+0 · 7d").font(ServiceFont.inter(10.5, .semibold)).foregroundStyle(a > 0 ? WidgetPalette.up : WidgetPalette.fog) }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 9))
    }

    private func figure(_ n: Int, _ label: String, gold: Bool = false) -> some View {
        (Text(n.formatted()).font(ServiceFont.inter(13, .bold)).foregroundStyle(gold ? WidgetPalette.gold : WidgetPalette.ink)
         + Text(" \(label)").font(ServiceFont.inter(10.5, .medium)).foregroundStyle(WidgetPalette.fog))
            .monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
    }

    private func weekRow(_ label: String, _ now: Int?, _ before: Int?) -> some View {
        HStack {
            Text(label).font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.mist)
            Spacer()
            Text(now.map { $0.formatted() } ?? "—").font(ServiceFont.inter(13, .bold)).foregroundStyle(WidgetPalette.gold).monospacedDigit()
            Text("vs \(before.map { $0.formatted() } ?? "—")").font(ServiceFont.inter(11, .medium)).foregroundStyle(WidgetPalette.fog).monospacedDigit()
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 9))
    }
}

// MARK: - Fleet Growth

struct FleetGrowthView: View {
    let data: FleetGrowthData
    let size: WidgetSize
    /// The period the medium widget charts (7 or 30 days).
    var period = 7
    var stale = false

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.url("home"))
    }

    @ViewBuilder private var content: some View {
        switch size {
        case .medium: medium
        case .large: large
        default: small
        }
    }

    private var detail: String? { data.city == .all ? nil : data.city.title }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "chart.line.uptrend.xyaxis", title: "Fleet growth", detail: detail)
            Spacer(minLength: 4)
            WidgetNumber(value: data.total, size: 42)
            Text("registered").font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.mist)
            WidgetChange(change: data.change(days: 7), period: "in 7 days").padding(.top, 2)
            WidgetSparkline(values: data.series(days: 7).map(\.total), lineWidth: 1.6).frame(height: 22).padding(.top, 6)
        }
    }

    private var medium: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 0) {
                WidgetEyebrow(icon: "chart.line.uptrend.xyaxis", title: "Fleet growth", detail: detail)
                Spacer(minLength: 4)
                WidgetNumber(value: data.total, size: 40)
                Text("registered Cybercabs").font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.mist).lineLimit(1)
                WidgetChange(change: data.change(days: period), period: period == 30 ? "in 30 days" : "in 7 days").padding(.top, 3)
                Spacer(minLength: 4)
                WidgetFreshness(date: data.fetchedAt, stale: stale)
            }
            .frame(width: 138, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) {
                Text("LAST \(period) DAYS").font(ServiceFont.inter(9, .bold)).tracking(0.8).foregroundStyle(WidgetPalette.fog)
                WidgetSparkline(values: data.series(days: period).map(\.total))
                axis(data.series(days: period))
            }
        }
    }

    private var large: some View {
        let month = data.series(days: 30)
        return VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "chart.line.uptrend.xyaxis", title: "Fleet growth", detail: detail)
            HStack(alignment: .lastTextBaseline, spacing: 10) {
                WidgetNumber(value: data.total, size: 44)
                Text("registered").font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.mist)
                Spacer(minLength: 0)
            }
            .padding(.top, 6)
            HStack(spacing: 14) {
                WidgetChange(change: data.change(days: 7), period: "this week", size: 12)
                WidgetChange(change: data.change(days: 30), period: "in 30 days", size: 12)
            }
            .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("LAST 30 DAYS").font(ServiceFont.inter(9, .bold)).tracking(0.8).foregroundStyle(WidgetPalette.fog)
                    Spacer()
                    Text("\(month.first?.total.formatted() ?? "—") → \(month.last?.total.formatted() ?? "—")").font(ServiceFont.inter(10, .semibold)).foregroundStyle(WidgetPalette.fog).monospacedDigit()
                }
                WidgetSparkline(values: month.map(\.total), lineWidth: 2.2).frame(maxHeight: .infinity)
                axis(month)
            }
            .padding(.top, 10)
            if data.city == .all, let austin = data.austin, let dallas = data.dallas {
                Text("AUSTIN VS DALLAS").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog).padding(.top, 10)
                VStack(spacing: 5) {
                    split("Austin", austin, of: max(austin.total, dallas.total))
                    split("Dallas", dallas, of: max(austin.total, dallas.total))
                }
                .padding(.top, 5)
            }
            WidgetFreshness(date: data.fetchedAt, stale: stale).padding(.top, 8)
        }
    }

    private func axis(_ days: [FleetGrowthData.Day]) -> some View {
        HStack {
            Text(WidgetTime.day(days.first?.date) ?? "")
            Spacer()
            Text("Today")
        }
        .font(ServiceFont.inter(9, .medium)).foregroundStyle(WidgetPalette.fog)
    }

    private func split(_ name: String, _ c: FleetGrowthData.CitySplit, of top: Int) -> some View {
        HStack(spacing: 8) {
            Text(name).font(ServiceFont.inter(12, .bold)).foregroundStyle(WidgetPalette.ink).frame(width: 52, alignment: .leading)
            WidgetBar(progress: top > 0 ? Double(c.total) / Double(top) : 0, height: 6)
            Text(c.total.formatted()).font(ServiceFont.inter(12, .bold)).foregroundStyle(WidgetPalette.gold).monospacedDigit().frame(width: 42, alignment: .trailing)
            Text("+\(c.added30d) · 30d").font(ServiceFont.inter(10, .semibold)).foregroundStyle(c.added30d > 0 ? WidgetPalette.up : WidgetPalette.fog).monospacedDigit().frame(width: 62, alignment: .trailing)
        }
    }
}

// MARK: - Cybercab Milestones

struct MilestonesView: View {
    let data: MilestonesData
    let size: WidgetSize
    var stale = false

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.url("registry"))
    }

    @ViewBuilder private var content: some View {
        switch size {
        case .medium: medium
        case .large: large
        default: small
        }
    }

    private var percent: String { "\(Int((data.progress * 100).rounded(.down)))%" }

    private var small: some View {
        VStack(alignment: .leading, spacing: 5) {
            WidgetEyebrow(icon: "flag.checkered", title: "Milestone")
            ZStack {
                WidgetRing(progress: data.progress, lineWidth: 8)
                    .frame(width: 86, height: 86)
                VStack(spacing: 0) {
                    WidgetNumber(value: data.registered, size: 26)
                    Text("of \(data.next.formatted())").font(ServiceFont.inter(10.5, .semibold)).foregroundStyle(WidgetPalette.fog).monospacedDigit()
                }
            }
            .frame(maxWidth: .infinity)
            Text("\(data.remaining.formatted()) to go").font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.mist).monospacedDigit()
                .frame(maxWidth: .infinity)
        }
    }

    private var medium: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 0) {
                WidgetEyebrow(icon: "flag.checkered", title: "Next milestone")
                Spacer(minLength: 4)
                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    WidgetNumber(value: data.registered, size: 36)
                    Text("/ \(data.next.formatted())").font(ServiceFont.inter(18, .bold)).foregroundStyle(WidgetPalette.fog).monospacedDigit()
                }
                WidgetBar(progress: data.progress, height: 7).padding(.top, 6)
                HStack {
                    Text("\(data.remaining.formatted()) Cybercabs to go").foregroundStyle(WidgetPalette.mist)
                    Spacer()
                    Text(percent).foregroundStyle(WidgetPalette.gold)
                }
                .font(ServiceFont.inter(11, .semibold)).monospacedDigit().padding(.top, 5)
                Spacer(minLength: 4)
                WidgetFreshness(date: data.fetchedAt, stale: stale)
            }
            WidgetCar(width: 96)
        }
    }

    private var large: some View {
        let reached = Array(data.passed.reversed().prefix(4))
        let ahead = FleetMilestones.upcoming(after: data.registered, count: 4)
        return VStack(alignment: .leading, spacing: 0) {
            WidgetEyebrow(icon: "flag.checkered", title: "Cybercab milestones")
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    WidgetNumber(value: data.registered, size: 46)
                    Text("registered Cybercabs").font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.mist)
                }
                Spacer()
                ZStack {
                    WidgetRing(progress: data.progress, lineWidth: 7)
                    Text(percent).font(ServiceFont.inter(15, .bold)).foregroundStyle(WidgetPalette.gold).monospacedDigit()
                }
                .frame(width: 66, height: 66)
            }
            .padding(.top, 6)
            HStack {
                Text("Next: \(data.next.formatted())").foregroundStyle(WidgetPalette.ink)
                Spacer()
                Text("\(data.remaining.formatted()) to go").foregroundStyle(WidgetPalette.mist)
            }
            .font(ServiceFont.inter(12, .bold)).monospacedDigit().padding(.top, 10)
            WidgetBar(progress: data.progress, height: 7).padding(.top, 5)
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("ACHIEVED").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
                    if reached.isEmpty { Text("None yet").font(ServiceFont.inter(11.5, .medium)).foregroundStyle(WidgetPalette.fog) }
                    ForEach(reached, id: \.self) { m in
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(WidgetPalette.gold).widgetAccentable()
                            Text(m.formatted()).font(ServiceFont.inter(13, .bold)).foregroundStyle(WidgetPalette.ink).monospacedDigit()
                            Spacer(minLength: 0)
                            if let on = WidgetTime.day(data.reachedOn[String(m)]) { Text(on).font(ServiceFont.inter(10.5, .medium)).foregroundStyle(WidgetPalette.fog) }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Rectangle().fill(WidgetPalette.line).frame(width: 1)
                VStack(alignment: .leading, spacing: 6) {
                    Text("UPCOMING").font(ServiceFont.inter(9.5, .bold)).tracking(1).foregroundStyle(WidgetPalette.fog)
                    ForEach(ahead, id: \.self) { m in
                        HStack(spacing: 6) {
                            Image(systemName: "circle").font(.system(size: 12)).foregroundStyle(WidgetPalette.fog)
                            Text(m.formatted()).font(ServiceFont.inter(13, .bold)).foregroundStyle(WidgetPalette.mist).monospacedDigit()
                            Spacer(minLength: 0)
                            Text("\((m - data.registered).formatted()) to go").font(ServiceFont.inter(10.5, .medium)).foregroundStyle(WidgetPalette.fog).monospacedDigit()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 14)
            Spacer(minLength: 6)
            WidgetFreshness(date: data.fetchedAt, stale: stale)
        }
    }
}

// MARK: - Lock Screen Fleet Statistics

/// Circular, rectangular and inline: the registered fleet and its change. No
/// service countdown or LIVE NOW (that is the Live Activity's).
struct LockFleetView: View {
    let data: FleetStatsData
    let size: WidgetSize

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.url("registry"))
    }

    @ViewBuilder private var content: some View {
        switch size {
        case .circular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "car.side.fill").font(.system(size: 10, weight: .bold)).widgetAccentable()
                    Text(data.registered.formatted()).font(ServiceFont.inter(18, .bold)).monospacedDigit().minimumScaleFactor(0.5).lineLimit(1)
                    if let a = data.added7d, a > 0 {
                        Text("▲\(a)").font(ServiceFont.inter(9.5, .semibold)).monospacedDigit().widgetAccentable()
                    }
                }
                .padding(4)
            }
            .accessibilityLabel("\(data.registered) registered Cybercabs")
        case .inline:
            // One line, always (the system truncates anything longer).
            Group {
                if let t = data.addedToday, t > 0 {
                    Label("\(data.registered.formatted()) Cybercabs ▲\(t) today", systemImage: "car.side.fill")
                } else {
                    Label("\(data.registered.formatted()) Cybercabs", systemImage: "car.side.fill")
                }
            }
            .lineLimit(1)
        default:
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Image(systemName: "car.side.fill").font(.system(size: 10, weight: .bold))
                    Text("CYBERCABS").font(ServiceFont.inter(11, .bold)).tracking(0.6)
                }
                .widgetAccentable()
                Text("\(data.registered.formatted()) registered").font(ServiceFont.inter(17, .bold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                Text(data.added7d.map { $0 > 0 ? "+\($0) in the last 7 days" : "None added in 7 days" } ?? "7-day change unavailable")
                    .font(ServiceFont.inter(12, .medium)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Cybercab Daily (existing widget, restyled)

struct DailyWidgetView: View {
    let snapshot: FleetSnapshot
    let size: WidgetSize
    var stale = false
    var placeholder = false

    var body: some View {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: size.isAccessory ? .center : .topLeading).widgetURL(WidgetLink.url("sightings"))
    }

    @ViewBuilder private var content: some View {
        if size == .rectangular {
            VStack(alignment: .leading, spacing: 1) {
                Text("CYBERCAB DAILY").font(ServiceFont.inter(11, .bold)).tracking(0.6).widgetAccentable()
                Text("+\((snapshot.todayNewCybercabs ?? 0).formatted()) Cybercabs today").font(ServiceFont.inter(14, .bold)).monospacedDigit()
                Text("\((snapshot.todaySightings ?? 0).formatted()) sightings · \((snapshot.todayDetections ?? 0).formatted()) detections").font(ServiceFont.inter(12, .medium)).monospacedDigit()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                WidgetEyebrow(icon: "calendar", title: "Cybercab Daily")
                if snapshot.date == nil && !placeholder {
                    Spacer(minLength: 4)
                    Text("Today's report isn't in yet.").font(ServiceFont.inter(13, .semibold)).foregroundStyle(WidgetPalette.fog)
                    Spacer(minLength: 0)
                } else {
                    Spacer(minLength: 4)
                    HStack(alignment: .lastTextBaseline, spacing: 4) {
                        WidgetNumber(value: snapshot.todayNewCybercabs, size: 38)
                        Text("new").font(ServiceFont.inter(12, .semibold)).foregroundStyle(WidgetPalette.mist)
                    }
                    Text("Cybercabs today").font(ServiceFont.inter(11, .semibold)).foregroundStyle(WidgetPalette.mist)
                    Spacer(minLength: 6)
                    HStack(spacing: 12) {
                        WidgetStat(value: snapshot.todaySightings, label: "Sightings", size: 17)
                        WidgetStat(value: snapshot.todayDetections, label: "Detections", size: 17)
                    }
                }
                WidgetFreshness(date: snapshot.fetchedAt, stale: stale).padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
