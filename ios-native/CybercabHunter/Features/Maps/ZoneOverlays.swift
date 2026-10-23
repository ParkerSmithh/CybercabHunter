import MapKit
import UIKit

/// The service zone as the website draws it (js/austin-map.js addServiceZone):
/// a faint gold wash (the streets and labels read through it), a barely-there
/// halo, then a thin crisp gold outline.
final class ZonePolygon: MKPolygon {
    var cityKey = ""
    var dimmed = false   // Heatmap mode dims the wash (the outline stays)
    /// The outline in points (constant on screen at any zoom): 1.1 on the
    /// full maps (Zones, Replay), 0.8 on the small Home minimap.
    var lineWeight: CGFloat = 1.1
}

final class ZoneRenderer: MKPolygonRenderer {
    static let washAlpha: CGFloat = 0.05
    init(zone: ZonePolygon) {
        super.init(polygon: zone)
        let gold = UIColor(red: 250 / 255, green: 224 / 255, blue: 48 / 255, alpha: 1)
        fillColor = gold.withAlphaComponent(zone.dimmed ? 0.02 : Self.washAlpha)
        strokeColor = gold.withAlphaComponent(0.95)
        lineWidth = zone.lineWeight
        lineJoin = .round
    }

    override func strokePath(_ path: CGPath, in context: CGContext) {
        // A faint halo (a short blur, low alpha) so the line holds on busy streets; no neon.
        context.saveGState()
        context.setShadow(offset: .zero, blur: 2 / contentScaleFactor, color: UIColor(red: 250 / 255, green: 224 / 255, blue: 48 / 255, alpha: 0.15).cgColor)
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

    /// A charging location: a compact dark tile with a gold bolt (distinct from
    /// the round Cybercab markers), a 44pt tap target.
    static func charging(_ view: MKAnnotationView) {
        view.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        view.subviews.forEach { $0.removeFromSuperview() }
        let tile = UIView(frame: CGRect(x: 11, y: 11, width: 22, height: 22))
        tile.backgroundColor = UIColor(red: 15 / 255, green: 16 / 255, blue: 17 / 255, alpha: 0.94)
        tile.layer.cornerRadius = 6.5
        tile.layer.cornerCurve = .continuous
        tile.layer.borderColor = gold.withAlphaComponent(0.85).cgColor
        tile.layer.borderWidth = 1
        shadow(tile)
        let bolt = UIImageView(image: UIImage(systemName: "bolt.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)))
        bolt.tintColor = gold
        bolt.contentMode = .center
        bolt.frame = tile.bounds
        tile.addSubview(bolt)
        view.addSubview(tile)
    }

    /// A soft dark drop shadow: lifts a marker off the map without a glow.
    static func shadow(_ v: UIView) {
        v.layer.shadowColor = UIColor.black.cgColor
        v.layer.shadowOpacity = 0.55
        v.layer.shadowRadius = 3
        v.layer.shadowOffset = CGSize(width: 0, height: 1.5)
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

/// A camera-spotted Cybercab: the site's overhead icon in a 26pt dark disc
/// with a thin gold ring and a soft shadow (no glow), a 44pt tap target.
/// Markers that would overlap merge into a cluster (`CybercabClusterView`).
final class CybercabMarkerView: MKAnnotationView {
    static let clusterID = "cybercab"
    private let disc = UIView()
    private let icon = UIImageView(image: UIImage(named: "CybercabOverhead"))

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        disc.frame = CGRect(x: 9, y: 9, width: 26, height: 26)
        disc.backgroundColor = UIColor(red: 15 / 255, green: 16 / 255, blue: 17 / 255, alpha: 0.94)
        disc.layer.cornerRadius = 13
        disc.layer.borderWidth = 1
        disc.layer.borderColor = MarkerViews.gold.withAlphaComponent(0.85).cgColor
        MarkerViews.shadow(disc)
        icon.frame = disc.bounds.insetBy(dx: 3, dy: 3)
        icon.contentMode = .scaleAspectFit
        disc.addSubview(icon)
        addSubview(disc)
        clusteringIdentifier = Self.clusterID
        collisionMode = .circle
        displayPriority = .required
    }
    required init?(coder: NSCoder) { fatalError() }

    override func prepareForDisplay() {
        super.prepareForDisplay()
        clusteringIdentifier = Self.clusterID
    }

    /// Selected: a brighter, slightly thicker ring and a small lift.
    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        UIView.animate(withDuration: animated ? 0.18 : 0) {
            self.disc.transform = selected ? CGAffineTransform(scaleX: 1.15, y: 1.15) : .identity
            self.disc.layer.borderWidth = selected ? 2 : 1
            self.disc.layer.borderColor = MarkerViews.gold.withAlphaComponent(selected ? 1 : 0.85).cgColor
        }
    }
}

/// Several Cybercabs too close to show apart: one marker with the count. A tap
/// zooms in until they separate (each vehicle stays reachable; nothing moves).
final class CybercabClusterView: MKAnnotationView {
    private let disc = UIView()
    private let icon = UIImageView(image: UIImage(named: "CybercabOverhead"))
    private let badge = UILabel()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        frame = CGRect(x: 0, y: 0, width: 44, height: 44)
        disc.frame = CGRect(x: 7, y: 7, width: 30, height: 30)
        disc.backgroundColor = UIColor(red: 15 / 255, green: 16 / 255, blue: 17 / 255, alpha: 0.94)
        disc.layer.cornerRadius = 15
        disc.layer.borderWidth = 1.25
        disc.layer.borderColor = MarkerViews.gold.cgColor
        MarkerViews.shadow(disc)
        icon.frame = disc.bounds.insetBy(dx: 4, dy: 4)
        icon.contentMode = .scaleAspectFit
        disc.addSubview(icon)
        addSubview(disc)
        badge.font = .systemFont(ofSize: 10.5, weight: .bold)
        badge.textColor = UIColor(red: 26 / 255, green: 18 / 255, blue: 4 / 255, alpha: 1)
        badge.backgroundColor = MarkerViews.gold
        badge.textAlignment = .center
        badge.layer.cornerRadius = 8
        badge.layer.masksToBounds = true
        addSubview(badge)
        collisionMode = .circle
        displayPriority = .required
    }
    required init?(coder: NSCoder) { fatalError() }

    override func prepareForDisplay() {
        super.prepareForDisplay()
        let n = (annotation as? MKClusterAnnotation)?.memberAnnotations.count ?? 0
        badge.text = "\(n)"
        let w = max(16, badge.intrinsicContentSize.width + 8)
        badge.frame = CGRect(x: 44 - w + 2, y: 2, width: w, height: 16)
        accessibilityLabel = "\(n) Cybercabs seen by nearby traffic cameras. Double-tap to zoom in."
    }
}
