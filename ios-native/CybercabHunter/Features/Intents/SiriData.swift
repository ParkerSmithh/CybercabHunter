import Foundation
import CoreLocation

// What Siri, Shortcuts and Apple Intelligence answers are built from: the same
// public, edge-cached endpoints the app reads (never signed in, never the whole
// registry), and the sentences Siri says. The sentences are pure functions of
// those responses, so the tests check exactly what Siri would say.

/// The public API for intents, with a 2-minute memory: a briefing and its
/// follow-up question (or two parts of one answer) never fetch the same thing
/// twice, and identical requests in flight are shared.
actor SiriData {
    static let shared = SiriData()
    static let ttl: TimeInterval = 120

    private var entries: [String: (at: Date, task: Task<any Sendable, any Error>)] = [:]
    /// Network requests actually made (tests).
    private(set) var requestCount = 0

    /// The registry's public client (no session is ever attached); tests stub it.
    nonisolated static var api: APIClient { testAPI ?? VehicleDirectory.api }
    nonisolated(unsafe) static var testAPI: APIClient?

    func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self, now: Date = .now) async throws -> T {
        let key = path + "?" + query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
        if let e = entries[key], now.timeIntervalSince(e.at) < Self.ttl, let v = try? await e.task.value as? T { return v }
        let api = Self.api
        let task = Task<any Sendable, any Error> { try await api.get(path, query: query, as: T.self) }
        entries[key] = (now, task)
        requestCount += 1
        do {
            guard let value = try await task.value as? T else { throw IntentFailure.unavailable }
            return value
        } catch {
            entries[key] = nil   // a failure is never remembered
            throw error
        }
    }

    func reset() { entries = [:]; requestCount = 0 }
}

// MARK: - Plates and VINs

enum VehicleSearchText {
    /// What a spoken or typed plate / VIN becomes for the registry search:
    /// letters and digits only, upper case ("xvf-1524" → "XVF1524"), at most 17.
    static func normalized(_ raw: String) -> String {
        String(raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(17))
    }

    /// A full VIN: 17 characters, never I, O or Q.
    static func isVIN(_ s: String) -> Bool {
        s.count == 17 && !s.contains { "IOQ".contains($0) }
    }
}

// MARK: - The sentences

/// One Siri answer: what Siri says, and the few figures the card shows.
struct SiriAnswer: Equatable, Sendable {
    var spoken: String
    var figures: [Figure] = []
    var footnote: String?

    struct Figure: Equatable, Sendable, Hashable {
        let value: String
        let label: String
    }
}

enum SiriSpeech {
    static let central = TimeZone(identifier: "America/Chicago")!

    // MARK: dates

    /// "October 22" for a "2026-10-22" calendar date (with the year only if it isn't `now`'s).
    static func day(_ raw: String?, now: Date = .now) -> String {
        guard let raw, let date = calendarDate(raw) else { return raw ?? "" }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = central
        let sameYear = cal.component(.year, from: date) == cal.component(.year, from: now)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US"); f.timeZone = central
        f.dateFormat = sameYear ? "MMMM d" : "MMMM d, yyyy"
        return f.string(from: date)
    }

