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

        VStack(alignment: .leading, spacing: 14) {
            PanelHeading(city: nil, title: "Fleet growth · \(city)") {
                SeeAllButton(title: "View Cybercabs") { router.selectedTab = .registry }
            }
            Text("\(city) Cybercabs documented in the registry, over time").font(.inter(12)).foregroundStyle(Color.chFog)
            RangePicker(ranges: ChartRange.allCases, selection: $range)
            HStack(spacing: 8) {
                modeButton("Actual", on: !predict) { predict = false }
                modeButton("Actual + Predictions", on: predict) { predict = true }
                if predict {
                    Spacer(minLength: 4)
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
                    MetricGrid(columns: 2) {
                        Metric(label: "Current documented fleet", value: Format.int(current), note: "\(city) Cybercabs", valueColor: .brandGold, size: 26)
                        Metric(label: "Projected in \(horizon.rawValue) days", value: "≈\(Format.int(end.value))", note: "Range \(end.low)–\(end.high)", valueColor: .chInk)
                        Metric(label: "Expected additions", value: "+\(Format.int(added))", note: String(format: "≈%.1f a day now", rate), valueColor: .chOK)
                        Metric(label: "Predicted growth", value: current > 0 ? "+\(Int((Double(added) / Double(current) * 100).rounded()))%" : "—",
                               note: "by \(Date(timeIntervalSince1970: end.t / 1000).formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day()))")
                    }
                    .accessibilityIdentifier("fleetForecastTiles")
                } else {
                    MetricGrid(columns: 2) {
                        Metric(label: "In the registry", value: Format.int(total), valueColor: .brandGold, size: 28)
                        Metric(label: range.label, value: "+\(Format.int(total - before))", note: "Up from \(Format.int(before))", valueColor: .chOK)
                        Metric(label: "Last 7 days", value: "+\(Format.int(week))", note: "vehicles added")
                        Metric(label: "Latest addition", value: points.last.map { Format.ago($0.date) } ?? "—", note: points.last.map { $0.date.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day()) })
                    }
                }
                if case .unavailable(let reason) = forecast {
                    (Text("Predictions unavailable. ").fontWeight(.semibold) + Text(reason)).font(.inter(12)).foregroundStyle(Color.chMist)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.chSurface2, in: .rect(cornerRadius: 10))
                }
                let projected = Self.projected(forecast)
                Chart {
                    ForEach(visible) { p in
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
                .frame(height: 190)
                .accessibilityLabel(projected.isEmpty ? "Cumulative \(city) Cybercabs: \(total)" : "Cumulative \(city) Cybercabs: \(total), projected about \(projected.last!.value) in \(horizon.rawValue) days")
                Chart(dailyAdditions(visible)) { d in
                    BarMark(x: .value("Day", d.day, unit: .day), y: .value("New", d.count)).foregroundStyle(Color.brandGold.opacity(0.65))
                }
                .chartXAxis(.hidden).chartYAxis(.hidden)
                .frame(height: 36)
                .accessibilityLabel("New Cybercabs per day")
                Footnote(text: predict ? "Actual: first documented Cybercabs. Dashed: projection with an 80% range — an estimate, not registrations." : "First documented Cybercabs · public registry coverage")
                if predict {
                    HowPredictionsWork(city: city, through: points.last?.date)
                }
            }
        }
        .dataPanel()
    }

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
        VStack(alignment: .leading, spacing: 14) {
            PanelHeading(city: nil, title: "Texas DMV registrations · Tesla")
            Text("Every automated vehicle Tesla lists with the state").font(.inter(12)).foregroundStyle(Color.chFog)
            if let dmv, let snap = dmv.snapshot {
                RangePicker(ranges: DMVRange.allCases, selection: $range)
                HStack(spacing: 8) {
                    Button("Actual") { withAnimation(.snappy) { predict = false } }.buttonStyle(PillButtonStyle(on: !predict))
                    Button("Actual + Predictions") { withAnimation(.snappy) { predict = true } }.buttonStyle(PillButtonStyle(on: predict))
                    if predict { Spacer(minLength: 4); RangePicker(ranges: FleetGrowthSection.Horizon.allCases, selection: $horizon) }
                }
                let fc = predict ? Self.forecast(dmv, horizon: horizon.rawValue) : nil
                MetricGrid(columns: 3) {
                    Metric(label: "Registered AV fleet", value: Format.int(snap.total), note: "by VIN · polled \(Format.instant(snap.polledAt).map { Format.ago($0) } ?? "daily")", valueColor: .brandGold)
                    Metric(label: "Last 30 days", value: "+\(Format.int(dmv.new?.d30 ?? 0))", note: "+\(Format.int(dmv.new?.d7 ?? 0)) in the last 7 days · approx.", valueColor: .chOK)
                    Metric(label: "Matched to tracked plates", value: Format.int(dmv.matched?.count), note: "\(Format.int(dmv.matched?.spotted30d)) spotted in the last 30 days")
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
                .frame(height: 200)
                modelCard("Cybercab", value: snap.cybercab, total: snap.total, added: dmv.new?.cybercab30d, color: .brandGold, image: "CybercabRender", projected: fc.flatMap { Self.end($0.cybercab) })
                modelCard("Model Y", value: snap.modelY, total: snap.total, added: dmv.new?.modelY30d, color: .chModelY, image: "ModelYRender", projected: fc.flatMap { Self.end($0.modelY) })
                if fc != nil { Footnote(text: "Dashed: each model projected from its own history, the total as their sum, with the approximate early counts widening the range. Estimates, not registrations.") }
                Footnote(text: "Polled daily from the TxDMV Motor Carrier Credentialing System (TxMCCS): every VIN Tesla Robotaxi, LLC lists under its SB 2807 automated-vehicle authorization. Before \(Format.day(dmv.trackingSince)), counts are approximate.")
            } else if let error {
                InlineMessage(text: error, systemImage: "wifi.exclamationmark")
            } else {
                PanelSkeleton(height: 260)
            }
        }
        .dataPanel()
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

    private func modelCard(_ name: String, value: Int, total: Int, added: Int?, color: Color, image: String, projected: Forecast.Point? = nil) -> some View {
        let share = total > 0 ? Double(value) / Double(total) : 0
        return HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) { Circle().fill(color).frame(width: 7, height: 7); Text(name.uppercased()).font(.inter(10, .bold)).tracking(1.2).foregroundStyle(color) }
                Text(Format.int(value)).statNumber(26)
                Text("\(Int((share * 100).rounded()))% of the fleet").font(.inter(11)).foregroundStyle(Color.chFog)
                Capsule().fill(Color.chSmoke).frame(width: 110, height: 4).overlay(alignment: .leading) { Capsule().fill(color).frame(width: 110 * share, height: 4) }
                if let added { Text("+\(Format.int(added)) in 30 days (approx.)").font(.inter(10, .medium)).foregroundStyle(Color.chOK) }
                if let projected { Text("≈\(Format.int(projected.value)) in \(horizon.rawValue) days (\(projected.low)–\(projected.high))").font(.inter(10, .medium)).foregroundStyle(Color.chMist) }
            }
            Spacer(minLength: 0)
            Image(image).resizable().scaledToFit().frame(width: 130).accessibilityHidden(true)
        }
        .padding(14)
        .background(color.opacity(0.06), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(color.opacity(0.45)))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Ride stats and sightings activity (per city)

