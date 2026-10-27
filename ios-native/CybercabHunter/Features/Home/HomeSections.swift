import SwiftUI
import Charts

// MARK: - Service Zones (the city's facts; the map itself is Phase 3)

struct ServiceZonesSection: View {
    @Bindable var model: HomeModel
    @Environment(AppRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                Text("SERVICE ZONES").displayTitle(22)
                Spacer()
                CityPicker(cities: model.areas, selection: $model.city)
            }
            if let d = model.cityStats[model.city], let a = d.area {
                Eyebrow(text: "Service area", accent: d.name)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    tile("Coverage", a.squareMiles.map { Format.int(Int($0)) } ?? "—", unit: "mi²",
                         note: (a.vehicles ?? 0) > 0 && (a.squareMiles ?? 0) > 0 ? "≈ \(Format.one(Double(a.vehicles!) / a.squareMiles! * 10)) vehicles per 10 mi²" : "No vehicles documented yet")
                    tile("In service since", Format.day(a.inServiceSince), note: daysOfService(a.inServiceSince))
                    tile("Vehicles documented", Format.int(a.vehicles),
                         note: (a.vehicles ?? 0) > 0 ? "+\(Format.int(a.vehiclesAdded7d ?? 0)) this week · \(Format.int(a.vehiclesAddedPrev7d ?? 0)) the week before" : "None in the registry yet")
                    tile("Service hours", a.hours.map { "\(Format.clock($0.open)) – \(Format.clock($0.close))" } ?? "—", note: hoursNote(a.hours))
                }
                if let text = a.description { Text(text).font(.inter(14)).foregroundStyle(Color.chFog) }
                Footnote(text: "Zone facts as published for the service area; vehicles from the public registry.")
                ZoneMiniMap(cityKey: model.city) { router.openZones(model.city) }
                AboutNumbers(text: "Coverage, launch date and hours are the published figures for the zone (the Zones page shows the same). Vehicles documented counts the public registry's Cybercabs in this city: its own city, or, with none set, where its counted rides were.")
            } else if let error = model.cityErrors[model.city] {
                InlineMessage(text: error, systemImage: "wifi.exclamationmark")
            } else {
                PanelSkeleton(height: 220)
            }
        }
    }

    private func tile(_ label: String, _ value: String, unit: String? = nil, note: String) -> some View {
        Metric(label: label, value: value, unit: unit, note: note, size: 20)
            .padding(12)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(Color.chSurface, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chLine))
    }

    private func daysOfService(_ since: String?) -> String {
        guard let start = Format.calendarDate(since) else { return "" }
        return "\(Format.int(max(0, Int(Date.now.timeIntervalSince(start) / 86400)))) days of service"
    }

    private func hoursNote(_ hours: HomepageStats.Hours?) -> String {
        guard let hours else { return "" }
        let span = (ServiceClock.minutes(hours.close) - ServiceClock.minutes(hours.open)) / 60
        return "\(span <= 0 ? span + 24 : span) hours a day · Central"
    }
}

// MARK: - Fleet growth

enum ChartRange: String, CaseIterable, Identifiable, CustomStringConvertible {
    case d90 = "90D", m6 = "6M", y1 = "1Y", all = "All"
    var id: String { rawValue }
    var description: String { rawValue }
    var days: Int? { switch self { case .d90: 90; case .m6: 182; case .y1: 365; case .all: nil } }
    var label: String { switch self { case .d90: "Last 90 days"; case .m6: "Last 6 months"; case .y1: "Last year"; case .all: "Since tracking began" } }
}

struct FleetGrowthSection: View {
    @Bindable var model: HomeModel
    @Environment(AppRouter.self) private var router
    @State private var range: ChartRange = .d90
    @State private var predict = false
    @State private var horizon: Horizon = .d30
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The timelapse (index.html "Timelapse"): idle, playing, paused or done.
    enum Play { case idle, playing, paused, done }
    @State private var play: Play = .idle
    @State private var playedBefore: Double = 0     // seconds played before the current run
    @State private var playStarted: Date?

    /// The forecast horizons (index.html data-fleet-horizon).
    enum Horizon: Int, CaseIterable, Identifiable, CustomStringConvertible {
        case d7 = 7, d30 = 30, d90 = 90
        var id: Int { rawValue }
        var description: String { "\(rawValue)D" }
    }

    struct Projected: Identifiable { let date: Date; let value: Int; let low: Int; let high: Int; var id: Date { date } }

