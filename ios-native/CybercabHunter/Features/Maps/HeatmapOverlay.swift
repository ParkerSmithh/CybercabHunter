import MapKit
import UIKit

/// A native heatmap (MapKit has none): the website's MapLibre heatmap layer
/// (js/zones-heatmap.js) rebuilt as an MKOverlay. Each point adds a Gaussian
/// of its weight, scaled by a zoom-dependent intensity, inside a zoom-dependent
/// radius; the summed density is coloured with the site's ramp
/// (transparent → faint gold → bright gold → orange → red-orange) at 90%
/// opacity. Drawn per tile on MapKit's background threads, so it pans and
/// zooms with the map.
final class HeatmapOverlay: NSObject, MKOverlay {
    struct Point: Sendable { let mapPoint: MKMapPoint; let weight: Double }
    let points: [Point]
    let boundingMapRect: MKMapRect
    var coordinate: CLLocationCoordinate2D { boundingMapRect.origin.coordinate }

    init(points: [Point]) {
        self.points = points
        // Big enough for the widest glow around every point.
        let union = points.reduce(MKMapRect.null) { $0.union(MKMapRect(origin: $1.mapPoint, size: MKMapSize(width: 0, height: 0))) }
        boundingMapRect = union.isNull ? MKMapRect.null : union.insetBy(dx: -union.width - 60_000, dy: -union.height - 60_000)
        super.init()
    }
}

final class HeatmapRenderer: MKOverlayRenderer {
    // The website's stops: radius (exponential 1.5) and intensity (linear) by MapLibre zoom.
    private static let radiusStops: [(Double, Double)] = [(9, 26), (11, 40), (13, 62), (15, 96), (17, 150)]
    private static let intensityStops: [(Double, Double)] = [(9, 1.6), (12, 2.2), (15, 3)]
    /// Density → colour: the site's heatmap-color ramp, ×0.9 opacity, premultiplied RGBA.
    private static let lut: [UInt32] = {
        let stops: [(Double, (Double, Double, Double, Double))] = [
            (0, (250, 224, 48, 0)), (0.1, (250, 224, 48, 0.16)), (0.28, (250, 224, 48, 0.5)),
            (0.5, (250, 224, 48, 0.82)), (0.75, (249, 115, 22, 0.88)), (1, (255, 69, 0, 0.95))]
        return (0..<256).map { i in
            let d = Double(i) / 255
            let k = stops.lastIndex { $0.0 <= d } ?? 0
            let a = stops[k], b = stops[min(k + 1, stops.count - 1)]
            let t = b.0 > a.0 ? (d - a.0) / (b.0 - a.0) : 0
            func mix(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
            let alpha = mix(a.1.3, b.1.3) * 0.9
            let r = UInt32(mix(a.1.0, b.1.0) * alpha), g = UInt32(mix(a.1.1, b.1.1) * alpha), bl = UInt32(mix(a.1.2, b.1.2) * alpha)
            // premultipliedLast + byteOrder32Little: the 32-bit value is R G B A, high to low.
            return (r << 24) | (g << 16) | (bl << 8) | UInt32(alpha * 255)
        }
    }()

    static func interpolate(_ stops: [(Double, Double)], _ z: Double, base: Double = 1) -> Double {
        if z <= stops[0].0 { return stops[0].1 }
        if z >= stops[stops.count - 1].0 { return stops[stops.count - 1].1 }
        let k = stops.lastIndex { $0.0 <= z }!
        let (z0, v0) = stops[k], (z1, v1) = stops[k + 1]
        let t = base == 1 ? (z - z0) / (z1 - z0) : (pow(base, z - z0) - 1) / (pow(base, z1 - z0) - 1)
        return v0 + (v1 - v0) * t
    }

    /// MapLibre's zoom for a MapKit zoom scale (screen points per map point;
    /// the world is 2^28 map points, MapLibre's is 512·2^z pixels).
    static func mapLibreZoom(_ zoomScale: MKZoomScale) -> Double { log2(Double(zoomScale)) + 19 }

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let overlay = overlay as? HeatmapOverlay, !overlay.points.isEmpty else { return }
        let z = Self.mapLibreZoom(zoomScale)
        let radiusPoints = Self.interpolate(Self.radiusStops, z, base: 1.5)
        let intensity = Self.interpolate(Self.intensityStops, z)
        let mapPerPoint = 1 / Double(zoomScale)                    // map points per screen point
        let radiusMap = radiusPoints * mapPerPoint
        // A coarse grid (2 screen points per cell): the heat is soft anyway.
        let cell = 2.0 * mapPerPoint
        let cols = max(1, Int((mapRect.width / cell).rounded(.up))), rows = max(1, Int((mapRect.height / cell).rounded(.up)))
        var density = [Float](repeating: 0, count: cols * rows)
        let sigma = radiusMap / 3, twoSigma2 = 2 * sigma * sigma
        var any = false
        for p in overlay.points {
            let px = p.mapPoint.x, py = p.mapPoint.y
            guard px > mapRect.minX - radiusMap, px < mapRect.maxX + radiusMap, py > mapRect.minY - radiusMap, py < mapRect.maxY + radiusMap else { continue }
            any = true
            let c0 = max(0, Int(((px - radiusMap) - mapRect.minX) / cell)), c1 = min(cols - 1, Int(((px + radiusMap) - mapRect.minX) / cell))
            let r0 = max(0, Int(((py - radiusMap) - mapRect.minY) / cell)), r1 = min(rows - 1, Int(((py + radiusMap) - mapRect.minY) / cell))
            guard c0 <= c1, r0 <= r1 else { continue }
            let amp = Float(p.weight * intensity * 0.42)
            for r in r0...r1 {
                let dy = mapRect.minY + (Double(r) + 0.5) * cell - py
                for c in c0...c1 {
                    let dx = mapRect.minX + (Double(c) + 0.5) * cell - px
                    let d2 = dx * dx + dy * dy
                    if d2 < radiusMap * radiusMap { density[r * cols + c] += amp * Float(exp(-d2 / twoSigma2)) }
                }
            }
        }
        guard any else { return }
        var pixels = density.map { Self.lut[Int(min(1, max(0, $0)) * 255)] }
        let image: CGImage? = pixels.withUnsafeMutableBytes { buffer in
            guard let ctx = CGContext(data: buffer.baseAddress, width: cols, height: rows, bitsPerComponent: 8, bytesPerRow: cols * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
            return ctx.makeImage()
        }
        guard let image else { return }
        let rect = self.rect(for: mapRect)
        context.saveGState()
        context.interpolationQuality = .high
        // CGContext's origin is bottom-left for images: flip so row 0 is the top.
        context.translateBy(x: rect.minX, y: rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
        context.restoreGState()
    }
}
