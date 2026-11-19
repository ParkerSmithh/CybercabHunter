import Charts
import SwiftUI

struct FleetHistoryResponse: Decodable, Sendable {
    struct Day: Decodable, Sendable {
        let date: String
        let registry: Int?
        let cumulative: Int?
        let sightings: Int?
        init(from decoder: Decoder) throws {
            var row = try decoder.unkeyedContainer()
            date = try row.decode(String.self)
            registry = try row.decode(Int?.self)
            cumulative = try row.decode(Int?.self)
            sightings = try row.decode(Int?.self)
        }
    }
    let rows: [Day]
    let updatedAt: String
}

struct FareHistoryResponse: Decodable, Sendable {
    struct Fare: Decodable, Sendable {
        let n: Int
        let median: Double?
    }
    struct Week: Decodable, Sendable {
        let week: String
        let fare: Fare
        let perMile: Fare
    }
    struct Series: Decodable, Sendable { let weeks: [Week] }
    struct Range: Decodable, Sendable {
        let all: Series
        let cybercab: Series
        let modelY: Series
    }
    let minimum: Int
    let updatedAt: String
    let ranges: [String: Range]
}

enum TrackerHistoryKind: String, CaseIterable, Identifiable {
    case fleet, fares
    var id: String { rawValue }
    var title: String { self == .fleet ? "Fleet History" : "Fare History" }
}

struct TrackerHistoryView: View {
    struct Point: Identifiable {
        let id: String
        let value: Double?
    }
    let kind: TrackerHistoryKind
    @Environment(SessionStore.self) private var session
    @AppStorage(TrackerCity.storageKey) private var city = TrackerCity.austin
    @State private var range = "90d"
    @State private var fleet: PublicSnapshot<FleetHistoryResponse>?
    @State private var fares: PublicSnapshot<FareHistoryResponse>?
    @State private var failure = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Tracker city", selection: $city) {
                    ForEach(TrackerCity.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                Picker("Date range", selection: $range) {
                    Text("30 days").tag("30d")
                    Text("90 days").tag("90d")
                    Text("1 year").tag("1y")
                    Text("All time").tag("all")
                }
                if let fleet {
                    stamp(fleet.value.updatedAt, fleet.cached)
                    let count = ["30d": 30, "90d": 90, "1y": 365][range] ?? fleet.value.rows.count
                    let rows = fleet.value.rows.suffix(count)
                    graph("Registry fleet size", source: "Public registry approvals", points: rows.map { Point(id: $0.date, value: $0.registry.map(Double.init)) })
                    graph("Cumulative sightings", source: "Approved image sightings", points: rows.map { Point(id: $0.date, value: $0.cumulative.map(Double.init)) })
                    graph("Sightings per day", source: "Approved image sightings, by approval date", points: rows.map { Point(id: $0.date, value: $0.sightings.map(Double.init)) }, bars: true)
                } else if let fares, let selected = fares.value.ranges[range] {
                    stamp(fares.value.updatedAt, fares.cached)
                    Text("Approved receipts and completed-ride reports. At least \(fares.value.minimum) observations per week.").font(.footnote)
                    fareGraph("Median fare", selected.all.weeks, \.fare, minimum: fares.value.minimum)
                    fareGraph("Median fare per mile", selected.all.weeks, \.perMile, minimum: fares.value.minimum)
                    fareGraph("Cybercab median fare", selected.cybercab.weeks, \.fare, minimum: fares.value.minimum)
                    fareGraph("Model Y median fare", selected.modelY.weeks, \.fare, minimum: fares.value.minimum)
                } else if failure {
                    ContentUnavailableView("History unavailable", systemImage: "chart.xyaxis.line", description: Text("This summary isn’t available from the server yet."))
                } else {
                    ProgressView()
                }
            }
            .padding(16)
        }
        .appBackground()
        .navigationTitle(kind.title)
        .tint(.brandGold)
        .task(id: city) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        let scope = city
        fleet = nil
        fares = nil
        failure = false
        let query = [URLQueryItem(name: "city", value: scope.rawValue)]
        do {
            let cache = PublicSnapshotCache.shared
            switch kind {
            case .fleet:
                let loaded: PublicSnapshot<FleetHistoryResponse> = try await cache.load("/api/fleet-history", query: query, source: .fleet, api: session.api)
                if city == scope && !Task.isCancelled { fleet = loaded }
            case .fares:
                let loaded: PublicSnapshot<FareHistoryResponse> = try await cache.load("/api/fare-history", query: query, source: .fares, api: session.api)
                if city == scope && !Task.isCancelled { fares = loaded }
            }
        } catch {
            if city == scope && !Task.isCancelled { failure = true }
        }
    }

    private func stamp(_ value: String, _ cached: Bool) -> some View {
        Text("\(cached ? "Saved snapshot" : "Updated") · \(value.prefix(10))")
            .font(.footnote).foregroundStyle(.secondary)
    }

    private func fareGraph(_ title: String, _ weeks: [FareHistoryResponse.Week],
                           _ key: KeyPath<FareHistoryResponse.Week, FareHistoryResponse.Fare>, minimum: Int) -> some View {
        graph(title, source: "USD · approved observations", points: weeks.map {
            let fare = $0[keyPath: key]
            return Point(id: $0.week, value: fare.n >= minimum ? fare.median : nil)
        }, currency: true)
    }

    private func graph(_ title: String, source: String, points: [Point], bars: Bool = false, currency: Bool = false) -> some View {
        let available = points.filter { $0.value != nil }
        let last = available.last
        let value = last?.value.map { currency ? $0.formatted(.currency(code: "USD")) : $0.formatted() }
        let summary = value.map { "Latest recorded value \($0) on \(last?.id ?? "")." } ?? (currency ? "Insufficient data." : "No dated records in this range.")
        var segment = 0
        let segments = points.map { point -> Int in
            if point.value == nil { segment += 1 }
            return segment
        }
        return VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            Text(source).font(.footnote).foregroundStyle(.secondary)
            Text(summary).font(.footnote)
            if !available.isEmpty {
                Chart {
                    ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                        if let value = point.value {
                            if bars {
                                BarMark(x: .value("Day", index), y: .value(title, value))
                            } else {
                                LineMark(x: .value("Day", index), y: .value(title, value), series: .value("Continuous segment", segments[index]))
                                PointMark(x: .value("Day", index), y: .value(title, value)).symbolSize(6)
                            }
                        }
                    }
                }
                .chartXAxis(.hidden)
                .foregroundStyle(Color.brandGold)
                .frame(height: 130)
                .accessibilityLabel(title)
                .accessibilityValue(summary)
                if let first = points.first, let last = points.last {
                    HStack { Text(first.id); Spacer(); Text(last.id) }
                        .font(.caption).foregroundStyle(.secondary)
                }
                if available.count != points.count { Text("Some dates have no published value.").font(.caption) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}
