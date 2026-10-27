import AppIntents
import Foundation
import SwiftUI

/// Calendar periods use Central time. A calendar week starts Monday; it is
/// deliberately distinct from the rolling seven-day count supplied by the API.
enum ActivityPeriod: String, AppEnum, CaseIterable {
    case allTime, today, yesterday, thisWeek, last7Days, last24Hours
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Activity period"
    static let caseDisplayRepresentations: [ActivityPeriod: DisplayRepresentation] = [
        .allTime: "All time", .today: "Today", .yesterday: "Yesterday",
        .thisWeek: "This week", .last7Days: "Last seven days", .last24Hours: "Last 24 hours"
    ]
    var wording: String {
        switch self {
        case .allTime: "across the available public records"
        case .today: "today so far"
        case .yesterday: "yesterday"
        case .thisWeek: "this week so far, since Monday"
        case .last7Days: "in the last seven days"
        case .last24Hours: "in the last 24 hours"
        }
    }
}

/// One finite parameter captures city AND period in an App Shortcut phrase.
/// Apple permits only one interpolated parameter per phrase. Existing saved
/// shortcuts can continue using RecentSightingsIntent.city and .period.
enum CitySightingsQuestion: String, AppEnum, CaseIterable {
    case austin, austinToday, austinYesterday, austinThisWeek, austinLast7Days, austinLast24Hours
    case dallas, dallasToday, dallasYesterday, dallasThisWeek, dallasLast7Days, dallasLast24Hours
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "City and period"
    static let caseDisplayRepresentations: [CitySightingsQuestion: DisplayRepresentation] = [
        .austin: DisplayRepresentation(title: "Austin", synonyms: ["Austin all time", "Austin total"]),
        .austinToday: DisplayRepresentation(title: "Austin today"),
        .austinYesterday: DisplayRepresentation(title: "Austin yesterday"),
        .austinThisWeek: DisplayRepresentation(title: "Austin weekly", synonyms: ["Austin this week"]),
        .austinLast7Days: DisplayRepresentation(title: "Austin in the last seven days", synonyms: ["Austin in the last 7 days"]),
        .austinLast24Hours: DisplayRepresentation(title: "Austin in the last 24 hours"),
        .dallas: DisplayRepresentation(title: "Dallas", synonyms: ["Dallas all time", "Dallas total"]),
        .dallasToday: DisplayRepresentation(title: "Dallas today"),
        .dallasYesterday: DisplayRepresentation(title: "Dallas yesterday"),
        .dallasThisWeek: DisplayRepresentation(title: "Dallas weekly", synonyms: ["Dallas this week"]),
        .dallasLast7Days: DisplayRepresentation(title: "Dallas in the last seven days", synonyms: ["Dallas in the last 7 days"]),
        .dallasLast24Hours: DisplayRepresentation(title: "Dallas in the last 24 hours"),
    ]
    var city: ServiceCity { rawValue.hasPrefix("austin") ? .austin : .dallas }
    var period: ActivityPeriod {
        switch self {
        case .austin, .dallas: .allTime
        case .austinToday, .dallasToday: .today
        case .austinYesterday, .dallasYesterday: .yesterday
        case .austinThisWeek, .dallasThisWeek: .thisWeek
        case .austinLast7Days, .dallasLast7Days: .last7Days
        case .austinLast24Hours, .dallasLast24Hours: .last24Hours
        }
    }
}

enum CityMetric: String, AppEnum, CaseIterable, Sendable {
    case sightings, cameras, registry, rides, zone
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Activity metric"
    static let caseDisplayRepresentations: [CityMetric: DisplayRepresentation] = [
        .sightings: "Approved sightings", .cameras: "Camera detections", .registry: "Public registry vehicles",
        .rides: "Recorded rides", .zone: "Service area"
    ]
}

