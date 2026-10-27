/// Presentation only. Geometry, accuracy decisions and boundary distances remain in ZoneProximity.
enum ZoneStatusText {
    static func headline(_ result: ZoneProximity.Result?, requesting: Bool = false) -> String {
        if requesting { return "FINDING LOCATION" }
        guard let result else { return "LOCATION UNAVAILABLE" }
        if result.nearest != nil { return "OUTSIDE SERVICE ZONES" }
        if result.text.contains("cannot confirm coverage") { return "ZONE BOUNDARY UNCERTAIN" }
        if result.text == "Service-zone data unavailable" { return "ZONE DATA UNAVAILABLE" }
        return result.text.uppercased()
    }
}