    static func calendarDate(_ raw: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = central
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(raw.prefix(10)))
    }

    /// An ISO 8601 instant, or the registry's "YYYY-MM-DD HH:MM:SS" (UTC).
    static func instant(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: raw) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: raw) { return d }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.date(from: raw)
    }

    /// "25 minutes ago", "3 hours ago", "2 days ago" (never "now": a report is always in the past).
    static func ago(_ date: Date, now: Date = .now) -> String {
        let s = max(0, now.timeIntervalSince(date))
        if s < 90 { return "about a minute ago" }
        if s < 3600 { let m = Int((s / 60).rounded()); return "\(m) minutes ago" }
        if s < 48 * 3600 { let h = Int((s / 3600).rounded()); return h == 1 ? "an hour ago" : "\(h) hours ago" }
        let d = Int((s / 86400).rounded())
        return "\(d) days ago"
    }

    static func n(_ v: Int) -> String { v.formatted(.number.locale(Locale(identifier: "en_US"))) }
    static func plural(_ v: Int, _ one: String, _ many: String) -> String { "\(n(v)) \(v == 1 ? one : many)" }

    // MARK: fleet

    /// "How many Cybercabs…": the public registry (riders' and spotters' records),
    /// kept apart from the Texas DMV roster (VINs Tesla lists with the state).
    /// Neither is a count of cars in service right now: nobody publishes that.
    static func fleet(stats: RegistryStats, daily: DailyReport?, dmv: DMVOverview?, now: Date = .now) -> SiriAnswer {
        var parts = ["Cybercab Hunter's public registry has \(plural(stats.publicVehicles, "vehicle", "vehicles")) documented by riders and spotters."]
        if let t = dmv?.totals, let date = dmv?.latest?.date {
            let total = t.total ?? t.sum
            parts.append("The Texas DMV roster lists \(plural(total, "Tesla robotaxi VIN", "Tesla robotaxi VINs")), \(n(t.cybercab)) of them Cybercabs, as of \(day(date, now: now)).")
        }
        if let d = daily?.day, let today = todaySentence(d) { parts.append(today) }
        var figures = [SiriAnswer.Figure(value: n(stats.publicVehicles), label: "Registry")]
        if let t = dmv?.totals { figures.append(.init(value: n(t.total ?? t.sum), label: "DMV VINs")); figures.append(.init(value: n(t.cybercab), label: "DMV Cybercabs")) }
        return SiriAnswer(spoken: parts.joined(separator: " "), figures: figures,
                          footnote: "Registry: vehicles riders and spotters documented. DMV: VINs Tesla lists with the state. Neither is the number in service right now.")
    }

    /// One city: its registry vehicles, this week's additions, the last 24 hours' sightings.
    static func cityFleet(_ s: HomepageStats) -> SiriAnswer {
        var parts: [String] = []
        if let v = s.area?.vehicles {
            var line = "In \(s.name), Cybercab Hunter's public registry has \(plural(v, "vehicle", "vehicles"))"
            if let w = s.area?.vehiclesAdded7d, w > 0 { line += ", \(n(w)) added in the last 7 days" }
            parts.append(line + ".")
        }
        if let sightingLine = recentSightingsSentence(s) { parts.append(sightingLine) }
        if parts.isEmpty { parts.append("Cybercab Hunter doesn't have \(s.name) figures right now.") }
        var figures: [SiriAnswer.Figure] = []
        if let v = s.area?.vehicles { figures.append(.init(value: n(v), label: "Registry")) }
        if let x = s.sightings?.last24h { figures.append(.init(value: n(x), label: "Sightings 24h")) }
        if let c = s.cameras?.detections24h { figures.append(.init(value: n(c), label: "Camera 24h")) }
        return SiriAnswer(spoken: parts.joined(separator: " "), figures: figures)
    }

    /// "8 approved sightings and 8 traffic-camera detections in the last 24 hours."
    static func recentSightingsSentence(_ s: HomepageStats) -> String? {
        let approved = s.sightings?.last24h, camera = s.cameras?.detections24h
        switch (approved, camera) {
        case let (a?, c?): return "In the last 24 hours: \(plural(a, "approved sighting", "approved sightings")) and \(plural(c, "traffic-camera detection", "traffic-camera detections"))."
        case let (a?, nil): return "In the last 24 hours: \(plural(a, "approved sighting", "approved sightings"))."
        case let (nil, c?): return "In the last 24 hours: \(plural(c, "traffic-camera detection", "traffic-camera detections"))."
        default: return nil
        }
    }

    static func todaySentence(_ d: DailyReport.Day) -> String? {
        var bits: [String] = []
        if let r = d.registry, r > 0 { bits.append("\(plural(r, "new registry vehicle", "new registry vehicles"))") }
        if let s = d.sightings { bits.append("\(plural(s, "approved sighting", "approved sightings"))") }
        if let c = d.cameras, c > 0 { bits.append("\(plural(c, "camera detection", "camera detections"))") }
        guard !bits.isEmpty else { return nil }
        return "Today so far: " + list(bits) + "."
    }

    static func list(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        case 2: return "\(items[0]) and \(items[1])"
        default: return items.dropLast().joined(separator: ", ") + ", and " + items.last!
        }
    }

    // MARK: Texas DMV

    /// "Cybercab Hunter first detected 55 additional VINs in the October 22 dataset…"
    /// TxDMV publishes no registration dates, so a date here is always the
    /// snapshot a VIN first appeared in, never when it was registered.
    static func dmv(_ o: DMVOverview, now: Date = .now) -> SiriAnswer {
        guard let latest = o.latest, let t = o.totals else {
            return SiriAnswer(spoken: "Cybercab Hunter hasn't taken its first Texas DMV snapshot yet.")
        }
        let total = t.total ?? t.sum
        var parts = ["The Texas DMV roster for Tesla Robotaxi lists \(plural(total, "VIN", "VINs")) as of the \(day(latest.date, now: now)) dataset: \(n(t.cybercab)) Cybercab and \(n(t.modelY)) Model Y."]
        if let u = o.latestUpdate {
            var line = "Cybercab Hunter first detected \(plural(u.added, "additional VIN", "additional VINs")) in the \(day(u.date, now: now)) dataset"
            let b = DMVText.breakdown(u.addedByModel)
            if !b.isEmpty { line += ": \(b)" }
            parts.append(line + ".")
            if u.missing > 0 { parts.append("\(plural(u.missing, "VIN was", "VINs were")) missing from that snapshot, which doesn't mean deregistered.") }
        } else if (o.processingPending ?? 0) > 0 {
            parts.append("Cybercab Hunter is still processing its earlier snapshots, so recent changes aren't available yet.")
        } else {
            parts.append("No changes since tracking began.")
        }
        let fresh = DMVText.freshness(o.freshness.status)
        if fresh.warn || o.freshness.status == "update_pending" { parts.append("Data status: \(fresh.label.lowercased()).") }
        var figures = [SiriAnswer.Figure(value: n(total), label: "VINs"), .init(value: n(t.cybercab), label: "Cybercab"), .init(value: n(t.modelY), label: "Model Y")]
        if let u = o.latestUpdate { figures.append(.init(value: "+\(n(u.added))", label: "Latest update")) }
        return SiriAnswer(spoken: parts.joined(separator: " "), figures: figures,
                          footnote: "TxDMV publishes no registration dates: dates are when Cybercab Hunter first detected a VIN.")
    }

    // MARK: briefing and quick status

    /// The daily briefing: only what today's data supports, shortest first.
    /// `quick` (hands-free status) keeps it to two sentences.
    static func briefing(daily: DailyReport?, dmv: DMVOverview?, city: HomepageStats?, quick: Bool = false, now: Date = .now) -> SiriAnswer {
        var parts: [String] = []
        if let city {
            if let s = recentSightingsSentence(city) { parts.append(s.replacingOccurrences(of: "In the last 24 hours:", with: "In \(city.name), in the last 24 hours:")) }
            if !quick, let w = city.area?.vehiclesAdded7d, w > 0 { parts.append("\(plural(w, "vehicle was", "vehicles were")) added to the \(city.name) registry this week.") }
        } else if let d = daily?.day, let today = todaySentence(d) {
            parts.append(today)
        }
        if let o = dmv {
            if let u = o.latestUpdate, let date = calendarDate(u.date), now.timeIntervalSince(date) < 8 * 86400 {
                parts.append("The \(day(u.date, now: now)) Texas DMV dataset added \(plural(u.added, "newly detected VIN", "newly detected VINs"))\(u.addedByModel.map { $0.cybercab > 0 ? ", \(n($0.cybercab)) of them Cybercabs" : "" } ?? "").")
            } else if o.latestUpdate == nil, (o.processingPending ?? 0) > 0, !quick {
                parts.append("Texas DMV changes are still being processed.")
            } else if !quick, let latest = o.latest {
                parts.append("No new Texas DMV VINs in the last week; the latest dataset is from \(day(latest.date, now: now)).")
            }
        }
        if quick { parts = Array(parts.prefix(2)) }
        if parts.isEmpty { return SiriAnswer(spoken: "Cybercab Hunter has no new activity to report right now.") }
        let opener = quick ? "" : "Here's your Cybercab Hunter briefing. "
        var figures: [SiriAnswer.Figure] = []
        if let c = city { if let a = c.sightings?.last24h { figures.append(.init(value: n(a), label: "Sightings 24h")) } }
        else if let s = daily?.day.sightings { figures.append(.init(value: n(s), label: "Sightings today")) }
        if let u = dmv?.latestUpdate { figures.append(.init(value: "+\(n(u.added))", label: "DMV \(shortDay(u.date))")) }
        return SiriAnswer(spoken: opener + parts.joined(separator: " "), figures: figures, footnote: stale(daily: daily, now: now))
    }

    /// A warning when the day's report isn't today's (Central time).
    static func stale(daily: DailyReport?, now: Date) -> String? {
        guard let daily else { return nil }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = central; f.dateFormat = "yyyy-MM-dd"
        return daily.today == f.string(from: now) ? nil : "Figures are from \(day(daily.today, now: now)), not today."
    }

    static func shortDay(_ raw: String) -> String {
        guard let d = calendarDate(raw) else { return raw }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.timeZone = central; f.dateFormat = "MMM d"
        return f.string(from: d)
    }

    // MARK: sightings

    static func sightings(city: HomepageStats?, latest: [PublicSighting], cityName: String?, now: Date = .now) -> SiriAnswer {
        var parts: [String] = []
        // The counts first: that's what "how many were spotted…" asks.
        if let city, let a = city.sightings?.last24h {
            var line = "In \(city.name), Cybercab Hunter recorded \(plural(a, "approved sighting", "approved sightings"))"
            if let c = city.cameras?.detections24h { line += " and \(plural(c, "traffic-camera detection", "traffic-camera detections"))" }
            parts.append(line + " in the last 24 hours.")
        }
        if let s = latest.first, let at = instant(s.spottedAt) {
            var line = "The latest approved sighting\(cityName.map { " in \($0)" } ?? "") was \(ago(at, now: now))"
            if let loc = s.location, !loc.isEmpty { line += ", near \(loc)" }
            if let plate = s.plate { line += ", plate \(spell(plate))" }
            parts.append(line + ".")
        }
        if parts.isEmpty { parts.append("There are no approved sightings\(cityName.map { " in \($0)" } ?? "") in the last 30 days.") }
        return SiriAnswer(spoken: parts.joined(separator: " "),
                          footnote: "Approved sightings are photos reviewed by moderators; reports still in review aren't public. Camera detections come from public traffic cameras.")
    }

    /// A plate read character by character ("X V F 1 5 2 4"), as Siri should say it.
    static func spell(_ plate: String) -> String { plate.map(String.init).joined(separator: " ") }

    // MARK: near me

    struct NearbyHit: Equatable, Sendable {
        let camera: String
        let miles: Double
        let at: Date
    }

    /// The traffic-camera detections within `radiusMiles` of `location` in the
    /// last `window`, nearest first. A detection is where a camera saw a
    /// Cybercab at that time — never a claim that it is still there.
    static func nearby(_ detections: [CameraDetection], from location: CLLocation, radiusMiles: Double, window: TimeInterval, now: Date = .now) -> [NearbyHit] {
        detections.compactMap { d -> NearbyHit? in
            guard let at = instant(d.observedAt), now.timeIntervalSince(at) <= window, now.timeIntervalSince(at) >= -300 else { return nil }
            let miles = location.distance(from: CLLocation(latitude: d.lat, longitude: d.lng)) / 1609.344
            return miles <= radiusMiles ? NearbyHit(camera: titleCase(d.cameraName), miles: miles, at: at) : nil
        }.sorted { ($0.at, -$0.miles) > ($1.at, -$1.miles) }
    }

    static func nearbyAnswer(hits: [NearbyHit], radiusMiles: Double, precise: Bool, cityName: String, latestInCity: NearbyHit?, now: Date = .now) -> SiriAnswer {
        guard let first = hits.first else {
            var line = "No Cybercab camera detections within about \(Int(radiusMiles.rounded())) miles of you in the last 24 hours."
            if let l = latestInCity { line += " The latest in \(cityName) was at \(l.camera), \(ago(l.at, now: now))." }
            return SiriAnswer(spoken: line, footnote: "Camera detections only: sighting reports don't include map coordinates.")
        }
        let distance = precise ? "about \(milesText(first.miles)) from you" : "in your area"
        var line = "A Cybercab was detected by a traffic camera at \(first.camera), \(distance), \(ago(first.at, now: now))."
        if hits.count > 1 { line += " \(plural(hits.count - 1, "other nearby camera", "other nearby cameras")) also saw one in the last 24 hours." }
        return SiriAnswer(spoken: line, figures: [.init(value: n(hits.count), label: "Nearby cameras")],
                          footnote: "A detection shows where a camera saw a Cybercab at that time, not where it is now.")
    }

    static func milesText(_ m: Double) -> String {
        m < 10 ? "\(String(format: "%.1f", max(m, 0.1))) miles" : "\(Int(m.rounded())) miles"
    }

    /// "6TH ST / LAMAR BLVD" → "6th St / Lamar Blvd".
    static func titleCase(_ s: String) -> String {
        s.lowercased().split(separator: " ", omittingEmptySubsequences: false).map { w in
            guard let f = w.first else { return String(w) }
            return f.isNumber ? String(w) : f.uppercased() + w.dropFirst()
        }.joined(separator: " ")
    }

    // MARK: fleet growth

    struct Growth: Equatable, Sendable {
        let from: String, to: String
        let startTotal: Int, endTotal: Int
        let startCybercab: Int, endCybercab: Int
        let newlyDetected: Int?          // nil while the comparisons aren't processed
        let clampedStart: Bool           // the period begins before the first snapshot
        var net: Int { endTotal - startTotal }
        var percent: Double? { startTotal > 0 ? Double(net) / Double(startTotal) * 100 : nil }
    }

    /// The change between the first snapshot on or after `start` and the last on
    /// or before `end` — actual snapshots only, never interpolated.
    static func growth(_ g: DMVGrowth, start: String?, end: String?, processed: Bool) -> Growth? {
        let pts = g.points.sorted { $0.date < $1.date }
        guard let first = pts.first else { return nil }
        let endPoint = pts.last { end == nil || $0.date <= end! }
        let startPoint = pts.first { start == nil || $0.date >= start! }
        guard let a = startPoint, let b = endPoint, a.date < b.date else { return nil }
        let between = pts.filter { $0.date > a.date && $0.date <= b.date && !$0.baseline }
        let newly = processed ? between.reduce(0) { $0 + ($1.added.map { $0.sum } ?? 0) } : nil
        return Growth(from: a.date, to: b.date, startTotal: a.total, endTotal: b.total, startCybercab: a.cybercab, endCybercab: b.cybercab,
                      newlyDetected: newly, clampedStart: start.map { $0 < first.date } ?? false)
    }

    static func growthAnswer(_ g: Growth?, now: Date = .now) -> SiriAnswer {
        guard let g else {
            return SiriAnswer(spoken: "Cybercab Hunter doesn't have two Texas DMV snapshots in that period to compare.")
        }
        var line = "Between the \(day(g.from, now: now)) and \(day(g.to, now: now)) Texas DMV snapshots, the roster went from \(n(g.startTotal)) to \(n(g.endTotal)) VINs"
        if let p = g.percent, g.net != 0 { line += ", \(g.net > 0 ? "up" : "down") \(n(abs(g.net))), or \(String(format: "%.1f", abs(p))) percent" }
        else if g.net == 0 { line += ", no net change" }
        line += "."
        var parts = [line]
        if g.endCybercab != g.startCybercab { parts.append("Cybercab VINs went from \(n(g.startCybercab)) to \(n(g.endCybercab)).") }
        if let newly = g.newlyDetected { parts.append("Cybercab Hunter first detected \(plural(newly, "additional VIN", "additional VINs")) in that period.") }
        else { parts.append("Which VINs were newly detected is still being processed.") }
        if g.clampedStart { parts.append("Tracking began \(day(g.from, now: now)), so that's the earliest comparison available.") }
        return SiriAnswer(spoken: parts.joined(separator: " "),
                          figures: [.init(value: n(g.startTotal), label: shortDay(g.from)), .init(value: n(g.endTotal), label: shortDay(g.to)),
                                    .init(value: (g.net >= 0 ? "+" : "−") + n(abs(g.net)), label: "Net")],
                          footnote: "Newly detected means first seen in a snapshot, not registered on that date.")
    }

    // MARK: one vehicle's history

    static func vehicleHistory(_ d: VehicleDetail, sightings: [VehicleSightings.Entry], dmvFirst: (date: String, baseline: Bool)?, now: Date = .now) -> SiriAnswer {
        let v = d.vehicle
        let name = v.licensePlate.map { "Plate \(spell($0))" } ?? "This vehicle"
        let kind = v.isApprovedCybercab ? "a verified Cybercab" : (v.model.map { "a \($0)" } ?? "a vehicle")
        let city = v.serviceArea ?? d.history.cities.first
        var parts = ["\(name) is \(kind)\(city.map { " in \($0)" } ?? "") in Cybercab Hunter's registry."]
        if let first = v.firstSeenAt.flatMap(instant) {
            var line = "It was first reported on \(day(iso(first), now: now))"
            if let last = v.lastSeenAt.flatMap(instant), iso(last) != iso(first) { line += " and most recently on \(day(iso(last), now: now))" }
            parts.append(line + ".")
        }
        let sorted = sightings.sorted { $0.date > $1.date }
        if let latest = sorted.first {
            parts.append("It has \(plural(sightings.count, "approved public sighting", "approved public sightings")), the latest on \(day(latest.date, now: now))\(latest.serviceArea.map { " in \($0)" } ?? "").")
        } else {
            parts.append("Cybercab Hunter doesn't have a public sighting history for it yet.")
        }
        if let rides = d.history.tripCount, rides > 0 { parts.append("\(plural(rides, "ride is", "rides are")) recorded.") }
        if let dmvFirst {
            parts.append(dmvFirst.baseline
                ? "Its VIN was already on the Texas DMV roster when tracking began on \(day(dmvFirst.date, now: now))."
                : "Its VIN first appeared in the \(day(dmvFirst.date, now: now)) Texas DMV dataset.")
        }
        var figures = [SiriAnswer.Figure(value: n(sightings.count), label: "Sightings")]
        if let r = d.history.tripCount { figures.append(.init(value: n(r), label: "Rides")) }
        return SiriAnswer(spoken: parts.joined(separator: " "), figures: figures,
                          footnote: "Reports are individual moments, not continuous operation between them.")
    }

    static func iso(_ d: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = central; f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    // MARK: service zones

    /// Where each city's area figure comes from (worker/service-areas.js).
    static func zoneSource(_ key: String) -> String {
        switch key {
        case "austin": "Cybercab Hunter's mapped boundary, traced from Tesla's in-app map, not an official Tesla figure"
        case "dallas": "Tesla's own figure"
        default: "an approximate figure"
        }
    }

    static func zone(_ s: HomepageStats, now: Date = .now) -> SiriAnswer {
        guard let sq = s.area?.squareMiles else {
            return SiriAnswer(spoken: "Cybercab Hunter doesn't have a coverage figure for \(s.name).")
        }
        var parts = ["The \(s.name) service area covers about \(n(Int(sq.rounded()))) square miles. That's \(zoneSource(s.city))."]
        if let since = s.area?.inServiceSince { parts.append("Service there began \(day(since, now: now)).") }
        return SiriAnswer(spoken: parts.joined(separator: " "), figures: [.init(value: n(Int(sq.rounded())), label: "\(s.name) mi²")])
    }

    static func compareZones(_ a: HomepageStats, _ b: HomepageStats) -> SiriAnswer {
        guard let x = a.area?.squareMiles, let y = b.area?.squareMiles, y > 0 else {
            return SiriAnswer(spoken: "Cybercab Hunter doesn't have coverage figures for both cities.")
        }
        let ratio = x / y
        return SiriAnswer(spoken: "\(a.name) covers about \(n(Int(x.rounded()))) square miles and \(b.name) about \(n(Int(y.rounded()))), so \(a.name)'s area is about \(String(format: "%.1f", ratio)) times larger. \(a.name)'s figure is \(zoneSource(a.city)); \(b.name)'s is \(zoneSource(b.city)).",
                          figures: [.init(value: n(Int(x.rounded())), label: "\(a.name) mi²"), .init(value: n(Int(y.rounded())), label: "\(b.name) mi²")])
    }
}