    var body: some View {
        let city = model.cityName(model.city)
        let points = model.growth[city] ?? []
        let start = range.days.map { Date.now.addingTimeInterval(-Double($0) * 86400) }
        let visible = start.map { s in points.filter { $0.date >= s } } ?? points
        let total = points.last?.count ?? 0
        let before = start.map { s in points.last(where: { $0.date < s })?.count ?? 0 } ?? 0
        let week = total - (points.last(where: { $0.date < Date.now.addingTimeInterval(-7 * 86400) })?.count ?? 0)
        let forecast = predict ? Self.forecast(points, horizon: horizon.rawValue) : nil

        VStack(alignment: .leading, spacing: 12) {
            CompactHeading(title: "Fleet growth · Cybercab",
                           info: "\(city) Cybercabs documented in the registry, over time: each car counts from the day it was first documented (public registry coverage). " + (predict ? "Dashed: a projection with an 80% range — an estimate, not registrations." : "Turn on Predict for a projection.")) {
                SeeAllButton(title: "Cars") { router.selectedTab = .registry }
            }
            // Timespan and Actual / Predict in one row; the forecast horizon only when predicting.
            HStack(spacing: 8) {
                RangePicker(ranges: ChartRange.allCases, selection: $range)
                    .onChange(of: range) { stopPlay() }
                Spacer(minLength: 4)
                PredictToggle(on: $predict)
            }
            if predict {
                HStack(spacing: 8) {
                    Text("Horizon").font(.inter(12)).foregroundStyle(Color.chFog)
                    RangePicker(ranges: Horizon.allCases, selection: $horizon).accessibilityLabel("Forecast horizon")
                }
            }
            if !model.growthLoaded {
                if let error = model.errors["growth"] { InlineMessage(text: error, systemImage: "wifi.exclamationmark") } else { PanelSkeleton(height: 200) }
            } else if points.isEmpty {
                InlineMessage(text: "No \(city) Cybercabs in the registry yet.")
            } else {
                if case .ok(_, let current, let rate, _, _, let fp) = forecast, let end = fp.last {
                    let added = end.value - current
                    MetricGrid(columns: 4, rowSpacing: 10) {
                        Metric(label: "Now", value: Format.int(current), note: "\(city) Cybercabs", valueColor: .brandGold, size: 19)
                        Metric(label: "In \(horizon.rawValue) days", value: "≈\(Format.int(end.value))", note: "\(end.low)–\(end.high)", valueColor: .chInk, size: 19)
                        Metric(label: "Additions", value: "+\(Format.int(added))", note: String(format: "≈%.1f a day", rate), valueColor: .chOK, size: 19)
                        Metric(label: "Growth", value: current > 0 ? "+\(Int((Double(added) / Double(current) * 100).rounded()))%" : "—",
                               note: "by \(Date(timeIntervalSince1970: end.t / 1000).formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day()))", size: 19)
                    }
                    .accessibilityIdentifier("fleetForecastTiles")
                } else {
                    // The key number big (with the Cybercab), the rest in a tight row beside it.
                    HStack(alignment: .center, spacing: 12) {
                        HStack(alignment: .bottom, spacing: 4) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("IN THE REGISTRY").font(.inter(10, .semibold)).tracking(0.5).foregroundStyle(Color.chCaption)
                                    .lineLimit(1).fixedSize()
                                Text(Format.int(total)).statNumber(30, color: .brandGold).lineLimit(1).fixedSize()
                            }
                            Image("CommunityCybercab").resizable().scaledToFit().frame(width: 50).padding(.bottom, 2).accessibilityHidden(true)
                        }
                        .fixedSize()
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("fleetRegistryTile")
                        Rectangle().fill(Color.chInk.opacity(0.08)).frame(width: 1, height: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            statLine("+\(Format.int(total - before))", range.label.lowercased(), .chOK)
                            statLine("+\(Format.int(week))", "last 7 days", .chInk)
                            statLine(points.last.map { Format.ago($0.date) } ?? "—", "latest addition", .chInk)
                        }
                        Spacer(minLength: 0)
                    }
                }
                if case .unavailable(let reason) = forecast {
                    (Text("Predictions unavailable. ").fontWeight(.semibold) + Text(reason)).font(.inter(12)).foregroundStyle(Color.chMist)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.chSurface2, in: .rect(cornerRadius: 10))
                }
                let projected = playing ? [] : Self.projected(forecast)
                TimelineView(.animation(paused: play != .playing)) { tl in
                let cut = cutoff(visible, at: tl.date)
                let shown = cut.map { c in visible.filter { $0.date <= c } } ?? visible
                VStack(alignment: .leading, spacing: 6) {
                Chart {
                    ForEach(shown) { p in
                        AreaMark(x: .value("Date", p.date), y: .value("Cybercabs", p.count), series: .value("S", "actual"))
                            .interpolationMethod(.stepEnd)
                            .foregroundStyle(LinearGradient(colors: [Color.brandGold.opacity(0.35), Color.brandGold.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Date", p.date), y: .value("Cybercabs", p.count), series: .value("S", "actual"))
                            .interpolationMethod(.stepEnd)
                            .foregroundStyle(Color.brandGold)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                    }
                    if !projected.isEmpty {
                        RuleMark(x: .value("Today", Date.now))
                            .foregroundStyle(Color.chFog.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                            .annotation(position: .top, alignment: .leading) { Text("Today").font(.inter(9)).foregroundStyle(Color.chFog) }
                        ForEach(projected) { p in
                            AreaMark(x: .value("Date", p.date), yStart: .value("Low", p.low), yEnd: .value("High", p.high), series: .value("S", "band"))
                                .foregroundStyle(Color.brandGold.opacity(0.14))
                            LineMark(x: .value("Date", p.date), y: .value("Projected", p.value), series: .value("S", "projected"))
                                .foregroundStyle(Color.brandGold.opacity(0.75))
                                .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 4]))
                        }
                    }
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()).foregroundStyle(Color.chCaption) } }
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel().foregroundStyle(Color.chCaption) } }
                .chartXScale(domain: (visible.first?.date ?? .now)...max(visible.last?.date ?? .now, projected.last?.date ?? .now))
                .chartYScale(domain: 0...max(1, (projected.map(\.high).max() ?? 0), visible.map(\.count).max() ?? 0))
                .frame(height: 140)
                .accessibilityLabel(projected.isEmpty ? "Cumulative \(city) Cybercabs: \(total)" : "Cumulative \(city) Cybercabs: \(total), projected about \(projected.last!.value) in \(horizon.rawValue) days")
                .overlay(alignment: .bottomTrailing) { if !predict { playButton } }
                Chart(dailyAdditions(shown)) { d in
                    BarMark(x: .value("Day", d.day, unit: .day), y: .value("New", d.count)).foregroundStyle(Color.brandGold.opacity(0.65))
                }
                .chartXScale(domain: (visible.first?.date ?? .now)...(visible.last?.date ?? .now))
                .chartXAxis(.hidden).chartYAxis(.hidden)
                .frame(height: 22)
                .accessibilityLabel("New Cybercabs per day")
                if let c = cut, play == .playing || play == .paused {
                    // "N Cybercabs · date" while it plays.
                    let n = shown.last?.count ?? 0
                    (Text("\(n) Cybercab\(n == 1 ? "" : "s")").bold().foregroundStyle(Color.chInk)
                     + Text(" · " + c.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day().year())).foregroundStyle(Color.chFog))
                        .font(.inter(12.5))
                        .accessibilityIdentifier("fleetPlayReadout")
                }
                }
                .onChange(of: tl.date) { _, now in if play == .playing && progress(now) >= 1 { finishPlay() } }
                }
                if predict {
                    HowPredictionsWork(city: city, through: points.last?.date)
                }
            }
        }
        .dataPanel(padding: 14)
    }

    /// "+14 last 7 days": a value and what it covers, on one line.
    private func statLine(_ value: String, _ label: String, _ color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(value).font(.inter(14, .semibold)).monospacedDigit().foregroundStyle(color)
            Text(label).font(.inter(11.5)).foregroundStyle(Color.chFog).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Timelapse (index.html: 4 s for 90 days, 6 s for 6 months, 8 s otherwise; ease-in-out)

    private var playing: Bool { play == .playing || play == .paused }
    private var playSeconds: Double { switch range { case .d90: 4; case .m6: 6; case .y1, .all: 8 } }

    private func progress(_ now: Date) -> Double {
        let run = playStarted.map { now.timeIntervalSince($0) } ?? 0
        return min(1, (playedBefore + run) / playSeconds)
    }

    /// The last day drawn: the eased progress across the visible range (nil = the static full view).
    private func cutoff(_ visible: [HomeModel.GrowthPoint], at now: Date) -> Date? {
        guard playing, let a = visible.first?.date, let b = visible.last?.date else { return nil }
        let t = progress(now)
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        return a.addingTimeInterval(b.timeIntervalSince(a) * eased)
    }

    private var playButton: some View {
        let (icon, label): (String, String) = switch play {
        case .playing: ("pause.fill", "Pause fleet growth timelapse")
        case .paused: ("play.fill", "Resume fleet growth timelapse")
        case .done: ("arrow.counterclockwise", "Replay fleet growth timelapse")
        case .idle: ("play.fill", "Play fleet growth timelapse")
        }
        return Button(action: togglePlay) {
            HStack(spacing: 8) { Text("Timelapse"); Image(systemName: icon).font(.system(size: 11, weight: .bold)) }
                .font(.inter(12, .semibold))
                .foregroundStyle(Color(hex: 0x1A1204))
                .padding(.leading, 14).padding(.trailing, 12).frame(height: 32)
                .background(Color.brandGold, in: .capsule)
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .padding(.trailing, 4).padding(.bottom, 18)
        .accessibilityLabel(label)
        .accessibilityIdentifier("fleetPlayButton")
    }

    private func togglePlay() {
        switch play {
        case .playing:
            playedBefore += playStarted.map { Date.now.timeIntervalSince($0) } ?? 0
            playStarted = nil
            play = .paused
        case .paused:
            playStarted = .now; play = .playing
        case .idle, .done:
            // Reduced motion: straight to the finished view.
            if reduceMotion { play = .done; return }
            playedBefore = 0; playStarted = .now; play = .playing
        }
    }

    private func finishPlay() { play = .done; playStarted = nil; playedBefore = 0 }
    private func stopPlay() { play = .idle; playStarted = nil; playedBefore = 0 }

    private func modeButton(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button { withAnimation(.snappy) { action() } } label: {
            Text(title).font(.inter(12, .semibold)).padding(.horizontal, 12).frame(minHeight: 34)
                .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                .background(on ? Color.brandGold : Color.clear, in: .rect(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(on ? Color.clear : Color.chHair2))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// The registry series as the website feeds forecast.js: a zero the day
    /// before the first documented Cybercab, then each first_seen_at total.
    static func forecast(_ points: [HomeModel.GrowthPoint], horizon: Int) -> Forecast.Result {
        guard let first = points.first else { return Forecast.forecast([], horizonDays: horizon) }
        let obs = [Forecast.Observation(t: first.date.timeIntervalSince1970 * 1000 - Forecast.day, value: 0)]
            + points.map { Forecast.Observation(t: $0.date.timeIntervalSince1970 * 1000, value: Double($0.count)) }
        return Forecast.forecast(obs, horizonDays: horizon)
    }

    static func projected(_ result: Forecast.Result?) -> [Projected] {
        guard case .ok(let start, let current, _, _, _, let pts) = result else { return [] }
        return [Projected(date: Date(timeIntervalSince1970: start / 1000), value: current, low: current, high: current)]
            + pts.map { Projected(date: Date(timeIntervalSince1970: $0.t / 1000), value: $0.value, low: $0.low, high: $0.high) }
    }

    struct DayCount: Identifiable { let day: Date; let count: Int; var id: Date { day } }
    private func dailyAdditions(_ points: [HomeModel.GrowthPoint]) -> [DayCount] {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = Format.central
        return Dictionary(grouping: points, by: { cal.startOfDay(for: $0.date) })
            .map { DayCount(day: $0.key, count: $0.value.reduce(0) { $0 + $1.added }) }
            .sorted { $0.day < $1.day }
    }
}

/// "How predictions work", as the website explains it (index.html renderHow).
struct HowPredictionsWork: View {
    let city: String
    let through: Date?
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) { Text("How predictions work").font(.inter(12, .semibold)); Image(systemName: "chevron.down").font(.caption2).rotationEffect(.degrees(open ? 180 : 0)) }
                    .foregroundStyle(Color.brandGold)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    item("Data", "the date each \(city) Cybercab was first documented in Cybercab Hunter's public registry. Nothing else.")
                    item("Method", "daily additions (UTC days); one unusually big day is capped so a single batch can't set the pace; the 7-day, 30-day and all-time daily rates are blended 50/30/20, and the rate then eases toward the 30-day pace. Growth is projected in a straight line, never exponentially.")
                    item("Range", "the shaded band is an 80% range, based on how much the daily additions vary.")
                    item("Updated", "computed now from registry data through \(through.map { $0.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day().year()) } ?? "—"); it recalculates whenever new vehicles are documented.")
                    item("Why it can be wrong", "it only extends the past. Tesla's rollout plans, new cities, how often spotters document cars and registry clean-ups all change the real numbers. It counts vehicles we document, not Tesla's total built or deployed.")
                }
                .transition(.opacity)
            }
        }
    }
    private func item(_ title: String, _ text: String) -> some View {
        (Text("\(title): ").foregroundStyle(Color.chMist).fontWeight(.semibold) + Text(text).foregroundStyle(Color.chFog)).font(.inter(11))
    }
}

