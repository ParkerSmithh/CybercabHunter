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
}
