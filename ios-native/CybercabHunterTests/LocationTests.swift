import Testing
import CoreLocation
import Foundation
@testable import CybercabHunter

@MainActor
private final class MockLocation: LocationProvider {
    var authorizationStatus: CLAuthorizationStatus = .notDetermined
    var accuracyAuthorization: CLAccuracyAuthorization = .fullAccuracy
    weak var delegate: CLLocationManagerDelegate?
    var permissions = 0, requests = 0, stops = 0
    func requestWhenInUseAuthorization() { permissions += 1 }
    func requestLocation() { requests += 1 }
    func stopUpdatingLocation() { stops += 1 }
}

struct LocationTests {
    @Test @MainActor func permissionIsExplicitAndOneShot() {
        let mock = MockLocation(), service = LocationService(provider: MockLocation())
        #expect(!service.requesting)
        let subject = LocationService(provider: mock, servicesEnabled: { true })
        #expect(mock.permissions == 0 && mock.requests == 0)
        subject.request(); subject.request()
        #expect(mock.permissions == 1 && mock.requests == 0)
        mock.authorizationStatus = .authorizedWhenInUse
        subject.authorizationChanged()
        #expect(mock.requests == 1)
        mock.accuracyAuthorization = .reducedAccuracy
        subject.receive([CLLocation(coordinate: .init(latitude: 30, longitude: -97), altitude: 0, horizontalAccuracy: 1000, verticalAccuracy: -1, timestamp: .now)])
        #expect(subject.reducedAccuracy && !subject.requesting && subject.location != nil)
        #expect(mock.stops == 1)
        mock.authorizationStatus = .denied; subject.authorizationChanged()
        #expect(subject.location == nil && subject.canOpenSettings)
        mock.authorizationStatus = .authorizedWhenInUse; subject.authorizationChanged()
        #expect(mock.requests == 1) // Settings doesn't implicitly start GPS
    }
    @Test @MainActor func settingsAccuracyChangeInvalidatesOldFixWithoutRequestingGPS() {
        let mock = MockLocation(); mock.authorizationStatus = .authorizedWhenInUse
        let service = LocationService(provider: mock, servicesEnabled: { true })
        service.request(); service.receive([CLLocation(latitude: 30, longitude: -97)])
        #expect(service.location != nil)
        mock.accuracyAuthorization = .reducedAccuracy
        service.authorizationChanged()
        #expect(service.location == nil && service.reducedAccuracy)
        #expect(service.message?.contains("accuracy changed") == true)
        #expect(mock.requests == 1)
    }
    @Test @MainActor func deniedRestrictedAndDisabled() {
        for state in [CLAuthorizationStatus.denied, .restricted] {
            let mock = MockLocation(); mock.authorizationStatus = state
            let service = LocationService(provider: mock, servicesEnabled: { true }); service.request()
            #expect(service.message != nil && mock.permissions == 0 && mock.requests == 0)
        }
        let mock = MockLocation()
        let disabled = LocationService(provider: mock, servicesEnabled: { false }); disabled.request()
        #expect(disabled.message != nil && !disabled.requesting)
    }
    @Test @MainActor func staleInvalidAndCancelledResultsIgnored() {
        let mock = MockLocation(); mock.authorizationStatus = .authorizedWhenInUse
        let service = LocationService(provider: mock, servicesEnabled: { true }); service.request()
        service.receive([CLLocation(coordinate: .init(latitude: 30, longitude: -97), altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: .distantPast)])
        #expect(service.location == nil && service.requesting)
        service.cancel(); service.receive([CLLocation(latitude: 30, longitude: -97)])
        #expect(service.location == nil && !service.requesting)
    }
    @Test @MainActor func timeoutAndUnavailable() async throws {
        let mock = MockLocation(); mock.authorizationStatus = .authorizedWhenInUse
        let service = LocationService(provider: mock, timeoutDuration: .milliseconds(1), servicesEnabled: { true })
        service.request()
        try await Task.sleep(for: .milliseconds(30))
        #expect(service.message?.contains("timed out") == true && !service.requesting)
        service.request()
        service.locationManager(CLLocationManager(), didFailWithError: CLError(.locationUnknown))
        #expect(service.message?.contains("Couldn't") == true && service.location == nil)
    }
    private func ring(_ x: Double, _ y: Double, _ size: Double) -> [CLLocationCoordinate2D] {
        [(x,y),(x+size,y),(x+size,y+size),(x,y+size)].map { .init(latitude: $0.1, longitude: $0.0) }
    }
    private func fix(_ x: Double, _ y: Double, accuracy: Double = 5) -> CLLocation {
        CLLocation(coordinate: .init(latitude: y, longitude: x), altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: .now)
    }
    @Test func zonesHolesOverlapAndUncertainty() {
        let a = ZoneProximity.Zone(name: "Austin", polygons: [[ring(-98,30,1),ring(-97.8,30.2,0.2)]])
        let d = ZoneProximity.Zone(name: "Dallas", polygons: [[ring(-97,32,1)]])
        #expect(ZoneProximity.evaluate(fix(-97.9,30.1), zones: [a,d]).text == "Inside Austin service zone")
        #expect(ZoneProximity.evaluate(fix(-96.5,32.5), zones: [a,d]).text == "Inside Dallas service zone")
        #expect(ZoneProximity.evaluate(fix(-97.7,30.3), zones: [a,d]).text.contains("Outside"))
        #expect(ZoneProximity.evaluate(fix(-98,30.5), zones: [a,d]).text.contains("cannot confirm"))
        #expect(ZoneProximity.evaluate(fix(-97.99,30.5,accuracy: 5000), zones: [a,d]).nearest == nil)
        let overlap = ZoneProximity.Zone(name: "Other", polygons: a.polygons)
        #expect(ZoneProximity.evaluate(fix(-97.9,30.1), zones: [a,overlap]).text.contains("overlap"))
        #expect(ZoneProximity.evaluate(fix(-100,29), zones: []).text.contains("unavailable"))
        #expect(ZoneProximity.evaluate(fix(-100,29), zones: [.init(name: "Bad", polygons: [[[]]])]).text.contains("unavailable"))
    }
    @Test func nearestBoundaryAndMultipolygon() {
        let zone = ZoneProximity.Zone(name: "Dallas", polygons: [[ring(-97,32,1)],[ring(-95,32,0.1)]])
        let result = ZoneProximity.evaluate(fix(-97.1,32.5), zones: [zone])
        #expect(result.text.contains("Outside") && result.text.contains("Dallas"))
        #expect(abs(result.nearest!.longitude + 97) < 0.0001)
        let distance = ZoneProximity.distance(fix(-97.1,32.5).coordinate, result.nearest!)
        #expect(distance > 9000 && distance < 9500)
        #expect(ZoneProximity.evaluate(fix(-94.95,32.05), zones: [zone]).text.contains("Inside"))
    }
}