// MARK: - Texas DMV

struct DMVSection: View {
    let dmv: DMVRegistrations?
    private var latest: DMVRegistrations.LatestUpdate? { dmv?.latestUpdate }
    let error: String?
    @State private var range: DMVRange = .all
    @State private var predict = false
    @State private var horizon: FleetGrowthSection.Horizon = .d30

    /// Each model forecast from its own history (approximate imported points
    /// widen its range); the total is their sum (js/dmv-panel.js forecastFor).
    struct ModelForecast { let cybercab: Forecast.Result; let modelY: Forecast.Result }
    static func forecast(_ dmv: DMVRegistrations, horizon: Int) -> ModelForecast {
        func obs(_ key: KeyPath<DMVRegistrations.Point, Int>) -> [Forecast.Observation] {
            (dmv.series ?? []).compactMap { p in Format.calendarDate(p.date).map { _ in
                Forecast.Observation(t: ISO8601DateFormatter().date(from: p.date + "T00:00:00Z")!.timeIntervalSince1970 * 1000, value: Double(p[keyPath: key]), approx: p.approx ?? false) } }
        }
        return ModelForecast(cybercab: Forecast.forecast(obs(\.cybercab), horizonDays: horizon), modelY: Forecast.forecast(obs(\.modelY), horizonDays: horizon))
    }

