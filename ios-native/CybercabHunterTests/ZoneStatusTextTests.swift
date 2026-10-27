import Testing
import CoreLocation
@testable import CybercabHunter

struct ZoneStatusTextTests {
    @Test func insideAndOverlapStayExplicitAndUppercase() {
        for text in ["Inside Austin service zone", "Inside Dallas service zone", "Inside Austin and Dallas service zones (overlap)"] {
            #expect(ZoneStatusText.headline(.init(text: text, nearest: nil)) == text.uppercased())
        }
    }
    @Test func outsideIsCompactWithoutDiscardingDistance() {
        let result = ZoneProximity.Result(text: "Outside mapped service zones. Nearest: Dallas — approximately 4.2 miles away (straight-line)", nearest: .init(latitude: 32.8, longitude: -96.8))
        #expect(ZoneStatusText.headline(result) == "OUTSIDE SERVICE ZONES")
        #expect(result.text.contains("4.2") && result.nearest != nil)
    }
    @Test func accuracyDataAndPermissionStatesAreDistinct() {
        #expect(ZoneStatusText.headline(.init(text: "Near Dallas boundary — accuracy cannot confirm coverage", nearest: nil)) == "ZONE BOUNDARY UNCERTAIN")
        #expect(ZoneStatusText.headline(.init(text: "Service-zone data unavailable", nearest: nil)) == "ZONE DATA UNAVAILABLE")
        #expect(ZoneStatusText.headline(.init(text: "Location unavailable", nearest: nil)) == "LOCATION UNAVAILABLE")
        #expect(ZoneStatusText.headline(nil) == "LOCATION UNAVAILABLE")
        #expect(ZoneStatusText.headline(nil, requesting: true) == "FINDING LOCATION")
    }
}
