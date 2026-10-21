import Testing
import Foundation
@testable import CybercabHunter

/// The Swift port of public/js/forecast.js against the JS itself: every case
/// in Fixtures/forecast-cases.json was produced by running the website's
/// forecast.js (real registry series, the real DMV series, a synthetic series
/// with gaps / a decrease / a spike / approximate points, a short and an empty
/// history) at 7, 30 and 90 days.
struct ForecastTests {
    struct File: Decodable { let endMs: Double; let cases: [Case] }
    struct Case: Decodable {
        let name: String
        let horizon: Int
        let observations: [Obs]
        let result: Expected
    }
    struct Obs: Decodable { let t: Double; let value: Double; let approx: Bool }
    struct Expected: Decodable {
        let ok: Bool
        let reason: String?
        let current: Int?
        let rate: Double?
        let approx: Bool?
        let points: [P]?
        struct P: Decodable { let t: Double; let value: Int; let low: Int; let high: Int }
    }

    @Test func matchesTheWebsitesForecastJS() throws {
        let file = try JSONDecoder().decode(File.self, from: TestFixtures.data("forecast-cases"))
        #expect(file.cases.count == 18)
        for c in file.cases {
            let obs = c.observations.map { Forecast.Observation(t: $0.t, value: $0.value, approx: $0.approx) }
            let r = Forecast.forecast(obs, horizonDays: c.horizon, endMs: file.endMs)
            switch r {
            case .unavailable(let reason):
                #expect(!c.result.ok, "\(c.name)/\(c.horizon) should forecast")
                #expect(reason == c.result.reason, "\(c.name)/\(c.horizon)")
            case .ok(_, let current, let rate, _, let approx, let points):
                #expect(c.result.ok, "\(c.name)/\(c.horizon) should be unavailable")
                #expect(current == c.result.current)
                #expect(abs(rate - (c.result.rate ?? -1)) < 1e-9, "\(c.name)/\(c.horizon) rate")
                #expect(approx == c.result.approx)
                let expected = c.result.points ?? []
                #expect(points.count == expected.count)
                for (a, b) in zip(points, expected) {
                    #expect(a.t == b.t && a.value == b.value && a.low == b.low && a.high == b.high, "\(c.name)/\(c.horizon) at \(b.t): \(a) vs \(b.value) [\(b.low)-\(b.high)]")
                }
            }
        }
    }

    @Test func neverBelowTheLatestActualAndNeverDecreasing() {
        let day = Forecast.day
        let end = 1_800_000_000_000.0
        var obs: [Forecast.Observation] = []
        for i in 0..<30 {
            let value: Double = i % 3 == 0 ? Double(i) : Double(i - 1)
            obs.append(Forecast.Observation(t: end - Double(30 - i) * day, value: value))
        }
        guard case .ok(_, let current, _, _, _, let points) = Forecast.forecast(obs, horizonDays: 90, endMs: end) else {
            Issue.record("expected a forecast")
            return
        }
        for p in points {
            #expect(p.value >= current && p.low >= current)
            #expect(p.low <= p.value && p.high >= p.value)
        }
        for i in 1..<points.count { #expect(points[i - 1].value <= points[i].value) }
    }
}