    enum DMVRange: String, CaseIterable, Identifiable, CustomStringConvertible {
        case all = "All", w1 = "1W", m1 = "1M", d90 = "90D"
        var id: String { rawValue }
        var description: String { rawValue }
        var days: Int? { switch self { case .all: nil; case .w1: 7; case .m1: 30; case .d90: 90 } }
    }

    struct Line: Identifiable { let date: Date; let series: String; let value: Int; var id: String { "\(series)\(date)" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CompactHeading(title: "Texas DMV registrations · Tesla", info: dmvInfo)
            if let dmv, let snap = dmv.snapshot {
                let fc = predict ? Self.forecast(dmv, horizon: horizon.rawValue) : nil
                MetricGrid(columns: 3, rowSpacing: 10) {
                    Metric(label: "Registered AV fleet", value: Format.int(snap.total), note: "by VIN · polled \(Format.instant(snap.polledAt).map { Format.ago($0) } ?? "daily")", valueColor: .brandGold, size: 20)
                    Metric(label: "Last 30 days", value: "+\(Format.int(dmv.new?.d30 ?? 0))", note: "+\(Format.int(dmv.new?.d7 ?? 0)) in 7 days · approx.", valueColor: .chOK, size: 20)
                    Metric(label: "Matched plates", value: Format.int(dmv.matched?.count), note: "\(Format.int(dmv.matched?.spotted30d)) spotted in 30 days", size: 20)
                }
                // Cybercab and Model Y side by side.
                HStack(alignment: .top, spacing: 10) {
                    modelCard("Cybercab", value: snap.cybercab, total: snap.total, added: dmv.new?.cybercab30d, color: .brandGold, image: "CybercabRender", projected: fc.flatMap { Self.end($0.cybercab) })
                    modelCard("Model Y", value: snap.modelY, total: snap.total, added: dmv.new?.modelY30d, color: .chModelY, image: "ModelYRender", projected: fc.flatMap { Self.end($0.modelY) })
                }
                HStack(spacing: 8) {
                    RangePicker(ranges: DMVRange.allCases, selection: $range)
                    Spacer(minLength: 4)
                    PredictToggle(on: $predict)
                }
                if predict {
                    HStack(spacing: 8) {
                        Text("Horizon").font(.inter(12)).foregroundStyle(Color.chFog)
                        RangePicker(ranges: FleetGrowthSection.Horizon.allCases, selection: $horizon)
                    }
                }
                if let fc, case .unavailable(let reason) = fc.cybercab {
                    Text("Predictions unavailable. \(reason)").font(.inter(12)).foregroundStyle(Color.chMist)
                } else if let fc, case .unavailable(let reason) = fc.modelY {
                    Text("Predictions unavailable. \(reason)").font(.inter(12)).foregroundStyle(Color.chMist)
                }
                Chart {
                    ForEach(lines(dmv)) { p in
                        LineMark(x: .value("Date", p.date), y: .value("Vehicles", p.value), series: .value("Series", p.series))
                            .foregroundStyle(by: .value("Series", p.series))
                            .lineStyle(StrokeStyle(lineWidth: p.series == "Total" ? 1.5 : 2, dash: p.series == "Total" ? [3, 3] : []))
                            .interpolationMethod(.stepEnd)
                    }
                    ForEach(projections(fc)) { p in
                        LineMark(x: .value("Date", p.date), y: .value("Vehicles", p.value), series: .value("Series", p.series + " (projected)"))
                            .foregroundStyle(p.series == "Cybercab" ? Color.brandGold.opacity(0.7) : p.series == "Model Y" ? Color.chModelY.opacity(0.7) : Color.chMist.opacity(0.7))
                            .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    }
                    if fc != nil { RuleMark(x: .value("Today", Date.now)).foregroundStyle(Color.chFog.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3])) }
                }
                .chartForegroundStyleScale(["Cybercab": Color.brandGold, "Model Y": Color.chModelY, "Total": Color.chMist])
                .chartLegend(position: .top, alignment: .leading)
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated)).foregroundStyle(Color.chCaption) } }
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel().foregroundStyle(Color.chCaption) } }
                .frame(height: 140)
                if fc != nil { Footnote(text: "Dashed: projections — estimates, not registrations.") }
                // The website's gold "View DMV Tracker" button (js/dmv-panel.js): the latest update's new VINs when known.
                NavigationLink(value: ExploreRoute.dmv) {
                    HStack(spacing: 12) {
                        Image(systemName: "list.bullet.rectangle").font(.system(size: 18, weight: .semibold))
                            .frame(width: 40, height: 40).background(Color.black.opacity(0.12), in: .rect(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 1) {
                            Text("View DMV Tracker").font(.inter(16, .bold)).tracking(-0.3).lineLimit(1).minimumScaleFactor(0.85)
                            Text(latest.map { "+\(Format.int($0.added)) newly detected · \(Format.day($0.date, year: false))" } ?? "\(Format.int(snap.total)) VINs · from TxDMV").font(.inter(12, .semibold)).monospacedDigit().opacity(0.7)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.right").font(.system(size: 14, weight: .bold))
                            .frame(width: 32, height: 32).background(Color.black.opacity(0.14), in: .circle)
                    }
                    .foregroundStyle(Color(hex: 0x1A1204))
                    .padding(.leading, 12).padding(.trailing, 14).padding(.vertical, 9)
                    .background(LinearGradient(colors: [Color(hex: 0xF5D62A), .brandGold], startPoint: .leading, endPoint: .trailing), in: .rect(cornerRadius: 12))
                    .shadow(color: Color.brandGold.opacity(0.35), radius: 12, y: 6)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(latest.map { "View DMV Tracker, \(Format.int(snap.total)) tracked, \($0.added) newly detected in the latest update" } ?? "View DMV Tracker, \(Format.int(snap.total)) VINs from TxDMV")
                .accessibilityIdentifier("dmvEveryVin")
            } else if let error {
                InlineMessage(text: error, systemImage: "wifi.exclamationmark")
            } else {
                PanelSkeleton(height: 260)
            }
        }
        .dataPanel(padding: 14)
    }

    /// The section's source and method, behind its ⓘ.
    private var dmvInfo: String {
        var t = "Every automated vehicle Tesla lists with the state, polled daily from the TxDMV Motor Carrier Credentialing System (TxMCCS): every VIN Tesla Robotaxi, LLC lists under its SB 2807 automated-vehicle authorization."
        if let d = dmv?.trackingSince { t += " Before \(Format.day(d)), counts are approximate." }
        if predict { t += " Dashed lines: each model projected from its own history, the total as their sum, with the approximate early counts widening the range. Estimates, not registrations." }
        return t
    }

    private func lines(_ dmv: DMVRegistrations) -> [Line] {
        let start = range.days.map { Date.now.addingTimeInterval(-Double($0) * 86400) }
        return (dmv.series ?? []).compactMap { p -> [Line]? in
            guard let d = Format.calendarDate(p.date), start.map({ d >= $0 }) ?? true else { return nil }
            return [Line(date: d, series: "Cybercab", value: p.cybercab), Line(date: d, series: "Model Y", value: p.modelY), Line(date: d, series: "Total", value: p.total)]
        }.flatMap { $0 }
    }

    static func end(_ r: Forecast.Result) -> Forecast.Point? { if case .ok(_, _, _, _, _, let p) = r { return p.last } else { return nil } }

    /// Projected lines from today: Cybercab, Model Y and their sum.
    private func projections(_ fc: ModelForecast?) -> [Line] {
        guard let fc, case .ok(let s1, let c1, _, _, _, let p1) = fc.cybercab, case .ok(_, let c2, _, _, _, let p2) = fc.modelY else { return [] }
        let start = Date(timeIntervalSince1970: s1 / 1000)
        var out = [Line(date: start, series: "Cybercab", value: c1), Line(date: start, series: "Model Y", value: c2), Line(date: start, series: "Total", value: c1 + c2)]
        for (a, b) in zip(p1, p2) {
            let d = Date(timeIntervalSince1970: a.t / 1000)
            out += [Line(date: d, series: "Cybercab", value: a.value), Line(date: d, series: "Model Y", value: b.value), Line(date: d, series: "Total", value: a.value + b.value)]
        }
        return out
    }

    /// One model, half width: name, count, share bar, 30-day additions, projection; the car in the corner.
    private func modelCard(_ name: String, value: Int, total: Int, added: Int?, color: Color, image: String, projected: Forecast.Point? = nil) -> some View {
        let share = total > 0 ? Double(value) / Double(total) : 0
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) { Circle().fill(color).frame(width: 7, height: 7); Text(name.uppercased()).font(.inter(10, .bold)).tracking(1).foregroundStyle(color) }
            Text(Format.int(value)).statNumber(22)
            Text("\(Int((share * 100).rounded()))% of the fleet").font(.inter(10.5)).foregroundStyle(Color.chFog)
            GeometryReader { g in
                Capsule().fill(Color.chSmoke).overlay(alignment: .leading) { Capsule().fill(color).frame(width: g.size.width * share) }
            }
            .frame(height: 4)
            if let added { Text("+\(Format.int(added)) in 30 days").font(.inter(10, .medium)).foregroundStyle(Color.chOK).lineLimit(1).minimumScaleFactor(0.85) }
            if let projected { Text("≈\(Format.int(projected.value)) in \(horizon.rawValue)d (\(projected.low)–\(projected.high))").font(.inter(10, .medium)).foregroundStyle(Color.chMist).lineLimit(1).minimumScaleFactor(0.8) }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .overlay(alignment: .topTrailing) {
            Image(image).resizable().scaledToFit().frame(width: 62).padding(.top, 8).padding(.trailing, 6).accessibilityHidden(true)
        }
        .background(color.opacity(0.06), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(color.opacity(0.4)))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Ride stats and sightings activity (per city)