/// Finite camera-only binding: neither registry nor zone can be selected here.
enum CameraCityPeriod: String, AppEnum, CaseIterable {
    case austinAllTime, austinToday, austinYesterday, austinThisWeek, austinLast7Days, austinLast24Hours
    case dallasAllTime, dallasToday, dallasYesterday, dallasThisWeek, dallasLast7Days, dallasLast24Hours
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Camera city and period"
    static let caseDisplayRepresentations: [CameraCityPeriod: DisplayRepresentation] = [
        .austinAllTime: "Austin all time", .austinToday: "Austin today", .austinYesterday: "Austin yesterday",
        .austinThisWeek: "Austin this week", .austinLast7Days: "Austin in the last seven days", .austinLast24Hours: "Austin in the last 24 hours",
        .dallasAllTime: "Dallas all time", .dallasToday: "Dallas today", .dallasYesterday: "Dallas yesterday",
        .dallasThisWeek: "Dallas this week", .dallasLast7Days: "Dallas in the last seven days", .dallasLast24Hours: "Dallas in the last 24 hours"
    ]
    var city: ServiceCity { rawValue.hasPrefix("austin") ? .austin : .dallas }
    var period: ActivityPeriod {
        if rawValue.hasSuffix("Today") { return .today }
        if rawValue.hasSuffix("Yesterday") { return .yesterday }
        if rawValue.hasSuffix("ThisWeek") { return .thisWeek }
        if rawValue.hasSuffix("Last7Days") { return .last7Days }
        if rawValue.hasSuffix("Last24Hours") { return .last24Hours }
        return .allTime
    }
}

struct ActivitySelection: Equatable {
    let city: ServiceCity?
    let metric: CityMetric
    let period: ActivityPeriod
    var comparesCities: Bool { city == nil }
}

/// Camera questions and city comparisons are also exposed through Check Fleet,
/// preserving all ten existing advertised shortcut slots.
enum CityActivityQuestion: String, AppEnum, CaseIterable {
    case austinCamerasTotal, austinCamerasToday, austinCamerasYesterday, austinCamerasThisWeek, austinCamerasLast7Days, austinCamerasLast24Hours
    case dallasCamerasTotal, dallasCamerasToday, dallasCamerasYesterday, dallasCamerasThisWeek, dallasCamerasLast7Days, dallasCamerasLast24Hours
    case compareSightings, compareSightingsToday, compareSightingsYesterday, compareSightingsThisWeek, compareSightingsLast7Days, compareSightingsLast24Hours
    case compareCameras, compareCamerasToday, compareCamerasYesterday, compareCamerasThisWeek, compareCamerasLast7Days, compareCamerasLast24Hours
    case compareRegistry, compareRides, compareZones
    case austinRegistry, austinZone, clarifyActivity, clarifyComparison, clarifyComparisonToday, clarifyCamerasThisWeek
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "City activity question"
    static let caseDisplayRepresentations: [CityActivityQuestion: DisplayRepresentation] = [
        .austinCamerasTotal: "Austin camera detections all time",
        .austinCamerasToday: "Austin camera detections today",
        .austinCamerasYesterday: "Austin camera detections yesterday",
        .austinCamerasThisWeek: "Austin camera detections this week",
        .austinCamerasLast7Days: "Austin camera detections in the last seven days",
        .austinCamerasLast24Hours: "Austin camera detections in the last 24 hours",
        .dallasCamerasTotal: "Dallas camera detections all time",
        .dallasCamerasToday: DisplayRepresentation(title: "Dallas camera detections today", synonyms: ["How many Cybercabs did Dallas cameras detect today"]),
        .dallasCamerasYesterday: "Dallas camera detections yesterday",
        .dallasCamerasThisWeek: "Dallas camera detections this week",
        .dallasCamerasLast7Days: "Dallas camera detections in the last seven days",
        .dallasCamerasLast24Hours: "Dallas camera detections in the last 24 hours",
        .compareSightings: "Austin and Dallas sightings all time",
        .compareSightingsToday: DisplayRepresentation(title: "Austin and Dallas sightings today", synonyms: ["Which city has more Cybercab sightings today", "Compare Austin and Dallas Cybercab sightings today"]),
        .compareSightingsYesterday: "Austin and Dallas sightings yesterday",
        .compareSightingsThisWeek: DisplayRepresentation(title: "Weekly sightings comparison", synonyms: ["Austin and Dallas sightings this week"]),
        .compareSightingsLast7Days: "Austin and Dallas sightings in the last seven days",
        .compareSightingsLast24Hours: "Austin and Dallas sightings in the last 24 hours",
        .compareCameras: "Austin and Dallas camera detections all time",
        .compareCamerasToday: "Austin and Dallas camera detections today",
        .compareCamerasYesterday: "Austin and Dallas camera detections yesterday",
        .compareCamerasThisWeek: "Austin and Dallas camera detections this week",
        .compareCamerasLast7Days: "Austin and Dallas camera detections in the last seven days",
        .compareCamerasLast24Hours: "Austin and Dallas camera detections in the last 24 hours",
        .compareRegistry: "Austin and Dallas registry vehicles",
        .compareRides: "Austin and Dallas recorded rides",
        .compareZones: "Austin and Dallas service zones",
        .austinRegistry: DisplayRepresentation(title: "Austin public registry vehicles", synonyms: ["Austin Cybercab fleet size", "Austin Cybercab fleet stats", "How many Cybercabs are in Austin", "What is the Austin Cybercab fleet size"]),
        .austinZone: DisplayRepresentation(title: "Austin Cybercab service area", synonyms: ["Austin Cybercab zone", "How big is the Austin Cybercab zone", "What is the Cybercab service area in Austin", "How many square miles is the Austin Cybercab service zone"]),
        .clarifyActivity: "Unspecified Cybercab activity",
        .clarifyComparison: "Compare Austin and Dallas Cybercab activity",
        .clarifyComparisonToday: "How do Dallas and Austin compare today",
        .clarifyCamerasThisWeek: "Cybercab camera detections this week"
    ]
    var requiresClarification: Bool { [.clarifyActivity, .clarifyComparison, .clarifyComparisonToday, .clarifyCamerasThisWeek].contains(self) }
    var comparesCities: Bool { rawValue.hasPrefix("compare") }
    var city: ServiceCity { rawValue.hasPrefix("dallas") ? .dallas : .austin }
    var metric: CityMetric {
        if rawValue.contains("Sightings") { return .sightings }
        if self == .compareRegistry || self == .austinRegistry { return .registry }
        if self == .compareRides { return .rides }
        if self == .compareZones || self == .austinZone { return .zone }
        return .cameras
    }
    var period: ActivityPeriod {
        if rawValue.hasSuffix("Today") { return .today }
        if rawValue.hasSuffix("Yesterday") { return .yesterday }
        if rawValue.hasSuffix("ThisWeek") { return .thisWeek }
        if rawValue.hasSuffix("Last7Days") { return .last7Days }
        if rawValue.hasSuffix("Last24Hours") { return .last24Hours }
        return .allTime
    }
}

