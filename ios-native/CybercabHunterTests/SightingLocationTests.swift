import Testing
import CoreLocation
import MapKit
import Foundation
@testable import CybercabHunter

@MainActor
private final class PlaceResolverStub: SightingPlaceResolver {
    var value: String? = "Congress Avenue"
    var delay = false
    var calls = 0
    var cancels = 0
    var hints: [SightingPlaceHint] = []
    var expandedOnly = false
    var searchError: Error?
    var streetError: Error?
    var mapRequests: [(CLLocationCoordinate2D, Double)] = []
    func places(near location: CLLocation, radius: CLLocationDistance) async throws -> [SightingPlaceHint] {
        mapRequests.append((location.coordinate, radius))
        if let searchError { throw searchError }
        return expandedOnly && radius < 3000 ? [] : hints
    }
    func street(near location: CLLocation) async throws -> String? {
        calls += 1
        if let streetError { throw streetError }
        if delay { try await Task.sleep(for: .seconds(10)) }
        return value
    }
    func cancel() { cancels += 1 }
}

@MainActor
private final class SightingLocationProviderStub: LocationProvider {
    var authorizationStatus: CLAuthorizationStatus = .authorizedWhenInUse
    var accuracyAuthorization: CLAccuracyAuthorization = .fullAccuracy
    weak var delegate: CLLocationManagerDelegate?
    var prompts = 0, requests = 0
    func requestWhenInUseAuthorization() { prompts += 1 }
    func requestLocation() { requests += 1 }
    func stopUpdatingLocation() { }
}