struct CityRowsSection: View {
    @Bindable var model: HomeModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("CITY DETAILS").displayTitle(18)
                Spacer()
                CityPicker(cities: model.areas, selection: $model.city)
            }
            if let d = model.cityStats[model.city] {
                RideStatsPanel(d: d)
                SightingsActivityPanel(d: d)
            } else if let error = model.cityErrors[model.city] {
                InlineMessage(text: error, systemImage: "wifi.exclamationmark")
            } else {
                PanelSkeleton(height: 260)
            }
        }
    }
}

private struct RideStatsPanel: View {
    let d: HomepageStats
    @Environment(AppRouter.self) private var router
    @State private var range: ChartRange = .d90

    var body: some View {
        let r = d.rides
        let has = (r?.rides ?? 0) > 0
        VStack(alignment: .leading, spacing: 12) {
            CompactHeading(city: d.name, title: "Ride stats",
                           info: "From contributed ride receipts. Counted rides only: accepted receipts (pending or approved), never ones under review or rejected, and a ride two riders shared counts once. Rides on a private vehicle are left out. The average fare is the mean per ride; per mile is all fares divided by all miles, so one short ride can't skew it.")
            if !has { Text("No contributed ride receipts in \(d.name) yet.").font(.inter(13)).foregroundStyle(Color.chFog) }
            MetricGrid(rowSpacing: 12) {
                Metric(label: "Rides", value: has ? Format.int(r?.rides) : "—", note: has ? "\(Format.int(r?.rides30d)) in the last 30 days" : "No receipts yet", valueColor: .brandGold, size: 19)
                Metric(label: "Miles", value: has ? Format.one(r?.miles) : "—", note: has ? "Across \(Format.plural(r?.rides ?? 0, "ride", "rides"))" : nil, size: 19)
                Metric(label: "Avg fare", value: Format.money(r?.averageFare), note: r?.medianFare.map { "Median \(Format.money($0)) · \(Format.plural(r?.fareRides ?? 0, "ride", "rides"))" }, size: 19)
                Metric(label: "Per mile", value: Format.money(r?.perMile), note: r?.perMile != nil ? "Total fares ÷ total miles" : nil, size: 19)
                Metric(label: "Avg trip", value: Format.one(r?.averageMiles), unit: r?.averageMiles != nil ? "mi" : nil, note: r?.longestMiles.map { "Longest \(Format.one($0)) mi" }, size: 19)
                Metric(label: "Avg duration", value: Format.one(r?.averageMinutes), unit: r?.averageMinutes != nil ? "min" : nil, note: (r?.minutesRides ?? 0) > 0 ? "From \(Format.plural(r?.minutesRides ?? 0, "ride", "rides")) with a time" : nil, size: 19)
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            HStack {
                GroupLabel(text: "Weekly average fare")
                Spacer()
                RangePicker(ranges: ChartRange.allCases, selection: $range)
            }
            let weeks = (r?.weeklyFares ?? []).compactMap { w -> (Date, HomepageStats.WeeklyFare)? in
                guard let d = Format.calendarDate(w.week), range.days.map({ d >= Date.now.addingTimeInterval(-Double($0) * 86400) }) ?? true else { return nil }
                return (d, w)
            }
            if weeks.isEmpty {
                InlineMessage(text: "No fares in this range.")
            } else {
                Chart(weeks, id: \.1.week) { item in
                    RuleMark(x: .value("Week", item.0, unit: .weekOfYear), yStart: .value("Fare", 0), yEnd: .value("Fare", item.1.averageFare))
                        .foregroundStyle(Color.brandGold.opacity(0.7)).lineStyle(StrokeStyle(lineWidth: 2))
                    PointMark(x: .value("Week", item.0, unit: .weekOfYear), y: .value("Fare", item.1.averageFare))
                        .foregroundStyle(Color.brandGold).symbolSize(60)
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()).foregroundStyle(Color.chCaption) } }
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel { if let n = v.as(Double.self) { Text("$\(Int(n))") } }.foregroundStyle(Color.chCaption) } }
                .frame(height: 110)
                .accessibilityLabel("Weekly average fare")
            }
        }
        .dataPanel(padding: 14)
    }
}