struct CityActivityIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Cybercab City Activity"
    static let description = IntentDescription("Counts traffic-camera detections, reads Austin public registry or service area data, or compares Austin and Dallas sightings, cameras, public registry vehicles, recorded rides, and service zones. Calendar periods use Central time and weeks start Monday.", searchKeywords: ["camera detections", "comparison", "service area", "public registry"])
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }
    @Parameter(title: "Question", requestValueDialog: "Which city, metric, and period? For example, Dallas camera detections today.") var question: CityActivityQuestion
    @Parameter(title: "City") var city: ServiceCity?
    @Parameter(title: "Activity metric") var activityMetric: CityMetric?
    @Parameter(title: "Activity period") var activityPeriod: ActivityPeriod?
    static var parameterSummary: some ParameterSummary { Summary("Check \(\.$question)") { \.$city; \.$activityMetric; \.$activityPeriod } }

    func resolvedActivity(traceID: String = UUID().uuidString) throws -> ActivitySelection {
        // Reuse Fleet's validation, translating prompts to THIS intent's parameters
        // so a Shortcuts/Siri restart retains the user's known context.
        let resolver = FleetStatsIntent()
        resolver.activity = question; resolver.city = city
        resolver.activityMetric = activityMetric; resolver.activityPeriod = activityPeriod
        if question == .clarifyCamerasThisWeek && city == nil {
            SiriDiagnostics.record(intent: "CityActivityIntent", phase: "clarification_requested", id: traceID, selection: "missing_city")
            throw $city.needsValueError("Which city, Austin or Dallas?")
        }
        if question == .clarifyComparison || question == .clarifyComparisonToday {
            if activityMetric == nil {
                SiriDiagnostics.record(intent: "CityActivityIntent", phase: "clarification_requested", id: traceID, selection: "missing_metric")
                throw $activityMetric.needsValueError("Which metric: approved sightings, camera detections, public registry vehicles, recorded rides, or service area?")
            }
            if question == .clarifyComparison && (activityMetric == .sightings || activityMetric == .cameras) && activityPeriod == nil {
                SiriDiagnostics.record(intent: "CityActivityIntent", phase: "clarification_requested", id: traceID, selection: "missing_period")
                throw $activityPeriod.needsValueError("Which period: today, yesterday, this week, last seven days, last 24 hours, or all time?")
            }
        }
        do {
            guard let selection = try resolver.resolvedActivity(traceID: traceID, diagnosticIntent: "CityActivityIntent") else { throw IntentFailure.activityRequired }
            return selection
        } catch {
            SiriDiagnostics.record(intent: "CityActivityIntent", phase: "clarification_requested", id: traceID, selection: "conflicting_or_incomplete_activity")
            throw $question.needsValueError("Choose matching city, metric, and period values for this activity.")
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        let presence = $question.diagnosticPresence
        guard presence != .unset else {
            throw $question.needsValueError("Which city, metric, and period? For example, Dallas camera detections today.")
        }
        guard question != .clarifyActivity else {
            throw $question.needsValueError("Which city, metric, and period? Choose approved sightings, camera detections, registry vehicles, or service area.")
        }
        let id = UUID().uuidString
        var supplied = SiriDiagnostics.Parameters()
        supplied.city = city?.rawValue ?? "missing"; supplied.activity = question.rawValue
        supplied.metric = activityMetric?.rawValue ?? "missing"; supplied.period = activityPeriod?.rawValue ?? "missing"
        SiriDiagnostics.record(intent: "CityActivityIntent", phase: "parameters_received", id: id, parameters: supplied)
        let selected = try resolvedActivity(traceID: id)
        let a = try await Self.answer(selected, selection: question.rawValue, presence: presence, traceID: id)
        return .result(value: a.spoken, dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.home), openTitle: "Open Cybercab Hunter"))
    }

    static func answer(_ question: CityActivityQuestion, now: Date = .now, presence: SiriDiagnostics.Presence = .derived) async throws -> SiriAnswer {
        guard !question.requiresClarification else { throw IntentFailure.activityRequired }
        return try await answer(ActivitySelection(city: question.comparesCities ? nil : question.city, metric: question.metric, period: question.period), now: now, selection: question.rawValue, presence: presence)
    }

    static func answer(_ resolved: ActivitySelection, now: Date = .now, selection: String, presence: SiriDiagnostics.Presence = .derived, traceID: String = UUID().uuidString) async throws -> SiriAnswer {
        let question = resolved
        var p = SiriDiagnostics.Parameters()
        p.city = question.city?.rawValue ?? "austin,dallas"
        p.cityState = .derived; p.metric = question.metric.rawValue; p.metricState = .derived
        p.activity = selection; p.activityState = presence
        p.period = question.period.rawValue; p.periodState = .derived
        var trace = SiriDiagnostics.Invocation("CityActivityIntent", parameters: p, id: traceID)
        do {
            if question.comparesCities {
                async let a: HomepageStats = SiriData.shared.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "austin")])
                async let d: HomepageStats = SiriData.shared.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "dallas")])
                let (austin, dallas) = try await (a, d)
                try SiriCityResponse.validate(austin, for: .austin)
                try SiriCityResponse.validate(dallas, for: .dallas)
                let answer = CityActivitySpeech.compare(austin, dallas, metric: question.metric, period: question.period, now: now)
                trace.complete(answer.figures.isEmpty ? "no_count_available" : "answer_composed")
                return answer
            }
            let s: HomepageStats = try await SiriData.shared.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: question.city!.rawValue)])
            try SiriCityResponse.validate(s, for: question.city!)
            let answer = question.metric == .zone ? SiriSpeech.zone(s) : CityActivitySpeech.answer(s, metric: question.metric, period: question.period, now: now)
            trace.complete(answer.figures.isEmpty ? "no_count_available" : "answer_composed")
            return answer
        } catch {
            trace.fail(error)
            throw IntentFailure.unavailable
        }
    }
}

