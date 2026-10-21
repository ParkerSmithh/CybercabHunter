import Foundation

/// Number and date formatting as the website does it (en-US, Central time for
/// service facts, "—" for a missing value, never a made-up 0).
enum Format {
    static let central = TimeZone(identifier: "America/Chicago")!

    static func int(_ v: Int?) -> String { v.map { $0.formatted(.number.locale(Locale(identifier: "en_US"))) } ?? "—" }
    static func one(_ v: Double?) -> String { v.map { $0.formatted(.number.precision(.fractionLength(0...1)).locale(Locale(identifier: "en_US"))) } ?? "—" }
    static func money(_ v: Double?) -> String { v.map { String(format: "$%.2f", $0) } ?? "—" }
    static func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(int(n)) \(n == 1 ? one : many)" }
    static func signed(_ n: Int) -> String { n > 0 ? "+\(int(n))" : int(n) }

    /// "2026-10-20" or "2026-10-20 12:13:33" (a calendar date) → "Oct 20, 2026".
    static func day(_ raw: String?, year: Bool = true) -> String {
        guard let date = calendarDate(raw) else { return "—" }
        var style = Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day()
        if year { style = style.year() }
        return date.formatted(style)
    }

    static func calendarDate(_ raw: String?) -> Date? {
        guard let raw, raw.count >= 10 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = raw.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    /// An ISO instant ("2026-10-20T22:07:12Z" or "…T22:07:12.123Z") or a stored
    /// UTC time ("2026-10-20 22:07:12").
    static func instant(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let s = raw.contains("T") ? raw : raw.replacingOccurrences(of: " ", with: "T") + "Z"
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// "Oct 20, 5:07 PM" in the sighting's own zone (Central by default).
    static func dateTime(_ date: Date?, zone: String? = nil) -> String {
        guard let date else { return "" }
        let tz = zone.flatMap(TimeZone.init(identifier:)) ?? central
        return date.formatted(Date.FormatStyle(timeZone: tz).month(.abbreviated).day().hour().minute())
    }

    /// "2h ago", "3d ago", "just now".
    static func ago(_ date: Date, now: Date = .now) -> String {
        let s = max(0, now.timeIntervalSince(date))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60))m ago" }
        if s < 86400 { return "\(Int(s / 3600))h ago" }
        return "\(Int(s / 86400))d ago"
    }

    /// "6AM", "12AM", "5PM" from an hour 0–24.
    static func hourLabel(_ h: Int) -> String {
        let h24 = h % 24
        return "\((h24 + 11) % 12 + 1)\(h24 < 12 ? "AM" : "PM")"
    }

    /// "06:00" / "24:00" → "6AM" / "12AM" (the website's clock()).
    static func clock(_ hhmm: String?) -> String {
        guard let hhmm, let h = Int(hhmm.prefix(2)) else { return "—" }
        let m = Int(hhmm.suffix(2)) ?? 0
        let h24 = h % 24
        return "\((h24 + 11) % 12 + 1)\(m > 0 ? String(format: ":%02d", m) : "")\(h24 < 12 ? "AM" : "PM")"
    }

    /// "+3 vs previous 24 h" / "−10% vs prior 7 days" (the website's delta()).
    static func delta(_ now: Int?, _ before: Int?, _ label: String, percent: Bool = false) -> String {
        guard let now, let before else { return "" }
        let diff = now - before
        if percent, before > 0 {
            let pct = Int((Double(diff) / Double(before) * 100).rounded())
            return "\(pct > 0 ? "+" : pct < 0 ? "−" : "")\(abs(pct))% vs \(label)"
        }
        return "\(diff > 0 ? "+" : diff < 0 ? "−" : "")\(abs(diff)) vs \(label)"
    }
}