private struct SightingsActivityPanel: View {
    let d: HomepageStats
    @Environment(AppRouter.self) private var router
    @State private var range: SightRange = .m1

    enum SightRange: String, CaseIterable, Identifiable, CustomStringConvertible {
        case all = "All", w1 = "1W", m1 = "1M", d90 = "90D"
        var id: String { rawValue }
        var description: String { rawValue }
        var days: Int? { switch self { case .all: nil; case .w1: 7; case .m1: 30; case .d90: 90 } }
    }

    var body: some View {
        let s = d.sightings
        let c = d.cameras
        let has = (s?.total ?? 0) > 0
        VStack(alignment: .leading, spacing: 12) {
            CompactHeading(city: d.name, title: "Sightings activity",
                           info: "Approved photo sightings only, by when the Cybercab was spotted; pending and rejected ones never count, and the busiest hour needs a clear peak (at least two sightings in that hour, no tie). Camera detections are automated and experimental, and kept separate from human sightings. Dates in Central Time.") {
                SeeAllButton { router.selectedTab = .sightings }
            }
            LiveBadge(updated: Format.instant(d.generatedAt))
            GroupLabel(text: "Approved sightings")
            MetricGrid(columns: 2, rowSpacing: 10) {
                Metric(label: "Last 24 hours", value: has ? Format.int(s?.last24h) : "—", note: has ? Format.delta(s?.last24h, s?.prev24h, "previous 24 h") : "No sightings yet", valueColor: .brandGold, size: 19)
                Metric(label: "Last 7 days", value: has ? Format.int(s?.last7Days) : "—", note: has ? Format.delta(s?.last7Days, s?.prev7Days, "prior 7 days", percent: true) : nil, size: 19)
                Metric(label: "Busiest hour", value: s?.peakHour.map { Format.hourLabel($0.hour) } ?? "—", note: s?.peakHour.map { "\(Format.plural($0.count, "sighting", "sightings")) at that hour" } ?? (has ? "Not enough data yet" : nil), size: 19)
                Metric(label: "All approved", value: has ? Format.int(s?.total) : "—", note: s?.firstDay.map { "Since \(Format.day($0, year: false))" }, size: 19)
            }
            GroupLabel(text: "Camera detections")
            MetricGrid(columns: 2, rowSpacing: 10) {
                Metric(label: "Cameras monitored", value: Format.int(c?.monitored), note: c?.reporting24h.map { "\(Format.int($0)) reported in the last 24 h" }, size: 19)
                Metric(label: "Detections · 24 h", value: Format.int(c?.detections24h), note: Format.delta(c?.detections24h, c?.prev24h, "previous 24 h"), size: 19)
                Metric(label: "Last detection", value: Format.instant(c?.lastDetectionAt).map { Format.ago($0) } ?? "—", note: c?.lastDetectionAt == nil ? "None yet" : [c?.lastCamera, Format.dateTime(Format.instant(c?.lastDetectionAt))].compactMap { $0 }.joined(separator: " · "), size: 19)
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            HStack {
                GroupLabel(text: "Daily sightings")
                Spacer()
                RangePicker(ranges: SightRange.allCases, selection: $range)
            }
            let days = (s?.daily ?? []).compactMap { p -> (Date, Int)? in
                guard let d = Format.calendarDate(p.date), range.days.map({ d >= Date.now.addingTimeInterval(-Double($0) * 86400) }) ?? true else { return nil }
                return (d, p.count)
            }
            Chart(days, id: \.0) { item in
                AreaMark(x: .value("Day", item.0), y: .value("Sightings", item.1))
                    .interpolationMethod(.stepCenter)
                    .foregroundStyle(LinearGradient(colors: [Color.brandGold.opacity(0.25), .clear], startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Day", item.0), y: .value("Sightings", item.1))
                    .interpolationMethod(.stepCenter)
                    .foregroundStyle(Color.brandGold)
            }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()).foregroundStyle(Color.chCaption) } }
            .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel().foregroundStyle(Color.chCaption) } }
            .frame(height: 110)
            .accessibilityLabel("Daily approved sightings in \(d.name)")