/// Pure answer logic, shared by sightings and city activity. Never estimates
/// missing dates, counts a limited page, or substitutes camera hits for photos.
enum CityActivitySpeech {
    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = SiriSpeech.central; c.firstWeekday = 2; c.minimumDaysInFirstWeek = 4
        return c
    }

    static func dates(_ period: ActivityPeriod, now: Date) -> [String] {
        let c = calendar, end = c.startOfDay(for: now)
        let start: Date
        switch period {
        case .yesterday: start = c.date(byAdding: .day, value: -1, to: end)!
        case .thisWeek: start = c.dateInterval(of: .weekOfYear, for: end)!.start
        default: start = end
        }
        let finish = period == .yesterday ? start : end
        var days: [String] = [], d = start
        while d <= finish { days.append(SiriSpeech.iso(d)); d = c.date(byAdding: .day, value: 1, to: d)! }
        return days
    }

    static func count(_ s: HomepageStats, metric: CityMetric, period: ActivityPeriod, now: Date) -> Int? {
        switch metric {
        case .registry: return s.area?.vehicles
        case .rides: return s.rides?.rides
        case .zone: return nil
        case .sightings, .cameras: break
        }
        // A response generated yesterday must never be relabelled as today.
        if period != .allTime {
            guard let generated = SiriSpeech.instant(s.generatedAt), calendar.isDate(generated, inSameDayAs: now) else { return nil }
        }
        if period == .allTime {
            if metric == .sightings { return s.sightings?.total }
            return s.cameras?.daily.map { $0.reduce(0) { $0 + $1.count } }
        }
        if period == .last24Hours { return metric == .sightings ? s.sightings?.last24h : s.cameras?.detections24h }
        if period == .last7Days {
            // Only the sightings API supplies an exact rolling seven-day count.
            // Camera daily buckets cannot establish an exact rolling boundary.
            return metric == .sightings ? s.sightings?.last7Days : nil
        }
        guard let daily = metric == .sightings ? s.sightings?.daily : s.cameras?.daily else { return nil }
        let wanted = dates(period, now: now)
        if metric == .sightings {
            // Sightings returns a dense 90-day series: every requested day must exist.
            guard wanted.allSatisfy({ day in daily.contains { $0.date == day } }) else { return nil }
        }
        // Camera history includes ALL nonzero local dates; missing dates are zero.
        return daily.filter { wanted.contains($0.date) }.reduce(0) { $0 + $1.count }
    }

    static func noun(_ metric: CityMetric, count: Int) -> String {
        switch metric {
        case .sightings: SiriSpeech.plural(count, "approved public sighting", "approved public sightings")
        case .cameras: SiriSpeech.plural(count, "traffic-camera detection", "traffic-camera detections")
        case .registry: SiriSpeech.plural(count, "public registry vehicle", "public registry vehicles")
        case .rides: SiriSpeech.plural(count, "recorded ride", "recorded rides")
        case .zone: ""
        }
    }

    static func note(_ s: HomepageStats, metric: CityMetric, period: ActivityPeriod) -> String {
        var note: String
        switch metric {
        case .sightings: note = "Approved public photos only; camera detections are separate. City totals cover currently public records, not a permanent lifetime counter."
        case .cameras: note = "Camera detections are observations, not unique vehicles or their current locations. The 24-hour figure uses the endpoint's latest 24 UTC hourly buckets."
        case .registry: note = "Public registry vehicles documented by riders and spotters, not a live count of cars in service."
        case .rides: note = "Recorded rides in each city's public ride sample, not all rides operated by Tesla."
        case .zone: note = "Published service-zone figures."
        }
        if let generated = s.generatedAt { note += " Data as of \(generated)." }
        return note
    }

    static func answer(_ s: HomepageStats, metric: CityMetric, period: ActivityPeriod, now: Date = .now) -> SiriAnswer {
        guard let n = count(s, metric: metric, period: period, now: now) else {
            return SiriAnswer(spoken: "Cybercab Hunter can't provide that count for \(s.name) \(period.wording) from the available data.")
        }
        let timing = metric == .cameras && period == .last24Hours ? "in the latest 24 hourly buckets" : period.wording
        var spoken = "In \(s.name), Cybercab Hunter has \(noun(metric, count: n)) \(timing)."
        if period == .allTime && metric == .sightings { spoken += " This counts currently public records; a city lifetime total isn't available." }
        return SiriAnswer(spoken: spoken, figures: [.init(value: SiriSpeech.n(n), label: s.name)], footnote: note(s, metric: metric, period: period))
    }

    static func compare(_ a: HomepageStats, _ b: HomepageStats, metric: CityMetric, period: ActivityPeriod, now: Date = .now) -> SiriAnswer {
        if metric == .zone { return SiriSpeech.compareZones(a, b) }
        guard let x = count(a, metric: metric, period: period, now: now), let y = count(b, metric: metric, period: period, now: now) else {
            return SiriAnswer(spoken: "Cybercab Hunter doesn't have comparable counts for both cities \(period.wording).")
        }
        let wording = metric == .cameras && period == .last24Hours ? "in the latest 24 hourly buckets" : period.wording
        let timing = [.sightings, .cameras].contains(metric) ? " \(wording)" : ""
        var spoken = "\(a.name) has \(noun(metric, count: x)) and \(b.name) has \(noun(metric, count: y))\(timing)."
        if x == y { spoken += " The counts are equal." }
        else { spoken += " \(x > y ? a.name : b.name) has \(SiriSpeech.n(abs(x - y))) more." }
        if metric == .sightings && period == .allTime { spoken += " These are currently public records, not city lifetime totals." }
        return SiriAnswer(spoken: spoken, figures: [.init(value: SiriSpeech.n(x), label: a.name), .init(value: SiriSpeech.n(y), label: b.name)], footnote: note(a, metric: metric, period: period))
    }
}


