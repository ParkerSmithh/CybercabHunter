import SwiftUI
import MapKit

/// What the rider tapped on the map.
enum MapSelection: Identifiable, Equatable {
    case charging(WebData.ChargingLocation)
    case liveCamera(CameraDetection)
    case heatCamera(id: String, name: String)
    var id: String {
        switch self {
        case .charging(let c): "charging-\(c.name)"
        case .liveCamera(let d): "live-\(d.cameraId)"
        case .heatCamera(let id, _): "heat-\(id)"
        }
    }
}

/// The Zones map (and the homepage minimaps): MKMapView in a dark, muted
/// style with the website's zones and markers. Updates are diffs: annotations
/// reconciled by id, overlays rebuilt only when their inputs change, the
/// camera moved only when the city changes.
struct ZoneMapView: UIViewRepresentable {
    var cityKey: String
    var heatMode = false
    var liveDetections: [CameraDetection] = []
    var heatPoints: [ZonesModel.HeatPoint] = []
    var cameraDots: [ZonesModel.CameraDot] = []
    var place: PlaceResults.Place?
    var showsMarkers = true
    var interactive = true
    var bottomInset: CGFloat = 0
    /// The zone's framing padding; nil = the Zones page's. The Home minimap
    /// passes the website's minimap fitBounds padding (top 70, bottom 54, sides 24).
    var framePadding: UIEdgeInsets? = nil
    var onSelect: (MapSelection) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.overrideUserInterfaceStyle = .dark
        let config = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        map.preferredConfiguration = config
        map.showsCompass = false
        map.isRotateEnabled = false
        map.isPitchEnabled = false
        map.isScrollEnabled = interactive
        map.isZoomEnabled = interactive
        map.cameraZoomRange = MKMapView.CameraZoomRange(minCenterCoordinateDistance: 400, maxCenterCoordinateDistance: 250_000)
        map.backgroundColor = UIColor(Color.chSurface)
        map.register(MKAnnotationView.self, forAnnotationViewWithReuseIdentifier: "charging")
        map.register(MKAnnotationView.self, forAnnotationViewWithReuseIdentifier: "live")
        map.register(MKAnnotationView.self, forAnnotationViewWithReuseIdentifier: "dot")
        map.register(MKMarkerAnnotationView.self, forAnnotationViewWithReuseIdentifier: "place")
        map.isUserInteractionEnabled = interactive
        map.addOverlay(DarkMatterOverlay(), level: .aboveRoads)
        // Both zones are always drawn, as on the website.
        for city in WebData.zones.cities { context.coordinator.addZone(city, to: map, dimmed: heatMode) }
        context.coordinator.frame(cityKey, on: map, animated: false)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if c.lastCity != cityKey { c.frame(cityKey, on: map, animated: true) }
        if c.lastHeatMode != heatMode {
            c.lastHeatMode = heatMode
            for overlay in map.overlays.compactMap({ $0 as? ZonePolygon }) {
                map.removeOverlay(overlay)
                c.addZone(WebData.city(overlay.cityKey), to: map, dimmed: heatMode)
            }
        }
        c.syncAnnotations(on: map)
        c.syncHeat(on: map)
        if c.lastPlace != place {
            c.lastPlace = place
            map.removeAnnotations(map.annotations.compactMap { $0 as? PlaceAnnotation })
            if let place {
                map.addAnnotation(PlaceAnnotation(place))
                map.setCamera(MKMapCamera(lookingAtCenter: .init(latitude: place.lat, longitude: place.lng), fromDistance: 2_500, pitch: 0, heading: 0), animated: true)
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: ZoneMapView
        var lastCity: String?
        var lastHeatMode: Bool
        var lastPlace: PlaceResults.Place?
        var lastHeat: [ZonesModel.HeatPoint] = []
        var heatOverlay: HeatmapOverlay?

        init(_ parent: ZoneMapView) { self.parent = parent; lastHeatMode = parent.heatMode }

        func addZone(_ city: WebData.City, to map: MKMapView, dimmed: Bool) {
            var coords = city.polygon
            let zone = ZonePolygon(coordinates: &coords, count: coords.count)
            zone.cityKey = city.key
            zone.dimmed = dimmed
            map.addOverlay(zone, level: .aboveRoads)
        }

        /// Frames the city's zone (the website's fitBounds, 24pt padding on phones).
        func frame(_ key: String, on map: MKMapView, animated: Bool) {
            lastCity = key
            let pad: CGFloat = 24
            let insets = parent.framePadding ?? UIEdgeInsets(top: pad + 56, left: pad, bottom: pad + parent.bottomInset, right: pad)
            map.setVisibleMapRect(WebData.city(key).zoneRect, edgePadding: insets, animated: animated)
        }

        func syncAnnotations(on map: MKMapView) {
            let p = parent
            // Charging pins: the selected city's (Dallas's hub only with Dallas, as the site).
            let wantCharging = p.showsMarkers ? WebData.city(p.cityKey).charging + (p.cityKey == "austin" ? [] : WebData.city("austin").charging) : []
            reconcile(map, current: map.annotations.compactMap { $0 as? ChargingAnnotation }, wanted: wantCharging, key: { $0.location.id }, wantedKey: \.id, make: ChargingAnnotation.init)
            // Camera-spotted Cybercabs: Normal Map only (Heatmap hides them).
            let wantLive = p.showsMarkers && !p.heatMode ? p.liveDetections : []
            let liveCurrent = map.annotations.compactMap { $0 as? LiveCameraAnnotation }
            let byId = Dictionary(liveCurrent.map { ($0.detection.cameraId, $0) }, uniquingKeysWith: { a, _ in a })
            let wantedIds = Set(wantLive.map(\.cameraId))
            map.removeAnnotations(liveCurrent.filter { !wantedIds.contains($0.detection.cameraId) })
            for d in wantLive {
                if let existing = byId[d.cameraId] {
                    if existing.detection != d { existing.detection = d; existing.coordinate = d.coordinate }
                } else {
                    map.addAnnotation(LiveCameraAnnotation(d))
                }
            }
            // Heatmap camera dots.
            let wantDots = p.heatMode ? p.cameraDots : []
            let dotCurrent = map.annotations.compactMap { $0 as? CameraDotAnnotation }
            if dotCurrent.map(\.dot) != wantDots {
                map.removeAnnotations(dotCurrent)
                map.addAnnotations(wantDots.map(CameraDotAnnotation.init))
            }
        }

        private func reconcile<A: MKAnnotation, W>(_ map: MKMapView, current: [A], wanted: [W], key: (A) -> String, wantedKey: KeyPath<W, String>, make: (W) -> A) {
            let have = Set(current.map(key)), want = Set(wanted.map { $0[keyPath: wantedKey] })
            map.removeAnnotations(current.filter { !want.contains(key($0)) })
            map.addAnnotations(wanted.filter { !have.contains($0[keyPath: wantedKey]) }.map(make))
        }

        func syncHeat(on map: MKMapView) {
            let want = parent.heatMode ? parent.heatPoints : []
            guard want != lastHeat else { return }
            lastHeat = want
            if let heatOverlay { map.removeOverlay(heatOverlay) }
            heatOverlay = nil
            guard !want.isEmpty else { return }
            let overlay = HeatmapOverlay(points: want.map { .init(mapPoint: MKMapPoint($0.coordinate), weight: $0.weight) })
            heatOverlay = overlay
            map.addOverlay(overlay, level: .aboveLabels)
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let zone = overlay as? ZonePolygon { return ZoneRenderer(zone: zone) }
            if overlay is DarkMatterOverlay { return DarkMatterRenderer(overlay: overlay) }
            if overlay is HeatmapOverlay { let r = HeatmapRenderer(overlay: overlay); r.alpha = 1; return r }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            switch annotation {
            case let a as ChargingAnnotation:
                let v = mapView.dequeueReusableAnnotationView(withIdentifier: "charging", for: a)
                MarkerViews.charging(v); v.displayPriority = .required; v.accessibilityLabel = "Charging location, \(a.location.name)"
                return v
            case let a as LiveCameraAnnotation:
                let v = mapView.dequeueReusableAnnotationView(withIdentifier: "live", for: a)
                MarkerViews.liveCamera(v); v.displayPriority = .required; v.accessibilityLabel = a.title
                return v
            case let a as CameraDotAnnotation:
                let v = mapView.dequeueReusableAnnotationView(withIdentifier: "dot", for: a)
                MarkerViews.cameraDot(v, count: a.dot.count); v.displayPriority = .required; v.accessibilityLabel = a.title
                return v
            case let a as PlaceAnnotation:
                let v = mapView.dequeueReusableAnnotationView(withIdentifier: "place", for: a) as! MKMarkerAnnotationView
                v.markerTintColor = MarkerViews.gold; v.glyphTintColor = .black
                return v
            default:
                return nil
            }
        }

        func mapView(_ mapView: MKMapView, didSelect annotation: MKAnnotation) {
            switch annotation {
            case let a as ChargingAnnotation: parent.onSelect(.charging(a.location))
            case let a as LiveCameraAnnotation: parent.onSelect(.liveCamera(a.detection))
            case let a as CameraDotAnnotation: parent.onSelect(.heatCamera(id: a.dot.id, name: a.dot.name))
            default: break
            }
            // The sheet shows the details; let the marker be tapped again.
            DispatchQueue.main.async { mapView.deselectAnnotation(annotation, animated: false) }
        }
    }
}