            VStack(alignment: .leading, spacing: 6) {
                GroupLabel(text: "Top spots")
                if let spots = s?.topSpots, !spots.isEmpty {
                    ForEach(Array(spots.enumerated()), id: \.element.id) { i, spot in
                        HStack {
                            Text("\(i + 1)").font(.inter(12.5)).foregroundStyle(Color.chCaption).frame(width: 16, alignment: .leading)
                            Text(spot.location).font(.inter(13.5)).foregroundStyle(Color.chMist).lineLimit(1)
                            Spacer()
                            Text(Format.plural(spot.count, "sighting", "sightings")).font(.inter(12.5)).monospacedDigit().foregroundStyle(Color.chFog)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } else {
                    InlineMessage(text: "No sighting locations yet.")
                }
            }
            .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    GroupLabel(text: "Latest sightings")
                    Spacer()
                    SeeAllButton { router.selectedTab = .sightings }
                }
                if let latest = s?.latest, !latest.isEmpty {
                    // The three newest on Home; See all opens every sighting.
                    ForEach(latest.prefix(3)) { x in LatestSightingRow(x: x, cityName: d.name) }
                } else {
                    InlineMessage(text: "No approved sightings in \(d.name) yet.")
                }
            }
            .padding(.top, 2)
        }
        .dataPanel(padding: 14)
    }
}

