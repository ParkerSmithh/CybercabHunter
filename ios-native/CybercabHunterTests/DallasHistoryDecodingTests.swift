import XCTest
@testable import CybercabHunter

final class DallasHistoryDecodingTests: XCTestCase {
    func testFleetHistoryKeepsNullDays() throws {
        let json = #"{"updated_at":"2026-11-18T11:00:00Z","rows":[["2026-11-16",null,3,1,null,null],["2026-11-17",2,3,0,null,null]]}"#
        let history = try APIClient.makeDecoder().decode(FleetHistoryResponse.self, from: Data(json.utf8))
        XCTAssertNil(history.rows[0].registry)
        XCTAssertEqual(history.rows[1].registry, 2)
        XCTAssertEqual(history.rows[1].sightings, 0)
    }

    func testFareHistoryDecodesSuppressedMediansAndVehicleKeys() throws {
        let json = #"{"minimum":10,"updated_at":"2026-11-18T11:00:00Z","ranges":{"90d":{"all":{"weeks":[]},"cybercab":{"weeks":[{"week":"2026-11-16","fare":{"n":9,"median":null},"per_mile":{"n":9,"median":null}}]},"model_y":{"weeks":[]}}}}"#
        let history = try APIClient.makeDecoder().decode(FareHistoryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(history.ranges["90d"]?.cybercab.weeks.first?.fare.n, 9)
        XCTAssertNil(history.ranges["90d"]?.cybercab.weeks.first?.fare.median)
        XCTAssertEqual(history.ranges["90d"]?.modelY.weeks.count, 0)
    }

    func testOldPushPreferencesDoNotSendCityToLegacyWorker() throws {
        let preferences = try JSONDecoder().decode(PushPreferences.self, from: Data(#"{"master":true}"#.utf8))
        XCTAssertNil(preferences.city)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences)) as? [String: Any])
        XCTAssertNil(body["city"])
    }

    /// The card's city tag follows the website's rule: one tag style for every city.
    func testCityTagMatchesWebsiteRule() throws {
        func car(_ area: String?, _ areas: String?) throws -> RegistryVehicle {
            var o: [String: Any] = ["id": "v1"]
            if let area { o["service_area"] = area }
            if let areas { o["service_areas"] = areas }
            return try APIClient.makeDecoder().decode(RegistryVehicle.self, from: JSONSerialization.data(withJSONObject: o))
        }
        XCTAssertEqual(try car("Austin", nil).cityTag, "Austin")
        XCTAssertEqual(try car("dallas", nil).cityTag, "Dallas")
        XCTAssertNil(try car("Phoenix", "Dallas").cityTag)
        XCTAssertEqual(try car(nil, "Austin, Dallas").cityTag, "Dallas")
        XCTAssertEqual(try car(nil, "Austin").cityTag, "Austin")
        XCTAssertNil(try car(nil, nil).cityTag)
    }

    /// Fleet Growth: a city whose cars were all added on one day (Dallas, Nov 19 2026)
    /// gets a 30-day window ending the next day, so the day-wide strip bar is one
    /// thin bar, not a band. A span of 30+ days (Austin) is kept exactly.
    func testFleetGrowthDomainWidensASingleDayAndKeepsALongSpan() throws {
        let iso = ISO8601DateFormatter()
        let first = try XCTUnwrap(iso.date(from: "2026-11-19T20:07:12Z")), last = try XCTUnwrap(iso.date(from: "2026-11-20T01:03:53Z"))
        let dallas = FleetGrowthSection.xDomain(first: first, last: last)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = Format.central
        XCTAssertEqual(dallas.upperBound, cal.date(from: DateComponents(year: 2026, month: 11, day: 20)))
        XCTAssertEqual(dallas.upperBound.timeIntervalSince(dallas.lowerBound), 30 * 86400, accuracy: 3600)
        XCTAssertTrue(dallas.contains(first) && dallas.contains(last))
        let austinFirst = try XCTUnwrap(iso.date(from: "2026-09-03T15:00:00Z")), austinLast = try XCTUnwrap(iso.date(from: "2026-11-17T18:00:00Z"))
        XCTAssertEqual(FleetGrowthSection.xDomain(first: austinFirst, last: austinLast), austinFirst...austinLast)
    }
}