@MainActor
struct SightingLocationTests {
    private let area = ServiceArea(key: "austin", name: "Austin")
    private func fix(accuracy: Double = 50, date: Date = .now) -> CLLocation {
        CLLocation(coordinate: .init(latitude: 30.270123, longitude: -97.740456), altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: date)
    }
    private func server() -> StubServer {
        let s = StubServer()
        s.responses["GET /api/service-areas"] = (200, #"{"areas":[{"key":"austin","name":"Austin"},{"key":"dallas","name":"Dallas"}]}"#)
        s.responses["GET /api/moderation/access"] = (200, #"{"moderator":false}"#)
        s.responses["GET /api/places"] = (200, #"{"places":[{"id":"W:1","label":"Congress Avenue, Austin, TX","city":"Austin"},{"id":"W:2","label":"Far Street, Austin, TX","city":"Austin"}]}"#)
        s.responses["GET /api/places/map"] = (200, #"{"places":[{"id":"W:1","label":"Congress Avenue, Austin, TX","lat":30.2701,"lng":-97.7404},{"id":"W:2","label":"Far Street, Austin, TX","lat":30.4,"lng":-97.74}]}"#)
        return s
    }
    private func submission(_ s: StubServer) async -> SubmitSightingModel {
        let m = SubmitSightingModel(); await m.load(api: s.api()); m.cityName = "Austin"
        return m
    }
    @Test func noLookupBeforeExplicitRequest() async {
        let r = PlaceResolverStub(), s = server()
        let m = SightingLocationModel(resolver: r)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .disclosure && s.requests.isEmpty && r.calls == 0)
    }
    @Test func compatibleNearbyIDsOnlyAndConfirmationDoesNotSubmit() async {
        let s = server(), r = PlaceResolverStub()
        let m = SightingLocationModel(resolver: r)
        let form = await submission(s)
        form.locationText = "Existing manual text"; form.notes = "Keep these notes"
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .choosing && m.suggestions.map(\.id) == ["W:1"])
        #expect(form.place == nil && form.locationText == "Existing manual text")
        #expect(m.confirm("W:1", in: form))
        let fields = Dictionary(form.form().fields, uniquingKeysWith: { a, _ in a })
        #expect(fields["location_id"] == "W:1" && fields["location_query"] == "Congress Avenue")
        #expect(fields["approx_location"] == "Congress Avenue, Austin, TX")
        #expect(form.notes == "Keep these notes" && !form.sending && form.outcome == .editing)
        #expect(s.requests.allSatisfy { $0.0.httpMethod == "GET" })
        #expect(r.calls == 1)
        form.locationText = "Edited after confirmation"; form.locationEdited()
        #expect(form.place == nil)
    }
    @Test func coordinatesNeverEnterBackendQueriesOrForm() async {
        let s = server(), m = SightingLocationModel(resolver: PlaceResolverStub())
        let form = await submission(s)
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api()); #expect(m.confirm("W:1", in: form))
        let lookups = s.requests.filter { $0.0.url?.path.contains("places") == true }
        #expect(lookups.count == 2)
        for (request, body) in lookups {
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            #expect(Set(query.map(\.name)).isSubset(of: ["q", "area", "v"]))
            #expect(query.first { $0.name == "q" }?.value == "Congress Avenue")
            #expect(body.isEmpty)
        }
        let text = form.form().fields.map { "\($0.0)=\($0.1)" }.joined(separator: "&")
        #expect(!text.contains("30.270123") && !text.contains("97.740456") && !text.contains("latitude") && !text.contains("longitude"))
    }
    @Test func incompatibleIDsMissingCoordinatesAndFarPlacesFallBack() async {
        for mapped in [#"{"places":[]}"#, #"{"places":[{"id":"W:999","label":"Other","lat":30.2701,"lng":-97.7404}]}"#, #"{"places":[{"id":"W:1","label":"Wrong city","lat":32.8,"lng":-96.8}]}"#, #"{"places":[{"id":"W:1","label":"Invalid","lat":100,"lng":-97}]}"#] {
            let s = server(), m = SightingLocationModel(resolver: PlaceResolverStub())
            s.responses["GET /api/places/map"] = (200, mapped)
            m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
            #expect(m.phase == .failed && m.suggestions.isEmpty && m.message?.contains("manually") == true)
        }
    }
    @Test func realNumericAddressesRemainSelectableButFabricatedIDsDoNot() async {
        let s = server(), m = SightingLocationModel(resolver: PlaceResolverStub())
        s.responses["GET /api/places"] = (200, #"{"places":[{"id":"W:1","label":"123 Congress Avenue, Austin, TX","city":"Austin"},{"id":"fake","label":"Congress Avenue, Austin, TX","city":"Austin"}]}"#)
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .choosing && m.suggestions.map(\.id) == ["W:1"])
    }
    @Test func reducedAccuracyAndStaleFixFailBeforeAppleLookup() async {
        for f in [fix(accuracy: 2000),fix(date: .distantPast),fix(accuracy: -1)] {
            let s = server(), r = PlaceResolverStub(), m: SightingLocationModel
            m = SightingLocationModel(resolver: r); m.begin(area: area)
            await m.lookup(f, area: area, api: s.api())
            #expect(m.phase == .failed && r.calls == 0 && s.requests.isEmpty)
            if f.horizontalAccuracy >= 0 { #expect(m.accuracy == f.horizontalAccuracy) }
        }
    }
    @Test func noAppleStreetOrNetworkFailureKeepsManualFallback() async {
        let s = server(), r = PlaceResolverStub(); r.value = nil
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .failed && s.requests.isEmpty)
        r.value = "Congress Avenue"; s.responses["GET /api/places"] = (502, #"{"error":"places_unavailable"}"#)
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .failed && m.message?.contains("manual") == true)
    }
    @Test func cancellationAndCityChangeCannotInsertAPlace() async {
        let s = server(), m = SightingLocationModel(resolver: PlaceResolverStub())
        let form = await submission(s); form.locationText = "Keep my location"
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api()); m.cancel()
        #expect(!m.confirm("W:1", in: form) && form.place == nil && form.locationText == "Keep my location")
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api()); form.cityName = "Dallas"
        #expect(!m.confirm("W:1", in: form) && form.place == nil && m.phase == .failed)
    }
    @Test func pendingLookupCancellationRejectsLateResults() async throws {
        let r = PlaceResolverStub(), s = server(); r.delay = true
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        let task = Task { await m.lookup(fix(), area: area, api: s.api()) }
        try await Task.sleep(for: .milliseconds(20))
        task.cancel(); m.cancel(); await task.value
        #expect(m.phase == .disclosure && m.suggestions.isEmpty && s.requests.isEmpty)
    }
    @Test func authorizationGrantedDeniedAndUnavailableUseSharedService() async {
        for status in [CLAuthorizationStatus.denied,.restricted] {
            let p = SightingLocationProviderStub(); p.authorizationStatus = status
            let service = LocationService(provider: p, servicesEnabled: { true })
            let r = PlaceResolverStub(), s = server(), m: SightingLocationModel
            m = SightingLocationModel(resolver: r); m.begin(area: area); service.request()
            await m.resolveLocation(using: service, area: area, api: s.api())
            #expect(m.phase == .failed && p.prompts == 0 && p.requests == 0 && r.calls == 0 && s.requests.isEmpty)
        }
        let p = SightingLocationProviderStub(); p.authorizationStatus = .notDetermined
        let service = LocationService(provider: p, servicesEnabled: { true })
        let m = SightingLocationModel(resolver: PlaceResolverStub()), s = server(); m.begin(area: area); service.request()
        #expect(p.prompts == 1 && p.requests == 0)
        p.authorizationStatus = .authorizedWhenInUse; service.authorizationChanged(); service.receive([fix()])
        await m.resolveLocation(using: service, area: area, api: s.api())
        #expect(m.phase == .choosing && p.requests == 1)
        m.begin(area: area); service.request(); service.cancel()
        await m.resolveLocation(using: service, area: area, api: s.api())
        #expect(m.phase == .failed)
    }
    @Test func streetNoMatchIsEmptyButStreetNetworkFailureIsSearchFailure() async {
        let s = server(), r = PlaceResolverStub(), m: SightingLocationModel
        m = SightingLocationModel(resolver: r)
        r.streetError = CLError(.geocodeFoundNoResult)
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
        #expect(m.failure == .emptySearch && s.requests.isEmpty)
        r.streetError = CLError(.network)
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
        #expect(m.failure == .appleSearch && s.requests.isEmpty)
    }
    @Test func mapKitRequestUsesAcceptedFixAndAllPOICategories() {
        let request = AppleSightingPlaceResolver.request(near: fix(), radius: 3000)
        #expect(request.coordinate.latitude == fix().coordinate.latitude)
        #expect(request.coordinate.longitude == fix().coordinate.longitude)
        #expect(request.radius == min(3000, MKLocalPointsOfInterestRequest.maxRadius))
        #expect(request.pointOfInterestFilter?.includes(.restaurant) == true)
    }
    @Test func realPOIQueriesCanBeConfirmedWithoutConvertingAppleIDs() async {
        let s = server(), r = PlaceResolverStub(); r.value = nil
        r.hints = [.init(name: "Congress Avenue", coordinate: fix().coordinate)]
        let m = SightingLocationModel(resolver: r), form = await submission(s)
        m.begin(area: area); await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .choosing && m.diagnostics.appleCandidates == 1 && r.calls == 0)
        #expect(r.mapRequests.first?.0.latitude == fix().coordinate.latitude)
        #expect(r.mapRequests.first?.0.longitude == fix().coordinate.longitude)
        #expect(m.confirm("W:1", in: form) && form.place?.id == "W:1" && !form.sending)
    }
    @Test func emptyMapKitAndStreetResultsAreNotServiceFailures() async {
        let r = PlaceResolverStub(), s = server(); r.value = nil
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.failure == .emptySearch && m.suggestions.isEmpty)
        #expect(m.diagnostics.appleRequests == 2 && s.requests.isEmpty)
    }
    @Test func appleNetworkFailureIsNotPresentedAsEmptyOrIncompatible() async {
        let r = PlaceResolverStub(), s = server()
        r.searchError = NSError(domain: MKErrorDomain, code: Int(MKError.Code.serverFailure.rawValue))
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.failure == .appleSearch && m.diagnostics.locationAccepted)
        #expect(m.diagnostics.appleErrorCode != nil && s.requests.isEmpty && r.calls == 0)
    }
    @Test func explicitAppleNoMatchAllowsSparseStreetFallback() async {
        let r = PlaceResolverStub(), s = server()
        r.searchError = NSError(domain: MKErrorDomain, code: Int(MKError.Code.placemarkNotFound.rawValue))
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .choosing && m.diagnostics.appleNoMatches == 2 && m.diagnostics.streetFallback)
    }
    @Test func unmatchedAppleCandidatesReportCompatibilityFailure() async {
        let r = PlaceResolverStub(), s = server(); r.value = nil
        r.hints = [.init(name: "Congress Avenue", coordinate: fix().coordinate)]
        s.responses["GET /api/places/map"] = (200, #"{"places":[{"id":"W:999","label":"Other","lat":30.2701,"lng":-97.7404}]}"#)
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.failure == .incompatiblePlaces && m.diagnostics.appleCandidates > 0 && m.diagnostics.unmatchedIDs > 0)
    }
    @Test func boundedExpansionAcceptsLegitimatePlaceBeyondOldOneKilometerCutoff() async {
        let r = PlaceResolverStub(), s = server(); r.expandedOnly = true; r.value = nil
        r.hints = [.init(name: "Congress Avenue", coordinate: .init(latitude: 30.286, longitude: -97.74))]
        s.responses["GET /api/places/map"] = (200, #"{"places":[{"id":"W:1","label":"Congress Avenue","lat":30.286,"lng":-97.74}]}"#)
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.phase == .choosing && m.suggestions.first!.meters > 1000)
        #expect(r.mapRequests.map { $0.1 } == [1500,3000])
    }
    @Test func verificationOutageAndExpiredSessionAreNotEmptyMapsResults() async {
        for status in [401,502] {
            let r = PlaceResolverStub(), s = server()
            r.hints = [.init(name: "Congress Avenue", coordinate: fix().coordinate)]
            s.responses["GET /api/places"] = (status, #"{"error":"places_unavailable"}"#)
            let m = SightingLocationModel(resolver: r); m.begin(area: area)
            await m.lookup(fix(), area: area, api: s.api())
            #expect(m.failure == .verifiedService && m.diagnostics.verifiedHTTPStatus == status)
            #expect(m.diagnostics.appleCandidates == 1)
        }
    }
    @Test func cityFilterAndOutsideAreaRemainExplicit() async {
        let r = PlaceResolverStub(), s = server(); r.value = nil
        r.hints = [.init(name: "Congress Avenue", coordinate: fix().coordinate)]
        s.responses["GET /api/places/map"] = (200, #"{"places":[{"id":"W:1","label":"Elsewhere","lat":32.8,"lng":-96.8}]}"#)
        let m = SightingLocationModel(resolver: r); m.begin(area: area)
        await m.lookup(fix(), area: area, api: s.api())
        #expect(m.failure == .incompatiblePlaces && m.diagnostics.outsideRegion > 0)
        #expect(m.message?.contains("selected city") == true)
        for (request, _) in s.requests {
            #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "area" }?.value == "austin")
        }
    }
    @Test func numericBusinessNamesAreValidButCoordinateTextIsNotAQuery() {
        #expect(SightingLocationModel.searchQuery("7 Eleven") == "7 Eleven")
        #expect(SightingLocationModel.searchQuery("30.270123 -97.740456") == nil)
    }

}