private struct LatestSightingRow: View {
    let x: HomepageStats.LatestSighting
    let cityName: String
    var body: some View {
        let spotted = Format.instant(x.spottedAt)
        HStack(spacing: 12) {
            AsyncImage(url: x.imageURL, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
                if let image = phase.image { image.resizable().scaledToFill() } else { Color.chSurface2 }
            }
            .frame(width: 52, height: 36)
            .clipShape(.rect(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.chLine))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Cybercab seen \(x.location.map { "at \($0)" } ?? "in \(x.city ?? cityName)")").font(.inter(13)).foregroundStyle(Color.chInk).lineLimit(1)
                Text([x.plate, Format.dateTime(spotted, zone: x.timeZone)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).font(.inter(11)).foregroundStyle(Color.chCaption).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(spotted.map { Format.ago($0) } ?? "").font(.inter(12)).monospacedDigit().foregroundStyle(Color.chFog)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}


/// The site's small segmented pill (Actual / Actual + Predictions).
struct PillButtonStyle: ButtonStyle {
    let on: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.inter(12, .semibold)).padding(.horizontal, 12).frame(minHeight: 34)
            .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
            .background(on ? Color.brandGold : Color.clear, in: .rect(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(on ? Color.clear : Color.chHair2))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}


/// The homepage minimap: the city's published zone on a small MapKit map;
/// tapping it (or "Explore map") opens Zones on that city, natively.
struct ZoneMiniMap: View {
    let cityKey: String
    let open: () -> Void
    var body: some View {
        let city = WebData.city(cityKey)
        ZStack(alignment: .topLeading) {
                ZoneMapView(cityKey: cityKey, showsMarkers: false, interactive: false,
                            framePadding: UIEdgeInsets(top: 70, left: 24, bottom: 54, right: 24))
                    .allowsHitTesting(false)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(city.name.uppercased()) MINIMAP").font(.inter(12, .bold)).tracking(0.8).foregroundStyle(Color.chInk)
                    Text("Published service zone").font(.inter(10)).foregroundStyle(Color.chFog)
                }
                .padding(12).padding(.bottom, 14)
                // A scrim so the heading never sits on top of the map's own labels.
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(LinearGradient(colors: [Color.chSurface, Color.chSurface.opacity(0.85), .clear], startPoint: .top, endPoint: .bottom))
                // Trailing, so the Apple Maps logo and Legal link (bottom leading) stay visible.
                HStack(spacing: 6) { Text("Explore map"); Image(systemName: "arrow.right") }
                    .font(.inter(12, .semibold)).foregroundStyle(Color.brandGold)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: .capsule)
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
            // The website's phone card: height = 0.92 × width (home-overview.css), so the
            // zone fills the card as it does there, on every iPhone width.
            .aspectRatio(1 / 0.92, contentMode: .fit)
            .clipShape(.rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
            .contentShape(.rect(cornerRadius: 14))
            .onTapGesture(perform: open)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default, open)
        .accessibilityLabel("\(city.name) service zone map. Opens Zones.")
        .accessibilityIdentifier("zoneMiniMap")
    }
}