// MARK: - One location fix (Cybercabs near me)

enum LocationFailure: Error, Equatable {
    case notDetermined, denied, unavailable
}

/// One fix, when the rider has allowed location ("While Using" — approximate
/// is fine). Never asks from the background, never tracks, never stores it.
@MainActor
final class OneShotLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, any Error>?

    static var status: CLAuthorizationStatus { CLLocationManager().authorizationStatus }
    static var isPrecise: Bool { CLLocationManager().accuracyAuthorization == .fullAccuracy }

    static func current(timeout: Duration = .seconds(10)) async throws -> CLLocation {
        let finder = OneShotLocation()
        return try await finder.fetch(timeout: timeout)
    }

    private func fetch(timeout: Duration) async throws -> CLLocation {
        switch manager.authorizationStatus {
        case .notDetermined: throw LocationFailure.notDetermined
        case .denied, .restricted: throw LocationFailure.denied
        default: break
        }
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        return try await withCheckedThrowingContinuation { c in
            continuation = c
            manager.requestLocation()
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                self.finish(.failure(LocationFailure.unavailable))   // no fix in time
            }
        }
    }

    /// Resolves the request once (a fix, a failure or the timeout, whichever is first).
    private func finish(_ result: Result<CLLocation, any Error>) {
        guard let c = continuation else { return }
        continuation = nil
        c.resume(with: result)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in self.finish(.success(last)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        Task { @MainActor in self.finish(.failure(LocationFailure.unavailable)) }
    }
}
