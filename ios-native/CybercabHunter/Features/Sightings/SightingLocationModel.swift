import CoreLocation
import Observation
import MapKit

/// A GPS fix is used only to find nearby, existing verified-place suggestions.
/// No coordinates enter the submission, queries, or logs.
@MainActor @Observable
final class SightingLocationModel {
    enum Phase: Equatable { case disclosure, locating, lookingUp, choosing, failed, confirmed }
    enum Failure: String {
        case locationUnavailable, locationAccuracy, appleSearch, emptySearch, verifiedService, incompatiblePlaces
        var title: String {
            switch self {
            case .locationUnavailable: "Location unavailable"
            case .locationAccuracy: "Location accuracy insufficient"
            case .appleSearch: "Apple Maps search failed"
            case .emptySearch: "No nearby places found"
            case .verifiedService: "Verified-place search failed"
            case .incompatiblePlaces: "No compatible verified places"
            }
        }
    }
    struct Diagnostics {
        var locationAccepted = false
        var appleRequests = 0
        var appleCandidates = 0
        var appleNoMatches = 0
        var queryAttempts = 0
        var verifiedCandidates = 0
        var mappedCandidates = 0
        var unmatchedIDs = 0
        var outsideRegion = 0
        var invalidCoordinates = 0
        var streetFallback = false
        var appleErrorCode: Int?
        var verifiedHTTPStatus: Int?
    }
    struct Suggestion: Identifiable {
        let place: PlaceSearch.Place
        let meters: Double
        let searchQuery: String
        var id: String { place.id }
    }
    private(set) var phase: Phase = .disclosure
    private(set) var failure: Failure?
    private(set) var diagnostics = Diagnostics()
    private(set) var message: String?
    private(set) var suggestions: [Suggestion] = []
    private(set) var query = ""
    private(set) var accuracy: Double?
    @ObservationIgnored private let resolver: any SightingPlaceResolver
    private var areaKey: String?
    private var generation = 0

    init(resolver: any SightingPlaceResolver = AppleSightingPlaceResolver()) { self.resolver = resolver }

    func begin(area: ServiceArea) {
        cancel()
        areaKey = area.key
        phase = .locating
    }
    func locationFailed(_ message: String) {
        fail(.locationUnavailable, message)
    }
    private func fail(_ kind: Failure, _ message: String) {
        failure = kind
        phase = .failed
        self.message = message
    }
    func cancel() {
        generation += 1
        resolver.cancel()
        suggestions = []; query = ""; accuracy = nil; message = nil
        areaKey = nil; phase = .disclosure
        failure = nil; diagnostics = Diagnostics()
    }

    func resolveLocation(using service: LocationService, area: ServiceArea, api: APIClient) async {
        guard phase == .locating, !service.requesting else { return }
        guard let fix = service.location else {
            locationFailed(service.message ?? "Location unavailable. Retry or search manually.")
            return
        }
        await lookup(fix, area: area, api: api)
    }

