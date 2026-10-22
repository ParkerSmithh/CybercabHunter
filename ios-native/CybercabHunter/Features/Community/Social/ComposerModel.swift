import Foundation
import Observation
import UIKit

/// The post composer's state and rules (public/js/social.js composer). The
/// server checks everything again; these checks only give fast feedback.
@MainActor
@Observable
final class ComposerModel {
    static let maxChars = 2000
    static let maxPhotos = 4
    /// Ride dates the server accepts (worker/social.js readReview).
    static let firstRideDate = Format.calendarDate("2025-06-01")!

    struct NewPhoto: Identifiable {
        let id = UUID()
        let jpeg: Data
        let preview: UIImage?
    }

    let editing: SocialPost?
    var body = ""
    var category: PostCategory = .general
    /// Existing photos kept while editing.
    var keep: [SocialPhoto] = []
    var added: [NewPhoto] = []
    var preparingPhotos = 0

    var reviewOn = false { didSet { reviewToggled(oldValue) } }
    var rating = 0
    var reviewVehicle = ""          // "", "cybercab", "model_y"
    var fare = ""
    var wait = ""
    var rideDate: Date?

    var vehicleOn = false { didSet { if !vehicleOn { vehicle = nil; vehicleQuery = ""; vehicleResults = nil } } }
    var vehicle: SocialVehicle?
    var vehicleQuery = ""
    private(set) var vehicleResults: [SocialVehicle]?
    private(set) var vehicleSearchFailed = false

    var linkOn = false
    var link = ""

    private(set) var sending = false
    private(set) var progress: Double = 0
    var error: String?

    init(editing: SocialPost? = nil) {
        self.editing = editing
        guard let p = editing else { return }
        body = p.body
        category = PostCategory(rawValue: p.category) ?? .general
        keep = p.photos
        if let url = p.linkUrl { linkOn = true; link = url }
        if let v = p.vehicle { vehicleOn = true; vehicle = v }
        if let r = p.review {
            reviewOn = true
            rating = r.rating
            reviewVehicle = r.vehicleType ?? ""
            fare = r.quotedFare.map { String(format: "%.2f", $0) } ?? ""
            wait = r.pickupWaitMinutes.map(String.init) ?? ""
            rideDate = r.rideDate.flatMap(Format.calendarDate)
        }
        category = PostCategory(rawValue: p.category) ?? .general
    }

    // MARK: Counter (social.js updateComposer)

    /// The length the server counts (JavaScript string length).
    var length: Int { body.utf16.count }
    var left: Int { Self.maxChars - length }
    var counter: String { "\(Format.int(length)) / \(Format.int(Self.maxChars))" }
    var countMessage: String? {
        if left < 0 { return "\(Format.int(-left)) \(left == -1 ? "character" : "characters") over the 2,000-character limit. Shorten your post to publish it." }
        if left == 0 { return "You've reached the 2,000-character limit." }
        if left <= 200 { return "\(Format.int(left)) \(left == 1 ? "character" : "characters") left." }
        return nil
    }
    var photoCount: Int { keep.count + added.count + preparingPhotos }
    var hasContent: Bool { !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || keep.count + added.count > 0 }
    var canPublish: Bool { hasContent && left >= 0 && !(reviewOn && rating == 0) && !sending && preparingPhotos == 0 }

    private func reviewToggled(_ was: Bool) {
        guard was != reviewOn else { return }
        if reviewOn, category == .general { category = .review }
        if !reviewOn, category == .review, editing == nil { category = .general }
    }

    // MARK: Photos

    func addPhoto(_ original: Data) async {
        guard photoCount < Self.maxPhotos else { error = SocialText.errors["too_many_photos"]; return }
        preparingPhotos += 1
        defer { preparingPhotos -= 1 }
        let result = await Task.detached(priority: .userInitiated) { () -> (Data, UIImage?)? in
            guard let jpeg = try? PhotoEncoder.jpeg(from: original) else { return nil }
            return (jpeg, ImagePipeline.downsample(jpeg, maxPixel: 300))
        }.value
        guard let (jpeg, preview) = result else { error = SocialText.errors["file_too_large"]; return }
        added.append(NewPhoto(jpeg: jpeg, preview: preview))
    }

    func removeKept(_ id: String) { keep.removeAll { $0.id == id } }
    func removeAdded(_ id: UUID) { added.removeAll { $0.id == id } }

    // MARK: Attach Cybercab (GET /api/social/vehicles?q=)

    func searchVehicles(api: APIClient) async {
        let q = vehicleQuery.trimmingCharacters(in: .whitespaces)
        do {
            try await Task.sleep(for: .milliseconds(200))   // the site's debounce
            let r: SocialVehicleSearch = try await api.get("/api/social/vehicles", query: [URLQueryItem(name: "q", value: q)])
            vehicleResults = r.vehicles
            vehicleSearchFailed = false
        } catch is CancellationError {
        } catch {
            vehicleSearchFailed = true
        }
    }

    // MARK: Publish

    /// The multipart form the website's composer sends.
    func form() -> MultipartForm {
        var f = MultipartForm()
        f.add("body", body.trimmingCharacters(in: .whitespacesAndNewlines))
        f.add("category", category.rawValue)
        let url = link.trimmingCharacters(in: .whitespaces)
        if linkOn, !url.isEmpty { f.add("link_url", url) }
        if vehicleOn, let vehicle { f.add("vehicle_id", vehicle.id) }
        if reviewOn {
            f.add("review", "1")
            f.add("rating", String(rating))
            f.add("vehicle_type", reviewVehicle)
            f.add("quoted_fare", fare.trimmingCharacters(in: .whitespaces))
            f.add("pickup_wait_minutes", wait.trimmingCharacters(in: .whitespaces))
            f.add("ride_date", rideDate.map(Self.dayString) ?? "")
        } else if editing != nil {
            f.add("remove_review", "1")
        }
        for p in keep { f.add("keep_photos", p.id) }
        for (i, p) in added.enumerated() { f.addFile("photos", data: p.jpeg, filename: "photo-\(i + 1).jpg", contentType: "image/jpeg") }
        return f
    }

    /// The local checks the site makes before sending (its messages).
    func validate() -> String? {
        if left < 0 { return "Your post is over the 2,000-character limit. Shorten it to publish." }
        if !hasContent { return SocialText.errors["empty_post"] }
        if reviewOn && rating == 0 { return SocialText.errors["invalid_rating"] }
        if vehicleOn && vehicle == nil { return "Choose a Cybercab from the search results, or remove the attachment." }
        return nil
    }

    func publish(api: APIClient) async -> SocialPost? {
        guard !sending else { return nil }
        if let problem = validate() { error = problem; return nil }
        error = nil
        sending = true
        progress = 0
        defer { sending = false }
        do {
            let saved: SocialPostSaved = try await api.upload(editing.map { "/api/social/posts/\($0.id)" } ?? "/api/social/posts",
                                                              method: editing == nil ? "POST" : "PATCH", form: form()) { [weak self] p in
                Task { @MainActor in self?.progress = p }
            }
            return saved.post
        } catch {
            self.error = SocialText.message(for: error)
            return nil
        }
    }

    static func dayString(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
