import Testing
import Foundation
import AppIntents
import SwiftUI
@testable import CybercabHunter

// Phase 6: App Intents (Siri, Shortcuts, Spotlight), the widgets' shared data
// (FleetSnapshot) and their links. Fixtures are real Worker responses.

private let stats = #"{"public_vehicles":190,"recorded_rides":8,"sightings_all_time":512}"#

@MainActor
struct FleetSnapshotTests {
    private func stub(daily: (Int, String)? = (200, CommunityStub.fixture("daily")), stats: (Int, String) = (200, stats)) -> StubServer {
        let s = StubServer()
        s.responses = ["GET /api/registry/stats": stats]
        if let daily { s.responses["GET /api/daily"] = daily }
        return s
    }

    @Test func countersAndToday() async throws {
        let s = stub(), api = s.api()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let snap = try await FleetSnapshot.load(base: api.baseURL, session: api.session, now: now)
        #expect(snap.registered == 190 && snap.rides == 8 && snap.sightings == 512 && snap.fetchedAt == now)
        #expect(snap.date == "2026-10-20" && snap.todayNewCybercabs == 1 && snap.todaySightings == 5 && snap.todayDetections == 5)
        #expect(snap.todayLine == "Today: +1 Cybercab · 5 sightings · 5 camera detections")
        #expect(snap.spokenSummary == "Cybercab Hunter has 190 registered Cybercabs, 8 recorded rides and 512 sightings. Today: +1 Cybercab · 5 sightings · 5 camera detections.")
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil }, "public endpoints, never a session")
    }

    @Test func dailyIsBestEffortCountersAreNot() async throws {
        let noDaily = stub(daily: (503, #"{"error":"x"}"#)), api = noDaily.api()
        let snap = try await FleetSnapshot.load(base: api.baseURL, session: api.session)
        #expect(snap.registered == 190 && snap.date == nil && snap.todayLine == nil)
        #expect(snap.spokenSummary == "Cybercab Hunter has 190 registered Cybercabs, 8 recorded rides and 512 sightings.")
        let broken = stub(stats: (500, "{}")), api2 = broken.api()
        await #expect(throws: FleetSnapshot.LoadError.self) { try await FleetSnapshot.load(base: api2.baseURL, session: api2.session) }
        let garbled = stub(stats: (200, #"{"unexpected":true}"#)), api3 = garbled.api()
        await #expect(throws: FleetSnapshot.LoadError.unreadable) { try await FleetSnapshot.load(base: api3.baseURL, session: api3.session) }
    }

    @Test func snapshotsSurviveACacheRoundTrip() throws {
        let s = FleetSnapshot(registered: 1, rides: 2, sightings: 3, date: "2026-10-22", todayNewCybercabs: 0, todaySightings: 1, todayDetections: nil, fetchedAt: Date(timeIntervalSince1970: 5))
        #expect(try JSONDecoder().decode(FleetSnapshot.self, from: JSONEncoder().encode(s)) == s, "the widget keeps its last good answer")
        #expect(s.todayLine == "Today: +0 Cybercabs · 1 sighting")
    }
}

@MainActor
struct WidgetLinkTests {
    @Test func linksOpenTheirTab() {
        let r = AppRouter()
        #expect(WidgetLink.url("zones", city: "dallas").absoluteString == "cybercabhunter-widget://zones?city=dallas")
        #expect(r.open(widgetURL: WidgetLink.url("zones", city: "dallas")) && r.selectedTab == .zones && r.zonesCity == "dallas")
        #expect(r.open(widgetURL: WidgetLink.url("sightings")) && r.selectedTab == .sightings)
        #expect(r.open(widgetURL: WidgetLink.url("registry")) && r.selectedTab == .registry)
        #expect(r.open(widgetURL: WidgetLink.url("nonsense")) && r.selectedTab == .home, "an unknown tab is Home")
        #expect(!r.open(widgetURL: URL(string: "https://cybercabhunter.com/community?post=abc")!), "website links go to the Community handler")
        #expect(!r.open(widgetURL: URL(string: "cybercabhunter://oauth?code=x")!), "the sign-in callback scheme is never treated as a widget link")
    }
}

@MainActor
struct AppIntentTests {
    @Test func openZonesAndSubmitRouteNatively() async throws {
        let r = AppRouter.shared
        var zones = OpenZonesIntent()
        zones.city = .dallas
        _ = try await zones.perform()
        #expect(r.selectedTab == .zones && r.zonesCity == "dallas")
        r.zonesCity = nil
        _ = try await SubmitSightingIntent().perform()
        #expect(r.selectedTab == .sightings && r.submitSightingRequested)
        r.submitSightingRequested = false
        #expect(OpenZonesIntent.openAppWhenRun && SubmitSightingIntent.openAppWhenRun && !FleetStatsIntent.openAppWhenRun, "stats answer in Siri without opening the app")
    }

    @Test func openVehicleUsesTheCarsTab() async throws {
        let r = AppRouter.shared
        var open = OpenVehicleIntent()
        open.target = VehicleEntity(id: "824ca2c7-14c7-4f8b-820f-c34d2be10bcc", plate: "XVF1524", city: "Austin", rides: 1)
        _ = try await open.perform()
        #expect(r.selectedTab == .registry && r.registryPath.count == 1)
        r.registryPath = NavigationPathProbe.empty
    }

    @Test func vehicleEntitiesFromTheRegistry() async throws {
        let s = StubServer()
        s.responses = ["GET /api/robotaxi-vehicles": (200, CommunityStub.fixture("vehicles")),
                       "GET /api/robotaxi-vehicles/824ca2c7-14c7-4f8b-820f-c34d2be10bcc": (200, CommunityStub.fixture("vehicle"))]
        VehicleDirectory.testAPI = s.api(token: nil)
        defer { VehicleDirectory.testAPI = nil }
        let found = try await VehicleQuery().entities(matching: " xvf1524 ")
        #expect(!found.isEmpty && found[0].plate == "XVF1524")
        let q = s.requests.last?.0.url?.query() ?? ""
        #expect(q.contains("q=xvf1524") && q.contains("limit=10"), "\(q)")
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil }, "never sends a session")
        let byId = try await VehicleQuery().entities(for: ["824ca2c7-14c7-4f8b-820f-c34d2be10bcc", "missing-id"])
        #expect(byId.map(\.plate) == ["XVF1524"], "an id that isn't public is simply left out")
        let e = byId[0]
        #expect(e.city == "Austin" && e.attributeSet.keywords?.contains("Cybercab") == true && e.attributeSet.keywords?.contains("XVF1524") == true)
        let suggested = try await VehicleQuery().suggestedEntities()
        #expect(suggested.count == 3)
    }

    @Test func spotlightIndexAtMostOnceADay() async throws {
        let s = StubServer()
        s.responses = ["GET /api/robotaxi-vehicles": (200, CommunityStub.fixture("vehicles"))]
        let defaults = UserDefaults(suiteName: "phase6-\(UUID().uuidString)")!
        let now = Date()
        await VehicleDirectory.indexInSpotlight(api: s.api(token: nil), now: now, defaults: defaults)
        let first = s.requests.count
        #expect(first >= 1)
        await VehicleDirectory.indexInSpotlight(api: s.api(token: nil), now: now.addingTimeInterval(3600), defaults: defaults)
        #expect(s.requests.count == first, "not again within a day")
        await VehicleDirectory.indexInSpotlight(api: s.api(token: nil), now: now.addingTimeInterval(25 * 3600), defaults: defaults)
        #expect(s.requests.count > first, "again the next day")
        let failing = StubServer()
        failing.responses = ["GET /api/robotaxi-vehicles": (500, "{}")]
        let d2 = UserDefaults(suiteName: "phase6-\(UUID().uuidString)")!
        await VehicleDirectory.indexInSpotlight(api: failing.api(token: nil), now: now, defaults: d2)
        #expect(d2.object(forKey: "spotlightIndexedAt") == nil, "a failed fetch is tried again next launch")
    }

    @Test func intentFailuresReadWell() {
        #expect(String(localized: IntentFailure.unavailable.localizedStringResource).contains("couldn't be reached"))
        #expect(ServiceCity.allCases.map(\.rawValue) == ["austin", "dallas"])
    }
}

/// An empty NavigationPath (kept out of the test bodies for readability).
private enum NavigationPathProbe { @MainActor static var empty: SwiftUI.NavigationPath { .init() } }
