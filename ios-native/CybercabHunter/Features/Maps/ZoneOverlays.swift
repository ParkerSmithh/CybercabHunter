import MapKit
import UIKit

/// The service zone as the website draws it (js/austin-map.js addServiceZone):
/// a light gold wash, a soft glow, then a crisp gold outline.
final class ZonePolygon: MKPolygon {
    var cityKey = ""
    var dimmed = false   // Heatmap mode dims the wash (the outline stays)
    /// The outline in points (constant on screen at any zoom): 1.25 on the
    /// full maps (Zones, Replay), 1 on the small Home minimap.
    var lineWeight: CGFloat = 1.25
}

final class ZoneRenderer: MKPolygonRenderer {
    init(zone: ZonePolygon) {
        super.init(polygon: zone)
        let gold = UIColor(red: 250 / 255, green: 224 / 255, blue: 48 / 255, alpha: 1)
        fillColor = gold.withAlphaComponent(zone.dimmed ? 0.04 : 0.13)
        strokeColor = gold
        lineWidth = zone.lineWeight
        lineJoin = .round
    }

    override func strokePath(_ path: CGPath, in context: CGContext) {
        // The glow: a wide, blurred gold line under the outline.
        context.saveGState()
        context.setShadow(offset: .zero, blur: 6 / contentScaleFactor, color: UIColor(red: 250 / 255, green: 224 / 255, blue: 48 / 255, alpha: 0.45).cgColor)
        super.strokePath(path, in: context)
        context.restoreGState()
        super.strokePath(path, in: context)
    }
}

/// Dark Matter: Apple's muted dark map has green and teal land; the website's
/// CARTO Dark Matter is near-black. A world-wide #08090A wash between the roads
/// and the labels gives the same canvas while keeping the street names crisp.
final class DarkMatterOverlay: NSObject, MKOverlay {
    let boundingMapRect = MKMapRect.world
    var coordinate: CLLocationCoordinate2D { MKMapRect.world.origin.coordinate }
}

final class DarkMatterRenderer: MKOverlayRenderer {
    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        context.setFillColor(UIColor(red: 8 / 255, green: 9 / 255, blue: 10 / 255, alpha: 0.62).cgColor)
        context.fill(rect(for: mapRect))
    }
}

/// Map annotations, each identified so a refresh updates rather than duplicates.
final class ChargingAnnotation: NSObject, MKAnnotation {
    let location: WebData.ChargingLocation
    var coordinate: CLLocationCoordinate2D { location.coordinate }
    var title: String? { location.name }
    init(_ location: WebData.ChargingLocation) { self.location = location }
}

final class LiveCameraAnnotation: NSObject, MKAnnotation {
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var detection: CameraDetection
    var title: String? { "Cybercab seen by the traffic camera at \(detection.cameraName)" }
    init(_ d: CameraDetection) { detection = d; coordinate = d.coordinate }
}

final class CameraDotAnnotation: NSObject, MKAnnotation {
    let dot: ZonesModel.CameraDot
    var coordinate: CLLocationCoordinate2D { dot.coordinate }
    var title: String? { "Traffic camera, \(dot.name)" }
    init(_ dot: ZonesModel.CameraDot) { self.dot = dot }
}

final class PlaceAnnotation: NSObject, MKAnnotation {
    let place: PlaceResults.Place
    var coordinate: CLLocationCoordinate2D { .init(latitude: place.lat, longitude: place.lng) }
    var title: String? { place.label }
    init(_ place: PlaceResults.Place) { self.place = place }
}

/// The site's markers as native views.
@MainActor
enum MarkerViews {
    static let gold = UIColor(red: 250 / 255, green: 224 / 255, blue: 48 / 255, alpha: 1)

    /// A gold charging pin: 18pt dot with a dark ring (the site's addPin).
    static func charging(_ view: MKAnnotationView) {
        view.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        view.subviews.forEach { $0.removeFromSuperview() }
        let dot = UIView(frame: CGRect(x: 13, y: 13, width: 18, height: 18))
        dot.backgroundColor = gold
        dot.layer.cornerRadius = 9
        dot.layer.borderColor = UIColor(red: 8 / 255, green: 10 / 255, blue: 16 / 255, alpha: 0.55).cgColor
        dot.layer.borderWidth = 2
        dot.layer.shadowColor = gold.cgColor
        dot.layer.shadowOpacity = 0.6
        dot.layer.shadowRadius = 6
        dot.layer.shadowOffset = .zero
        view.addSubview(dot)
    }

    /// The camera-spotted Cybercab: the site's overhead icon in a dark disc with
    /// a gold ring and glow, a 44pt tap target.
    static func liveCamera(_ view: MKAnnotationView) {
        view.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        view.subviews.forEach { $0.removeFromSuperview() }
        let disc = UIView(frame: CGRect(x: 5, y: 5, width: 34, height: 34))
        disc.backgroundColor = UIColor(red: 8 / 255, green: 10 / 255, blue: 16 / 255, alpha: 0.8)
        disc.layer.cornerRadius = 17
        disc.layer.borderColor = gold.withAlphaComponent(0.7).cgColor
        disc.layer.borderWidth = 1.5
        disc.layer.shadowColor = gold.cgColor
        disc.layer.shadowOpacity = 0.45
        disc.layer.shadowRadius = 6
        disc.layer.shadowOffset = .zero
        let icon = UIImageView(image: UIImage(named: "CybercabOverhead"))
        icon.frame = CGRect(x: 2, y: 2, width: 30, height: 30)
        icon.contentMode = .scaleAspectFit
        disc.addSubview(icon)
        view.addSubview(disc)
    }

    /// A camera in Heatmap mode: white when it has detections, slate otherwise.
    static func cameraDot(_ view: MKAnnotationView, count: Int) {
        let size: CGFloat = count > 0 ? 9 : 7
        view.frame = CGRect(x: 0, y: 0, width: 28, height: 28)
        view.subviews.forEach { $0.removeFromSuperview() }
        let dot = UIView(frame: CGRect(x: (28 - size) / 2, y: (28 - size) / 2, width: size, height: size))
        dot.backgroundColor = count > 0 ? UIColor.white.withAlphaComponent(0.9) : UIColor(red: 148 / 255, green: 163 / 255, blue: 184 / 255, alpha: 0.5)
        dot.layer.cornerRadius = size / 2
        dot.layer.borderColor = UIColor(red: 8 / 255, green: 10 / 255, blue: 16 / 255, alpha: 0.7).cgColor
        dot.layer.borderWidth = 0.75
        view.addSubview(dot)
    }
}