    func lookup(_ fix: CLLocation, area: ServiceArea, api: APIClient) async {
        guard phase == .locating, areaKey == area.key else { return }
        phase = .lookingUp
        let gen = generation
        if fix.horizontalAccuracy.isFinite && fix.horizontalAccuracy >= 0 { accuracy = fix.horizontalAccuracy }
        guard fix.horizontalAccuracy.isFinite, fix.horizontalAccuracy >= 0,
              fix.horizontalAccuracy <= 500, CLLocationCoordinate2DIsValid(fix.coordinate),
              abs(fix.timestamp.timeIntervalSinceNow) < 60 else {
            fail(.locationAccuracy, "Location isn't accurate or recent enough to suggest a nearby place. Retry or search manually.")
            return
        }
        diagnostics.locationAccepted = true
        var triedQueries = Set<String>()
        var found: [String: Suggestion] = [:]
        let nearbyLimit = 3000 + fix.horizontalAccuracy
        do {
            // Real POIs first, centered on the accepted fix, with one bounded sparse-area expansion.
            for radius in [1500.0, 3000.0] {
                diagnostics.appleRequests += 1
                let hints: [SightingPlaceHint]
                do { hints = try await resolver.places(near: fix, radius: radius) }
                catch let error as MKError where error.code == .placemarkNotFound {
                    // An explicit no-match response is different from throttling/server/network errors.
                    guard gen == generation else { return }
                    diagnostics.appleNoMatches += 1
                    hints = []
                }
                catch is CancellationError { throw CancellationError() }
                catch {
                    if gen == generation {
                        diagnostics.appleErrorCode = (error as NSError).code
                        fail(.appleSearch, "Apple Maps couldn't complete the nearby search. Check your connection and retry, or search manually.")
                    }
                    return
                }
                try Task.checkCancellation()
                guard gen == generation else { return }
                diagnostics.appleCandidates += hints.count
                let nearby = hints.filter { hint in
                    guard CLLocationCoordinate2DIsValid(hint.coordinate) else { diagnostics.invalidCoordinates += 1; return false }
                    let distance = fix.distance(from: CLLocation(latitude: hint.coordinate.latitude, longitude: hint.coordinate.longitude))
                    guard distance <= nearbyLimit else { diagnostics.outsideRegion += 1; return false }
                    return true
                }.sorted {
                    fix.distance(from: CLLocation(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude)) <
                    fix.distance(from: CLLocation(latitude: $1.coordinate.latitude, longitude: $1.coordinate.longitude))
                }
                // Bound verification traffic: at most three POI-name queries over both search regions.
                for hint in nearby where triedQueries.count < 3 {
                    guard let q = Self.searchQuery(hint.name), triedQueries.insert(q.lowercased()).inserted else { continue }
                    let matches = try await compatiblePlaces(query: q, fix: fix, area: area, limit: nearbyLimit, generation: gen, api: api)
                    try Task.checkCancellation()
                    guard gen == generation else { return }
                    for match in matches where found[match.id] == nil { found[match.id] = match }
                }
                if !found.isEmpty { break }
            }
            // A residential/sparse area can have a useful street but no businesses/landmarks.
            if found.isEmpty {
                diagnostics.streetFallback = true
                let street: String?
                do { street = try await resolver.street(near: fix) }
                catch let error as CLError where error.code == .geocodeFoundNoResult { street = nil }
                catch is CancellationError { throw CancellationError() }
                catch {
                    if gen == generation {
                        diagnostics.appleErrorCode = (error as NSError).code
                        fail(.appleSearch, "Apple's street lookup couldn't complete. Retry later or use manual place search.")
                    }
                    return
                }
                try Task.checkCancellation()
                guard gen == generation else { return }
                if let street, let q = Self.searchQuery(street), triedQueries.insert(q.lowercased()).inserted {
                    for match in try await compatiblePlaces(query: q, fix: fix, area: area, limit: nearbyLimit, generation: gen, api: api) { found[match.id] = match }
                }
            }
            try Task.checkCancellation()
            guard gen == generation else { return }
            suggestions = found.values.sorted { $0.meters == $1.meters ? $0.id < $1.id : $0.meters < $1.meters }
            if !suggestions.isEmpty {
                phase = .choosing
            } else if diagnostics.appleCandidates == 0 && diagnostics.queryAttempts == 0 {
                fail(.emptySearch, "Apple found no nearby places or usable street name, even after widening the search. Search manually for a street or landmark.")
            } else {
                let detail = diagnostics.outsideRegion > 0 ? "Some returned places were outside the nearby area. " : ""
                fail(.incompatiblePlaces, detail + "No compatible verified place was found nearby in \(area.name). Check the selected city or search manually; Apple places cannot be inserted without a real verified place ID.")
            }
        } catch is CancellationError {
            if gen == generation { cancel() }
        } catch {
            guard gen == generation else { return }
            if case APIError.http(let status, _) = error { diagnostics.verifiedHTTPStatus = status }
            let expired: Bool
            if case APIError.unauthorized = error { expired = true; diagnostics.verifiedHTTPStatus = 401 } else { expired = diagnostics.verifiedHTTPStatus == 401 }
            fail(.verifiedService, expired
                ? "Your session expired. Sign in again, then retry verified-place search. Your sighting hasn't been submitted."
                : "The verified-place service couldn't complete its search. Retry later or search manually; this wasn't an empty Apple Maps result.")
        }
    }

    /// Coordinate-looking text is never sent to the backend. Numeric business/street names are valid.
    static func searchQuery(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        guard (3...120).contains(value.count),
              value.range(of: #"^[-+]?\d{1,3}\.\d+[,\s]+[-+]?\d{1,3}\.\d+$"#, options: .regularExpression) == nil else { return nil }
        return value
    }

    private func compatiblePlaces(query: String, fix: CLLocation, area: ServiceArea, limit: Double, generation expected: Int, api: APIClient) async throws -> [Suggestion] {
        diagnostics.queryAttempts += 1
        let q = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "area", value: area.key)]
        // Query names only; no phone coordinates. Match real IDs from the existing two services.
        async let v: PlaceSearch = api.get("/api/places", query: q, authenticated: true)
        async let m: PlaceResults = api.get("/api/places/map", query: q + [URLQueryItem(name: "v", value: "2")])
        let (verified, mapped) = try await (v, m)
        try Task.checkCancellation()
        guard expected == generation else { throw CancellationError() }
        diagnostics.verifiedCandidates += verified.places.count
        diagnostics.mappedCandidates += mapped.places.count
        var seen = Set<String>()
        return verified.places.compactMap { place in
            guard place.id.range(of: #"^[NWR]:\d{1,15}$"#, options: .regularExpression) != nil,
                  seen.insert(place.id).inserted else { return nil }
            guard let point = mapped.places.first(where: { $0.id == place.id }) else { diagnostics.unmatchedIDs += 1; return nil }
            guard CLLocationCoordinate2DIsValid(.init(latitude: point.lat, longitude: point.lng)) else { diagnostics.invalidCoordinates += 1; return nil }
            let distance = fix.distance(from: CLLocation(latitude: point.lat, longitude: point.lng))
            guard distance <= limit else { diagnostics.outsideRegion += 1; return nil }
            return Suggestion(place: place, meters: distance, searchQuery: query)
        }
    }

    /// Only a suggestion from this lookup can be confirmed, for the same selected city.
    @discardableResult
    func confirm(_ id: String, in submission: SubmitSightingModel) -> Bool {
        guard phase == .choosing,
              let suggestion = suggestions.first(where: { $0.id == id }) else { return false }
        guard submission.area?.key == areaKey else {
            fail(.incompatiblePlaces, "Your selected city changed. Retry or search manually.")
            return false
        }
        submission.pick(suggestion.place, query: suggestion.searchQuery)
        query = suggestion.searchQuery
        suggestions = []; phase = .confirmed
        return true
    }
}
