import Foundation

/// Fleet forecasts ("Actual + Predictions"): an exact port of the website's
/// public/js/forecast.js, so the app projects what the site projects.
/// ForecastTests checks the port against the JS on the same inputs.
///   1. Daily additions on a UTC day grid; a gap's change is spread evenly
///      over it; decreases add nothing.
///   2. Spike damping: each day counts for at most max(Tukey fence of active
///      days, 2× the mean daily addition).
///   3. Rates: last 7 days, last 30 days, all history, blended 50/30/20.
///   4. Linear projection, the rate tapering toward the 30-day pace
///      (half-life 21 days); rounded, never below the latest actual, never decreasing.
///   5. An 80% band: 1.28 × the spread of the damped additions × √days ahead,
///      ×1.5 when the recent history has approximate counts.
///   Under 14 days of history or fewer than 3 days with additions: no forecast.
enum Forecast {
    static let day: Double = 86_400_000
    static let minSpanDays = 14
    static let minActiveDays = 3
    static let taperHalfLife = 21.0
    static let z80 = 1.28

    struct Observation: Equatable { let t: Double; let value: Double; var approx = false }
    struct Point: Equatable { let t: Double; let value: Int; let low: Int; let high: Int }
    struct Rates: Equatable { let r7: Double; let r30: Double; let all: Double }

    enum Result: Equatable {
        case ok(start: Double, current: Int, rate: Double, rates: Rates, approx: Bool, points: [Point])
        case unavailable(reason: String)
    }

    struct DayAdd { let day: Int; let add: Double; let approx: Bool }

    static func dayIndex(_ ms: Double) -> Int { Int((ms / day).rounded(.down)) }
    static func mean(_ a: [Double]) -> Double { a.isEmpty ? 0 : a.reduce(0, +) / Double(a.count) }

    static func quantile(_ sorted: [Double], _ q: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        let pos = Double(sorted.count - 1) * q
        let lo = Int(pos.rounded(.down)), hi = Int(pos.rounded(.up))
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - Double(lo))
    }

    static func dailyAdditions(_ observations: [Observation], endMs: Double) -> (days: [DayAdd], lastValue: Double, firstDay: Int, endDay: Int)? {
        let obs = observations.filter { $0.t.isFinite && $0.value.isFinite && $0.t <= endMs }
            .map { (day: dayIndex($0.t), value: $0.value, approx: $0.approx) }
            .enumerated().sorted { $0.element.day != $1.element.day ? $0.element.day < $1.element.day : $0.offset < $1.offset }
            .map(\.element)
        guard !obs.isEmpty else { return nil }
        var byDay: [(day: Int, value: Double, approx: Bool)] = []
        for o in obs {
            if let last = byDay.last, last.day == o.day { byDay[byDay.count - 1] = o } else { byDay.append(o) }
        }
        var days: [DayAdd] = []
        for i in 1..<max(1, byDay.count) where byDay.count > 1 {
            let a = byDay[i - 1], b = byDay[i], gap = b.day - a.day
            let per = max(0, b.value - a.value) / Double(gap)
            for k in 1...gap { days.append(DayAdd(day: a.day + k, add: per, approx: a.approx || b.approx || gap > 1)) }
        }
        let last = byDay[byDay.count - 1], endDay = dayIndex(endMs)
        if last.day + 1 <= endDay { for d in (last.day + 1)...endDay { days.append(DayAdd(day: d, add: 0, approx: false)) } }
        return (days, last.value, byDay[0].day, endDay)
    }

    static func dampCap(_ adds: [Double]) -> Double {
        let active = adds.filter { $0 > 0 }.sorted()
        guard !active.isEmpty else { return 0 }
        let q1 = quantile(active, 0.25), q3 = quantile(active, 0.75)
        return max(q3 + 1.5 * (q3 - q1), 2 * mean(adds))
    }

    /// js/forecast.js round(): halves round up (toward +∞), as JavaScript's Math.round.
    static func jsRound(_ v: Double) -> Int { Int((v + 0.5).rounded(.down)) }

    static func forecast(_ observations: [Observation], horizonDays: Int = 30, endMs: Double = Date.now.timeIntervalSince1970 * 1000) -> Result {
        let horizon = max(1, min(365, horizonDays))
        guard let series = dailyAdditions(observations, endMs: endMs) else { return .unavailable(reason: "No history yet, so there is nothing to project from.") }
        let span = series.endDay - series.firstDay
        let adds = series.days.map(\.add)
        let activeDays = series.days.filter { $0.add > 0 }.count
        if span < minSpanDays { return .unavailable(reason: "Only \(span) day\(span == 1 ? "" : "s") of history so far; a reliable forecast needs at least \(minSpanDays).") }
        if activeDays < minActiveDays { return .unavailable(reason: "Too few days with new vehicles (\(activeDays)) to estimate a growth rate.") }
        let cap = dampCap(adds)
        let damped = adds.map { min($0, cap) }
        func tail(_ n: Int) -> [Double] { Array(damped.suffix(n)) }
        let rates = Rates(r7: mean(tail(7)), r30: mean(tail(30)), all: mean(damped))
        let blended = 0.5 * rates.r7 + 0.3 * rates.r30 + 0.2 * rates.all
        let approx = series.days.suffix(30).contains { $0.approx }
        let m30 = mean(tail(30))
        let sd = mean(tail(30).map { ($0 - m30) * ($0 - m30) }).squareRoot()
        let spread = z80 * sd * (approx ? 1.5 : 1)
        let current = series.lastValue
        let startDay = series.endDay
        var points: [Point] = []
        var cum = current
        var hi = Int(current), lo = Int(current)
        for h in 1...horizon {
            let rate = rates.r30 + (blended - rates.r30) * pow(0.5, Double(h) / taperHalfLife)
            cum += max(0, rate)
            let value = max(Int(current), jsRound(cum))
            let width = spread * Double(h).squareRoot()
            lo = max(lo, Int(current), min(value, jsRound(cum - width)))
            hi = max(hi, value, jsRound(cum + width))
            let prev = points.last?.value ?? Int(current)
            points.append(Point(t: Double(startDay + h) * day, value: max(prev, value), low: lo, high: hi))
        }
        return .ok(start: Double(startDay) * day, current: Int(current), rate: blended, rates: rates, approx: approx, points: points)
    }
}
