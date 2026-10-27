import CoreLocation
import Observation

@MainActor
protocol LocationProvider: AnyObject {
    var authorizationStatus: CLAuthorizationStatus { get }
    var accuracyAuthorization: CLAccuracyAuthorization { get }
    var delegate: CLLocationManagerDelegate? { get set }
    func requestWhenInUseAuthorization()
    func requestLocation()
    func stopUpdatingLocation()
}
extension CLLocationManager: LocationProvider {}

/// One manager for every feature. No launch request, continuous updates, or networking.
@MainActor @Observable
final class LocationService: NSObject, @preconcurrency CLLocationManagerDelegate {
    static let shared = LocationService()
    private(set) var location: CLLocation?
    private(set) var message: String?
    private(set) var requesting = false
    private(set) var authorization: CLAuthorizationStatus
    private(set) var reducedAccuracy = false
    @ObservationIgnored private let provider: LocationProvider
    @ObservationIgnored private let servicesEnabled: () -> Bool
    @ObservationIgnored private let timeoutDuration: Duration
    @ObservationIgnored private var timeout: Task<Void, Never>?

    init(provider: LocationProvider = CLLocationManager(), timeoutDuration: Duration = .seconds(20), servicesEnabled: @escaping () -> Bool = { CLLocationManager.locationServicesEnabled() }) {
        self.timeoutDuration = timeoutDuration
        self.provider = provider
        self.servicesEnabled = servicesEnabled
        authorization = provider.authorizationStatus
        super.init()
        provider.delegate = self
        if let manager = provider as? CLLocationManager { manager.desiredAccuracy = kCLLocationAccuracyHundredMeters }
    }

    var canOpenSettings: Bool { authorization == .denied || authorization == .restricted }
    var accuracyText: String {
        guard let location else { return "Location unavailable" }
        let title = Date.now.timeIntervalSince(location.timestamp) > 60 ? "Last recorded location (may be stale)" : (reducedAccuracy ? "Recorded approximate location" : "Recorded location")
        return "\(title) · accuracy ±\(Int(location.horizontalAccuracy.rounded(.up))) m · \(location.timestamp.formatted(date: .abbreviated, time: .shortened))"
    }
    func request() {
        guard !requesting else { return }
        message = nil
        location = nil
        authorization = provider.authorizationStatus
        guard servicesEnabled() else { message = "Location Services are unavailable. Enable them in Settings, then retry."; return }
        switch authorization {
        case .denied, .restricted:
            message = "Location is optional. Allow access in Settings to use nearby features."
        case .notDetermined:
            requesting = true
            provider.requestWhenInUseAuthorization()
            startTimeout()
        case .authorizedAlways, .authorizedWhenInUse:
            requesting = true
            provider.requestLocation()
            startTimeout()
        @unknown default: message = "Location unavailable. Please retry."
        }
    }
    private func startTimeout() {
        timeout?.cancel()
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: self?.timeoutDuration ?? .seconds(20)) } catch { return }
            self?.fail("Location timed out. Move near a window and retry.")
        }
    }
    func cancel() { timeout?.cancel(); timeout = nil; provider.stopUpdatingLocation(); requesting = false }
    private func fail(_ text: String) { cancel(); location = nil; message = text }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { authorizationChanged() }
    func authorizationChanged() {
        authorization = provider.authorizationStatus
        let nextReducedAccuracy = provider.accuracyAuthorization == .reducedAccuracy
        if nextReducedAccuracy != reducedAccuracy, location != nil {
            location = nil
            message = "Location accuracy changed. Refresh location to update nearby results."
        }
        reducedAccuracy = nextReducedAccuracy
        if authorization == .denied || authorization == .restricted {
            fail("Location is optional. Allow access in Settings to use nearby features.")
        } else if requesting && authorization != .notDetermined {
            provider.requestLocation()
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) { receive(locations) }
    func receive(_ locations: [CLLocation]) {
        guard requesting, let fix = locations.last(where: { $0.horizontalAccuracy.isFinite && $0.horizontalAccuracy >= 0 && CLLocationCoordinate2DIsValid($0.coordinate) && abs($0.timestamp.timeIntervalSinceNow) < 60 }) else { return }
        reducedAccuracy = provider.accuracyAuthorization == .reducedAccuracy
        location = fix
        cancel()
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard requesting else { return }
        fail("Couldn't obtain your location. Please retry.")
    }
}
