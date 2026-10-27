import CoreLocation

/// Spherical distances and great-circle segment projection; rings include holes.
enum ZoneProximity {
    struct Zone {
        let name: String
        /// Each polygon's first ring is its exterior; subsequent rings are holes.
        let polygons: [[[CLLocationCoordinate2D]]]
    }
    struct Result {
        let text: String
        let nearest: CLLocationCoordinate2D?
    }
    static let earth = 6_371_008.8
    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let p = a.latitude * .pi / 180, q = b.latitude * .pi / 180
        let d = (b.longitude - a.longitude) * .pi / 180
        let h = pow(sin((q-p)/2), 2) + cos(p)*cos(q)*pow(sin(d/2), 2)
        return 2 * earth * asin(sqrt(min(1, max(0, h))))
    }
    static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let p = a.latitude * .pi/180, q = b.latitude * .pi/180, d = (b.longitude-a.longitude) * .pi/180
        return atan2(sin(d)*cos(q), cos(p)*sin(q)-sin(p)*cos(q)*cos(d))
    }
    static func destination(_ a: CLLocationCoordinate2D, angle: Double, bearing b: Double) -> CLLocationCoordinate2D {
        let p = a.latitude * .pi/180, l = a.longitude * .pi/180
        let q = asin(sin(p)*cos(angle)+cos(p)*sin(angle)*cos(b))
        let r = l + atan2(sin(b)*sin(angle)*cos(p), cos(angle)-sin(p)*sin(q))
        return .init(latitude: q*180 / .pi, longitude: (r*180 / .pi + 540).truncatingRemainder(dividingBy: 360)-180)
    }
    static func closest(_ p: CLLocationCoordinate2D, _ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        let length = distance(a,b)/earth, d = distance(a,p)/earth, theta = bearing(a,p)-bearing(a,b)
        let along = atan2(sin(d)*cos(theta), cos(d))
        if along <= 0 || length == 0 { return a }
        if along >= length { return b }
        return destination(a, angle: along, bearing: bearing(a,b))
    }
    static func contains(_ p: CLLocationCoordinate2D, ring: [CLLocationCoordinate2D]) -> Bool {
        var inside = false
        for i in ring.indices {
            let a = ring[i], b = ring[(i+1)%ring.count]
            if (a.latitude > p.latitude) != (b.latitude > p.latitude),
               p.longitude < (b.longitude-a.longitude)*(p.latitude-a.latitude)/(b.latitude-a.latitude)+a.longitude { inside.toggle() }
        }
        return inside
    }
    static func evaluate(_ fix: CLLocation, zones: [Zone]) -> Result {
        var inside: [String] = [], uncertain: [String] = []
        var nearest: (String, Double, CLLocationCoordinate2D)?
        guard fix.horizontalAccuracy.isFinite, fix.horizontalAccuracy >= 0, CLLocationCoordinate2DIsValid(fix.coordinate) else { return Result(text: "Location unavailable", nearest: nil) }
        for zone in zones {
            guard !zone.polygons.isEmpty, zone.polygons.allSatisfy({ !$0.isEmpty && $0.allSatisfy { ring in
                ring.count >= 3 && ring.allSatisfy(CLLocationCoordinate2DIsValid) && abs(ring.indices.reduce(0.0) { sum, i in let a = ring[i], b = ring[(i+1)%ring.count]; return sum + a.longitude*b.latitude-b.longitude*a.latitude }) > 0.000000001
            } }) else { return Result(text: "Service-zone data unavailable", nearest: nil) }
            var minDistance = Double.infinity
            for polygon in zone.polygons {
                if contains(fix.coordinate, ring: polygon[0]) && !polygon.dropFirst().contains(where: { contains(fix.coordinate, ring: $0) }) { inside.append(zone.name) }
                for ring in polygon { for i in ring.indices {
                    let point = closest(fix.coordinate, ring[i], ring[(i+1)%ring.count])
                    let d = distance(fix.coordinate, point)
                    minDistance = min(minDistance, d)
                    if nearest == nil || d < nearest!.1 { nearest = (zone.name,d,point) }
                } }
            }
            if minDistance <= max(1, fix.horizontalAccuracy) { uncertain.append(zone.name) }
        }
        if !uncertain.isEmpty { return Result(text: "Near \(Set(uncertain).sorted().joined(separator: " / ")) boundary — accuracy cannot confirm coverage", nearest: nil) }
        if !inside.isEmpty { return Result(text: "Inside \(Set(inside).sorted().joined(separator: " and ")) service zone\(Set(inside).count > 1 ? "s (overlap)" : "")", nearest: nil) }
        guard let nearest else { return Result(text: "Service-zone data unavailable", nearest: nil) }
        return Result(text: "Outside mapped service zones. Nearest: \(nearest.0) — approximately \(String(format: "%.1f", nearest.1 / 1609.344)) miles away (straight-line)", nearest: nearest.2)
    }
}