struct CityRowsSection: View {
    @Bindable var model: HomeModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
        VStack(alignment: .leading, spacing: 18) {
            PanelHeading(city: d.name, title: "Ride stats")
            if !has { Text("No contributed ride receipts in \(d.name) yet.").font(.inter(13)).foregroundStyle(Color.chFog) }
            MetricGrid {
                Metric(label: "Rides", value: has ? Format.int(r?.rides) : "—", note: has ? "\(Format.int(r?.rides30d)) in the last 30 days" : "No receipts yet", valueColor: .brandGold)
                Metric(label: "Miles", value: has ? Format.one(r?.miles) : "—", note: has ? "Across \(Format.plural(r?.rides ?? 0, "ride", "rides"))" : nil)
                Metric(label: "Avg fare", value: Format.money(r?.averageFare), note: r?.medianFare.map { "Median \(Format.money($0)) · \(Format.plural(r?.fareRides ?? 0, "ride", "rides"))" })
                Metric(label: "Per mile", value: Format.money(r?.perMile), note: r?.perMile != nil ? "Total fares ÷ total miles" : nil)
                Metric(label: "Avg trip", value: Format.one(r?.averageMiles), unit: r?.averageMiles != nil ? "mi" : nil, note: r?.longestMiles.map { "Longest \(Format.one($0)) mi" })
                Metric(label: "Avg duration", value: Format.one(r?.averageMinutes), unit: r?.averageMinutes != nil ? "min" : nil, note: (r?.minutesRides ?? 0) > 0 ? "From \(Format.plural(r?.minutesRides ?? 0, "ride", "rides")) with a time" : nil)
            }
            Footnote(text: "From contributed ride receipts.")
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            HStack {
                Text("WEEKLY AVERAGE FARE").font(.inter(11, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
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
                .frame(height: 150)
                .accessibilityLabel("Weekly average fare")
            }
            AboutNumbers(text: "Counted rides only: accepted receipts (pending or approved), never ones under review or rejected, and a ride two riders shared counts once. Rides on a private vehicle are left out. The average fare is the mean per ride; per mile is all fares divided by all miles, so one short ride can't skew it.")
        }
        .dataPanel()
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
        VStack(alignment: .leading, spacing: 18) {
            PanelHeading(city: d.name, title: "Sightings activity", badge: AnyView(LiveBadge(updated: Format.instant(d.generatedAt)))) {
                SeeAllButton { router.selectedTab = .sightings }
            }
            Text("APPROVED SIGHTINGS").font(.inter(11, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
            MetricGrid(columns: 2) {
                Metric(label: "Last 24 hours", value: has ? Format.int(s?.last24h) : "—", note: has ? Format.delta(s?.last24h, s?.prev24h, "previous 24 h") : "No sightings yet", valueColor: .brandGold)
                Metric(label: "Last 7 days", value: has ? Format.int(s?.last7Days) : "—", note: has ? Format.delta(s?.last7Days, s?.prev7Days, "prior 7 days", percent: true) : nil)
                Metric(label: "Busiest hour", value: s?.peakHour.map { Format.hourLabel($0.hour) } ?? "—", note: s?.peakHour.map { "\(Format.plural($0.count, "sighting", "sightings")) at that hour" } ?? (has ? "Not enough data yet" : nil))
                Metric(label: "All approved", value: has ? Format.int(s?.total) : "—", note: s?.firstDay.map { "Since \(Format.day($0, year: false))" })
            }
            Footnote(text: "From approved sightings.")
            Text("CAMERA DETECTIONS").font(.inter(11, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
            MetricGrid {
                Metric(label: "Cameras monitored", value: Format.int(c?.monitored), note: c?.reporting24h.map { "\(Format.int($0)) reported in the last 24 h" })
                Metric(label: "Detections · 24 h", value: Format.int(c?.detections24h), note: Format.delta(c?.detections24h, c?.prev24h, "previous 24 h"))
                Metric(label: "Last detection", value: Format.instant(c?.lastDetectionAt).map { Format.ago($0) } ?? "—", note: c?.lastDetectionAt == nil ? "None yet" : [c?.lastCamera, Format.dateTime(Format.instant(c?.lastDetectionAt))].compactMap { $0 }.joined(separator: " · "))
            }
            Footnote(text: "From automated camera detections — separate from the human sightings above.")
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            HStack {
                Text("DAILY SIGHTINGS").font(.inter(11, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
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
            .frame(height: 160)
            .accessibilityLabel("Daily approved sightings in \(d.name)")
            Footnote(text: "Approved photo sightings in \(d.name) · dates in Central Time.")

            VStack(alignment: .leading, spacing: 10) {
                Text("TOP SPOTS").font(.inter(11, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
                if let spots = s?.topSpots, !spots.isEmpty {
                    ForEach(Array(spots.enumerated()), id: \.element.id) { i, spot in
                        HStack {
                            Text("\(i + 1)").font(.inter(13)).foregroundStyle(Color.chCaption).frame(width: 18, alignment: .leading)
                            Text(spot.location).font(.inter(14)).foregroundStyle(Color.chMist).lineLimit(1)
                            Spacer()
                            Text(Format.plural(spot.count, "sighting", "sightings")).font(.inter(13)).monospacedDigit().foregroundStyle(Color.chFog)
                        }
                    }
                } else {
                    InlineMessage(text: "No sighting locations yet.")
                }
            }
            .glassCard(padding: 14, radius: 12)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("LATEST SIGHTINGS").font(.inter(11, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
                    Spacer()
                    SeeAllButton { router.selectedTab = .sightings }
                }
                if let latest = s?.latest, !latest.isEmpty {
                    ForEach(latest) { x in LatestSightingRow(x: x, cityName: d.name) }
                } else {
                    InlineMessage(text: "No approved sightings in \(d.name) yet.")
                }
            }
            .glassCard(padding: 14, radius: 12)
            AboutNumbers(text: "Sightings are approved photo sightings only, by when the Cybercab was spotted; pending and rejected ones never count, and the busiest hour needs a clear peak (at least two sightings in that hour, no tie). The camera check is automated and experimental, and kept separate from human sightings.")
        }
        .dataPanel()
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
            .frame(width: 56, height: 40)
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
        .padding(.vertical, 8)
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
                ZoneMapView(cityKey: cityKey, showsMarkers: false, interactive: false)
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
            .frame(height: 210)
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
