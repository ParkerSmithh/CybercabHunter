import Foundation

/// The website's wording for Social (public/js/social.js), so the app says
/// exactly what the site says.
enum SocialText {
    /// The Worker's error codes → the site's messages (social.js ERRORS).
    static let errors: [String: String] = [
        "empty_post": "Write something or add a photo.",
        "duplicate_post": "You've already posted that.",
        "text_too_long": "That is too long.",
        "missing_text": "Write something first.",
        "invalid_link": "That link doesn't look right. Use a full https:// address.",
        "invalid_category": "Choose a post type.",
        "unknown_vehicle": "Choose a Cybercab from the registry list.",
        "invalid_rating": "Choose a rating from 1 to 5 stars.",
        "invalid_vehicle_type": "Choose Cybercab or Model Y.",
        "invalid_fare": "Fare must be between $1 and $250.",
        "invalid_wait": "Pickup wait must be 0 to 120 minutes.",
        "invalid_ride_date": "Choose a ride date that isn't in the future.",
        "too_many_photos": "Up to 4 photos per post.",
        "unsupported_file_type": "Photos must be JPEG, PNG or WebP.",
        "file_too_large": "Each photo must be 5 MB or smaller.",
        "rate_limited": "You're going a bit fast. Try again in a few minutes.",
        "already_reported": "You've already reported this. Moderators will take a look.",
        "cannot_report_own": "You can't report your own post.",
        "forbidden": "You can't change that.",
        "not_found": "That is no longer available.",
        "post_unavailable": "That post is no longer available.",
        "too_many_pins": "Up to 3 pinned posts. Unpin one first."
    ]
    static let fallback = "Something went wrong. Please try again."

    static func message(for error: Error) -> String {
        switch error {
        case APIError.http(_, let code?): return errors[code] ?? fallback
        case APIError.unauthorized: return "Your session has ended. Sign in again."
        case APIError.transport: return "Couldn't reach Cybercab Hunter. Check your connection."
        default: return fallback
        }
    }

    /// The Worker's error code, if it sent one.
    static func code(_ error: Error) -> String? {
        if case APIError.http(_, let code) = error { return code }
        return nil
    }

    static let emptyFeed: [SocialFeedModel.Filter: String] = [
        .foryou: "Be the first to post about the Cybercab.",
        .latest: "Be the first to post about the Cybercab.",
        .photos: "No photo posts yet. Share a Cybercab photo.",
        .reviews: "No ride reviews yet. Rode in one? Add a ride review to a post.",
        .saved: "You haven't saved any posts yet."
    ]

    static let rules = [
        "Keep it about Cybercabs, Tesla's Robotaxi, fleet sightings and autonomous rides.",
        "No spam, harassment, threats or unrelated promotion.",
        "No one's personal information without their permission.",
        "Never follow a vehicle or drive unsafely to get a sighting.",
        "No made-up or misleading sightings. Posting doesn't verify a sighting; moderators do."
    ]

    /// "just now", "5m", "3h", "2d", then "Sep 30" / "Sep 30, 2025" (social.js relative).
    static func relative(_ raw: String, now: Date = .now) -> String {
        guard let date = Format.instant(raw) else { return "" }
        let s = max(0, Int(now.timeIntervalSince(date).rounded()))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86400 { return "\(s / 3600)h" }
        if s < 7 * 86400 { return "\(s / 86400)d" }
        var style = Date.FormatStyle().month(.abbreviated).day()
        if Calendar.current.component(.year, from: date) != Calendar.current.component(.year, from: now) { style = style.year() }
        return date.formatted(style)
    }

    /// "Oct 20, 2026 at 9:52 PM" (the tooltip on the website's time).
    static func fullTime(_ raw: String) -> String {
        Format.instant(raw)?.formatted(date: .abbreviated, time: .shortened) ?? ""
    }

    static func stars(_ n: Int) -> String { String(repeating: "★", count: max(0, min(5, n))) + String(repeating: "☆", count: max(0, 5 - n)) }

    /// The ride review's facts line ("Cybercab · $12.40 fare · 4 min pickup wait · Rode Oct 20, 2026").
    static func reviewFacts(_ r: SocialReview) -> [String] {
        var bits: [String] = []
        if let t = r.vehicleType { bits.append(SocialReview.vehicleNames[t] ?? t) }
        if let f = r.quotedFare { bits.append(String(format: "$%.2f fare", f)) }
        if let w = r.pickupWaitMinutes { bits.append("\(w) min pickup wait") }
        if let d = r.rideDate { bits.append("Rode \(Format.day(d))") }
        return bits
    }
}
