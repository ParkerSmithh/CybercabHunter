import CoreLocation
import ImageIO
import MapKit

/// Where a photo says it was taken: the GPS fields saved in the image file
/// (EXIF/TIFF/HEIC "GPS" dictionary, read with ImageIO), used only on the
/// phone to suggest a nearby verified place for a sighting.
///
/// - It's a suggestion, never proof: the camera's position isn't the
///   Cybercab's, and a photo's location can be wrong or edited.
/// - It never leaves the phone: the photo is re-encoded without any metadata
///   before upload (PhotoEncoder), and the form only ever carries a verified
///   place the rider chose (SubmitSightingModel).
/// - No location permission is needed and no photo-library access: the data
///   is the file Apple's picker (or the Share Sheet) hands over. If the rider
///   turned Location off in the picker's Options, or the file has no GPS,
///   there's simply nothing to suggest.
struct PhotoLocation: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    /// The camera's horizontal error in meters, when the file records it.
    let accuracy: Double?

    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }

    /// When accuracy isn't recorded, assume a typical phone fix.
    static let assumedAccuracy: Double = 65
    /// Two photos within this distance count as the same place.
    static let samePlaceMeters: Double = 150

    /// A location fix for the nearby-place lookup (timestamped now: a photo's
    /// age doesn't matter the way a live GPS reading's does).
    var fix: CLLocation {
        CLLocation(coordinate: coordinate, altitude: 0, horizontalAccuracy: accuracy ?? Self.assumedAccuracy, verticalAccuracy: -1, timestamp: .now)
    }

    func distance(to other: PhotoLocation) -> Double {
        CLLocation(latitude: latitude, longitude: longitude).distance(from: CLLocation(latitude: other.latitude, longitude: other.longitude))
    }

    /// The photo's GPS, or nil when the file has none or it isn't usable.
    static func read(from data: Data) -> PhotoLocation? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let gps = props[kCGImagePropertyGPSDictionary] as? [CFString: Any] else { return nil }
        return from(gps: gps)
    }

    /// From an ImageIO GPS dictionary: unsigned degrees plus N/S and E/W refs.
    static func from(gps: [CFString: Any]) -> PhotoLocation? {
        guard let lat = number(gps[kCGImagePropertyGPSLatitude]), let lng = number(gps[kCGImagePropertyGPSLongitude]) else { return nil }
        let latRef = (gps[kCGImagePropertyGPSLatitudeRef] as? String)?.uppercased() ?? "N"
        let lngRef = (gps[kCGImagePropertyGPSLongitudeRef] as? String)?.uppercased() ?? "E"
        guard ["N", "S"].contains(latRef), ["E", "W"].contains(lngRef) else { return nil }
        let latitude = latRef == "S" ? -abs(lat) : abs(lat)
        let longitude = lngRef == "W" ? -abs(lng) : abs(lng)
        guard latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude), (-180...180).contains(longitude),
              CLLocationCoordinate2DIsValid(.init(latitude: latitude, longitude: longitude)),
              !(abs(latitude) < 0.0001 && abs(longitude) < 0.0001) else { return nil }   // 0,0: a placeholder, not a place
        let error = number(gps[kCGImagePropertyGPSHPositioningError]).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        return PhotoLocation(latitude: latitude, longitude: longitude, accuracy: error)
    }

    /// The first usable location among several photos, in order.
    static func first(in photos: [Data]) -> PhotoLocation? {
        for data in photos { if let found = read(from: data) { return found } }
        return nil
    }

    /// The service area the photo was taken in or near (its zone, widened by
    /// about 15 km: a sighting can be just outside the geofence), if any.
    func area(in areas: [ServiceArea]) -> ServiceArea? {
        let point = MKMapPoint(coordinate)
        let margin = 15_000 * MKMapPointsPerMeterAtLatitude(latitude)
        return areas.first { area in
            let city = WebData.city(area.key)
            guard city.key == area.key else { return false }
            return city.zoneRect.insetBy(dx: -margin, dy: -margin).contains(point)
        }
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let n as NSNumber: n.doubleValue
        case let d as Double: d
        case let s as String: Double(s)
        default: nil
        }
    }
}
