import Testing
import Foundation
@testable import CybercabHunter

/// Real responses from cybercabhunter.com (Oct 20, 2026), decoded with the
/// app's decoder. Regression: Foundation's .convertFromSnakeCase made
/// "last_24h" → "last24H" and silently dropped every _24h/_30d/_7d field.
struct ModelDecodingTests {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        let url = try #require(Bundle(for: BundleToken.self).url(forResource: name, withExtension: "json"))
        return try APIClient.makeDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    @Test func keyConversion() {
        #expect(APIClient.camelCase("last_24h") == "last24h")
        #expect(APIClient.camelCase("vehicles_added_prev_7d") == "vehiclesAddedPrev7d")
        #expect(APIClient.camelCase("model_y_30d") == "modelY30d")
        #expect(APIClient.camelCase("last_7_days") == "last7Days")
        #expect(APIClient.camelCase("public_vehicles") == "publicVehicles")
        #expect(APIClient.camelCase("total") == "total")
    }

    @Test func homepageStats() throws {
        let d: HomepageStats = try fixture("homepage-stats-austin")
        #expect(d.name == "Austin")
        #expect(d.area?.vehiclesAdded7d == 18)
        #expect(d.area?.vehiclesAddedPrev7d == 100)
        #expect(d.area?.hours == HomepageStats.Hours(open: "06:00", close: "24:00"))
        #expect(d.rides?.rides30d == 7)
        #expect(d.rides?.weeklyFares?.isEmpty == false)
        #expect(d.sightings?.last24h == 9)
        #expect(d.sightings?.prev24h == 12)
        #expect(d.sightings?.last7Days == 73)
        #expect(d.sightings?.total == 219)
        #expect(d.sightings?.peakHour?.hour == 17)
        #expect(d.sightings?.latest?.first?.imageURL?.host == "cybercabhunter.com")
        #expect(d.cameras?.detections24h == 9)
        #expect(d.cameras?.reporting24h == 6)
        #expect(d.cameras?.monitored == 70)
    }

    @Test func dmvRegistrations() throws {
        let d: DMVRegistrations = try fixture("dmv-registrations")
        #expect(d.snapshot?.modelY == 454)
        #expect(d.new?.d30 == 358)
        #expect(d.new?.cybercab30d == 293)
        #expect(d.new?.modelY30d == 65)
        #expect(d.matched?.spotted30d == 173)
        #expect((d.series ?? []).count > 10)
    }

    @Test func dailyAndRegistry() throws {
        let daily: DailyReport = try fixture("daily")
        #expect(daily.day.date == daily.today)
        let list: VehicleList = try fixture("vehicles")
        #expect(list.total == 182)
        let first = try #require(list.vehicles.first)
        #expect(first.licensePlate == "XVF1524" && first.isApprovedCybercab && first.city == "Austin")
        #expect(first.totalDistance == 4.3)
        let detail: VehicleDetail = try fixture("vehicle")
        #expect(detail.vehicle.vin == "5YJAJEEU3TA002449")
        #expect(detail.history.cities == ["Austin"])
    }
}

private final class BundleToken {}
