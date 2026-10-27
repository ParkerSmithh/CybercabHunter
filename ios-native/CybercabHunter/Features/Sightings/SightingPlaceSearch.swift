import CoreLocation
import MapKit

struct SightingPlaceHint {
    let name: String
    let coordinate: CLLocationCoordinate2D
}

@MainActor
protocol SightingPlaceResolver: AnyObject {
    func places(near location: CLLocation, radius: CLLocationDistance) async throws -> [SightingPlaceHint]
    func street(near location: CLLocation) async throws -> String?
    func cancel()
}

@MainActor
final class AppleSightingPlaceResolver: SightingPlaceResolver {
    private let geocoder = CLGeocoder()
    private var search: MKLocalSearch?

    /// This exact configuration is covered by deterministic request tests.
    static func request(near location: CLLocation, radius: CLLocationDistance) -> MKLocalPointsOfInterestRequest {
        let request = MKLocalPointsOfInterestRequest(center: location.coordinate, radius: min(radius, MKLocalPointsOfInterestRequest.maxRadius))
        request.pointOfInterestFilter = .includingAll
        return request
    }

    func places(near location: CLLocation, radius: CLLocationDistance) async throws -> [SightingPlaceHint] {
        let lookup = MKLocalSearch(request: Self.request(near: location, radius: radius))
        search = lookup
        defer { if search === lookup { search = nil } }
        let response = try await lookup.start()
        return response.mapItems.compactMap { item in
            guard !item.isCurrentLocation, let name = item.name else { return nil }
            let coordinate: CLLocationCoordinate2D
            if #available(iOS 26.0, *) { coordinate = item.location.coordinate }
            else { coordinate = item.placemark.coordinate }
            return SightingPlaceHint(name: name, coordinate: coordinate)
        }
    }
    func street(near location: CLLocation) async throws -> String? {
        let places = try await geocoder.reverseGeocodeLocation(location)
        return places.first?.thoroughfare
    }
    func cancel() { search?.cancel(); search = nil; geocoder.cancelGeocode() }
}