enum FleetMetric: String, AppEnum {
    case overview, registry, rides, lifetimeSightings
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Fleet statistic"
    static let caseDisplayRepresentations: [FleetMetric: DisplayRepresentation] = [
        .overview: "Fleet overview", .registry: "Public registry vehicles",
        .rides: "Recorded rides", .lifetimeSightings: "Lifetime approved sightings"
    ]
}

enum DMVQuestion: String, AppEnum {
    case overview, total, cybercab, modelY, additions, cybercabAdditions, modelYAdditions
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Texas DMV statistic"
    static let caseDisplayRepresentations: [DMVQuestion: DisplayRepresentation] = [
        .overview: "Texas DMV overview", .total: "Texas DMV total VINs",
        .cybercab: DisplayRepresentation(title: "Texas DMV Cybercab VINs", synonyms: ["How many Cybercab VINs are registered in Texas", "Texas DMV Cybercab registrations"]), .modelY: "Texas DMV Model Y VINs",
        .additions: "Latest newly detected DMV VINs",
        .cybercabAdditions: "Latest newly detected DMV Cybercab VINs",
        .modelYAdditions: "Latest newly detected DMV Model Y VINs"
    ]
}

extension SiriSpeech {
    static func dmv(_ o: DMVOverview, question: DMVQuestion, now: Date = .now) -> SiriAnswer {
        if question == .overview { return dmv(o, now: now) }
        let n: Int, date: String, kind: String
        switch question {
        case .total, .cybercab, .modelY:
            guard let totals = o.totals, let latest = o.latest else {
                return SiriAnswer(spoken: "The Texas DMV snapshot count isn't available yet.")
            }
            n = question == .total ? totals.total ?? totals.sum : question == .cybercab ? totals.cybercab : totals.modelY
            date = latest.date
            kind = question == .total ? "Tesla robotaxi" : question == .cybercab ? "Cybercab" : "Model Y"
        case .additions, .cybercabAdditions, .modelYAdditions:
            guard o.processingPending == 0 else {
                return SiriAnswer(spoken: "Texas DMV snapshot changes are still processing or their processing status is unavailable.")
            }
            guard let update = o.latestUpdate else {
                return SiriAnswer(spoken: "No processed Texas DMV roster change is available yet.")
            }
            date = update.date
            kind = question == .additions ? "Tesla robotaxi" : question == .cybercabAdditions ? "Cybercab" : "Model Y"
            if question == .additions { n = update.added }
            else {
                guard let counts = update.addedByModel else { return SiriAnswer(spoken: "The latest Texas DMV update doesn't have a model breakdown available.") }
                n = question == .cybercabAdditions ? counts.cybercab : counts.modelY
            }
        case .overview: return dmv(o, now: now)
        }
        let isAddition = [.additions, .cybercabAdditions, .modelYAdditions].contains(question)
        var spoken = isAddition
            ? "Cybercab Hunter first detected \(n) additional \(kind) \(n == 1 ? "VIN" : "VINs") in the \(day(date, now: now)) Texas DMV dataset."
            : "The \(day(date, now: now)) Texas DMV dataset lists \(n) \(kind) \(n == 1 ? "VIN" : "VINs")."
        let fresh = DMVText.freshness(o.freshness.status)
        if fresh.warn || o.freshness.status == "update_pending" { spoken += " Data status: \(fresh.label.lowercased())." }
        return SiriAnswer(spoken: spoken, figures: [.init(value: Self.n(n), label: "\(kind) VINs")], footnote: "DMV VINs are separate from the public registry. First detection is not a registration date or proof of current operation.")
    }
}


enum GrowthModel: String, AppEnum {
    case all, cybercab, modelY
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "DMV growth model"
    static let caseDisplayRepresentations: [GrowthModel: DisplayRepresentation] = [
        .all: "Tesla robotaxi VIN", .cybercab: "Cybercab VIN", .modelY: "Model Y VIN"
    ]
    var label: String { switch self { case .all: "Tesla robotaxi"; case .cybercab: "Cybercab"; case .modelY: "Model Y" } }
}
