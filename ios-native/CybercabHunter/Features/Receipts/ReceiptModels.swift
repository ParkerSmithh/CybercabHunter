import Foundation

/// POST /api/rides/import/preview: what importing would do, nothing saved.
struct ReceiptPreview: Decodable, Sendable, Equatable {
    struct Fields: Decodable, Sendable, Equatable {
        let rideDate: String?
        let pickupTime: String?
        let dropoffTime: String?
        let pickup: String?
        let dropoff: String?
        let fareAmountCents: Int?
        let currency: String?
        let distanceMiles: Double?
        let durationMinutes: Int?
        let licensePlate: String?
        let serviceArea: String?
        let timezone: String?
    }
    /// new | same_ride | duplicate | needs_details | rejected
    let would: String
    let reason: String?
    let fields: Fields
    let uncertain: [String]

    var canImport: Bool { would == "new" || would == "same_ride" }
    /// One plain sentence for the review screen.
    var headline: String {
        switch would {
        case "new": "This will add a new ride."
        case "same_ride": "You already have this ride. Importing updates it; it won't be counted twice."
        case "duplicate": "This receipt is already imported."
        case "needs_details": "Important details are missing, so this receipt can't become a ride yet."
        default: "This doesn't look like a Tesla Robotaxi receipt."
        }
    }
    func isUncertain(_ key: String) -> Bool { uncertain.contains(key) }
}

/// POST /api/rides/import.
struct ReceiptImportRun: Decodable, Sendable, Equatable {
    struct Run: Decodable, Sendable, Equatable {
        let processed: Int; let added: Int; let updated: Int; let duplicates: Int
        let needsReview: Int; let rejected: Int; let errors: Int
    }
    let success: Bool
    let run: Run
}

/// GET /api/rides/imports: the rider's own recent receipts, newest first.
struct ReceiptImportsPage: Decodable, Sendable, Equatable {
    struct Ride: Decodable, Sendable, Equatable, Hashable {
        let id: String
        let rideDate: String?
        let pickupTime: String?
        let pickup: String?
        let dropoff: String?
        let fareAmountCents: Int?
        let currency: String?
    }
    struct Item: Decodable, Sendable, Equatable, Identifiable, Hashable {
        let id: String
        let receivedAt: String?
        /// email | gmail | import
        let source: String
        /// imported | updated | duplicate | needs_details | not_a_receipt | failed
        let result: String
        let error: String?
        let ride: Ride?

        var sourceText: String { ["email": "Forwarded email", "gmail": "Gmail", "import": "Imported in the app or on the website"][source] ?? "Import" }
        var resultText: String {
            ["imported": "Imported", "updated": "Updated", "duplicate": "Already imported", "needs_details": "Needs details",
             "not_a_receipt": "Not recognized", "failed": "Couldn't import"][result] ?? "Imported"
        }
        var ok: Bool { result == "imported" || result == "updated" }
        /// What to do about it, in plain words (never an internal code).
        var advice: String? {
            switch result {
            case "duplicate": return "This receipt was imported before. Nothing was counted twice."
            case "needs_details":
                if let e = error, e.hasPrefix("pickup_time") { return "The receipt has no readable pickup time. Import a clearer copy, or the original email." }
                if let e = error, e.hasPrefix("ride_date") { return "The receipt has no readable ride date. Import a clearer copy, or the original email." }
                return "Unable to extract the required information. Import a clearer copy, or the original email."
            case "not_a_receipt": return "Receipt format not recognized. Only Tesla Robotaxi ride receipts can be imported."
            case "failed": return "A temporary problem stopped this import. Try importing the receipt again."
            default: return nil
            }
        }
    }
    let imports: [Item]
    let nextCursor: String?
}

enum ReceiptFormat {
    /// "2026-06-09" -> "Jun 9, 2026"
    static func day(_ iso: String?) -> String? {
        // A calendar date, not an instant: parsed and shown in the same (UTC) zone,
        // so "2026-06-09" is Jun 9 wherever the phone is.
        guard let iso, let d = DateFormatter.receiptISO.date(from: iso) else { return nil }
        var style = Date.FormatStyle.dateTime.month(.abbreviated).day().year()
        style.timeZone = TimeZone(identifier: "UTC")!
        return d.formatted(style)
    }
    /// "13:04" -> "1:04 PM"; nil stays nil (never a made-up time).
    static func time(_ t: String?) -> String? {
        guard let t, let m = t.prefixMatch(of: /(\d{1,2}):(\d{2})/), let h = Int(m.1) else { return nil }
        return "\(h % 12 == 0 ? 12 : h % 12):\(m.2) \(h < 12 ? "AM" : "PM")"
    }
    static func fare(_ cents: Int?, _ currency: String?) -> String? {
        guard let cents else { return nil }
        if cents == 0 { return "Free" }
        return (Double(cents) / 100).formatted(.currency(code: currency ?? "USD"))
    }
}

extension DateFormatter {
    static let receiptISO: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd"; return f
    }()
}
