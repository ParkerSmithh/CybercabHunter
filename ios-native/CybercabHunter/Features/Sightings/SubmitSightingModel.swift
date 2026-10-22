import Foundation
import Observation
import UIKit

/// The sighting form (the website's sighting drawer, js/main.js
/// initSightingDrawer; POST /api/vehicle-sightings/photo). Its fields, checks
/// and messages are the website's; the server checks everything again. A
/// submitted sighting is pending and private until a moderator approves it.
@MainActor
@Observable
final class SubmitSightingModel {
    /// The drawer's messages for the Worker's error codes (js/main.js SIGHTING_ERROR_MESSAGES).
    static let errors: [String: String] = [
        "invalid_license_plate": "That doesn't look like a valid license plate.",
        "invalid_service_area": "Choose a city from the list first.",
        "location_outside_area": "That location isn't in the city you chose. Pick a location in that city's area.",
        "invalid_observed_at": "That doesn't look like a valid date and time.",
        "missing_photo": "Please add a photo of the Cybercab.",
        "unsupported_file_type": "Please choose a JPEG, PNG or WebP photo.",
        "invalid_location": "Choose the location from the suggestions list.",
        "invalid_traffic_camera": "Traffic cameras are in Austin. Choose Austin as the city, or \"Not a traffic camera\".",
        "location_unavailable": "Location search isn't available right now. Try again, or leave Location empty.",
        "invalid_form_data": "That sighting couldn't be submitted. Check the fields and try again.",
        "invalid_body": "That sighting couldn't be submitted. Check the fields and try again."
    ]
    static let tooLarge = "That photo is too large. Please choose one under 10 MB."
    static let maxNotes = 280
    static let maxPlate = 20

    enum Outcome: Equatable { case editing, submitted, duplicate }

    // Photo (required)
    private(set) var photo: Data?
    private(set) var preview: UIImage?
    private(set) var preparingPhoto = false
    var photoError: String?

    // City (optional) and the place search that needs it
    private(set) var areas: [ServiceArea] = []
    var cityName = "" { didSet { if cityName != oldValue { cityChanged() } } }
    var locationText = ""
    private(set) var place: PlaceSearch.Place?
    private(set) var placeQuery = ""
    private(set) var places: [PlaceSearch.Place] = []
    private(set) var placesMessage: String?
    private(set) var searchingPlaces = false
    var locationError: String?

    // The rest (all optional)
    var date: Date?
    private(set) var cameras: [TrafficCamera] = []
    var cameraId = ""
    var notes = "" { didSet { if notes.count > Self.maxNotes { notes = String(notes.prefix(Self.maxNotes)) } } }
    var plate = "" { didSet { if plate.count > Self.maxPlate { plate = String(plate.prefix(Self.maxPlate)) } } }

    private(set) var sending = false
    private(set) var progress: Double = 0
    var error: String?
    /// The session ended while the form was open: everything typed stays.
    private(set) var needsSignIn = false
    private(set) var outcome: Outcome = .editing

    var area: ServiceArea? { areas.first { $0.name == cityName } }
    /// The camera list follows the City: Dallas's with Dallas, Austin's otherwise (the site's rule).
    var cameraCity: String { area?.key == "dallas" ? "dallas" : "austin" }
    var cityCameras: [TrafficCamera] {
        cameras.filter { $0.cityKey == cameraCity }.sorted { ($0.name, $0.cameraId) < ($1.name, $1.cameraId) }
    }

    func load(api: APIClient) async {
        if areas.isEmpty, let r: ServiceAreasResponse = try? await api.get("/api/service-areas") { areas = r.areas }
        if cameras.isEmpty, let list: [TrafficCamera] = try? await api.get("/data/traffic-cameras.json") { cameras = list }
    }

    private func cityChanged() {
        // A place belongs to one city: a new city clears it.
        place = nil; places = []; placesMessage = nil; locationText = ""; locationError = nil
        if !cameraId.isEmpty && !cityCameras.contains(where: { $0.cameraId == cameraId }) { cameraId = "" }
    }

    // MARK: Photo

    func setPhoto(_ original: Data) async {
        photoError = nil
        preparingPhoto = true
        defer { preparingPhoto = false }
        let result = await Task.detached(priority: .userInitiated) { () -> Result<(Data, UIImage?), PhotoEncoder.Failure> in
            do {
                let jpeg = try PhotoEncoder.sightingJPEG(from: original)
                return .success((jpeg, ImagePipeline.downsample(jpeg, maxPixel: 700)))
            } catch let failure as PhotoEncoder.Failure { return .failure(failure) } catch { return .failure(.unreadable) }
        }.value
        switch result {
        case .success(let (jpeg, image)): photo = jpeg; preview = image
        case .failure(.tooLarge): photoError = Self.tooLarge
        case .failure: photoError = Self.errors["unsupported_file_type"]
        }
    }

    func removePhoto() { photo = nil; preview = nil }

    // MARK: Location: real places only (type, then pick from the list)

    func locationEdited() {
        place = nil   // typed text is never a chosen place
        locationError = nil
    }

    func searchPlaces(api: APIClient) async {
        let q = locationText.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        guard let area, q.count >= 3, place?.label != locationText else { places = []; placesMessage = nil; return }
        do {
            try await Task.sleep(for: .milliseconds(250))   // the site's debounce
            searchingPlaces = true
            defer { searchingPlaces = false }
            let r: PlaceSearch = try await api.get("/api/places", query: [URLQueryItem(name: "q", value: q), URLQueryItem(name: "area", value: area.key)], authenticated: true)
            places = r.places
            placesMessage = r.places.isEmpty ? "No matching places in \(area.name). Try a street or landmark." : nil
        } catch is CancellationError {
        } catch {
            places = []
            placesMessage = "Location search isn't available right now."
        }
    }

    func pick(_ p: PlaceSearch.Place) {
        place = p
        placeQuery = locationText.trimmingCharacters(in: .whitespaces)
        locationText = p.label
        places = []
        placesMessage = nil
        locationError = nil
    }

    // MARK: Submit

    /// The website's checks before sending; nil when the form can go.
    func validate() -> Bool {
        photoError = nil; locationError = nil; error = nil
        guard photo != nil else { photoError = Self.errors["missing_photo"]; return false }
        let typed = !locationText.trimmingCharacters(in: .whitespaces).isEmpty
        if typed && area == nil { locationError = Self.errors["invalid_service_area"]; return false }
        if typed && place == nil { locationError = Self.errors["invalid_location"]; return false }
        return true
    }

    /// The multipart form the website sends (only the fields that have a value).
    func form(timeZone: TimeZone = .current) -> MultipartForm {
        var f = MultipartForm()
        if let photo { f.addFile("photo", data: photo, filename: "sighting.jpg", contentType: "image/jpeg") }
        let fields: [(String, String)] = [
            ("service_area", cityName),
            ("approx_location", place == nil ? "" : locationText.trimmingCharacters(in: .whitespaces)),
            ("notes", notes.trimmingCharacters(in: .whitespacesAndNewlines)),
            ("license_plate", plate.trimmingCharacters(in: .whitespaces)),
            ("observed_date", date.map(Self.dayString) ?? ""),
            ("time_zone", timeZone.identifier),
            ("location_id", place?.id ?? ""),
            ("location_query", place == nil ? "" : placeQuery),
            ("camera_id", cameraId)
        ]
        for (k, v) in fields where !v.isEmpty { f.add(k, v) }
        return f
    }

    func submit(api: APIClient) async {
        guard !sending else { return }   // a double tap sends once
        guard validate() else { return }
        sending = true
        progress = 0
        needsSignIn = false
        defer { sending = false }
        do {
            let r: SightingSubmitted = try await api.upload("/api/vehicle-sightings/photo", method: "POST", form: form()) { [weak self] p in
                Task { @MainActor in self?.progress = p }
            }
            outcome = r.duplicate ? .duplicate : .submitted
            if r.duplicate { error = "That sighting was already submitted." }
            reset(keepOutcome: true)
        } catch APIError.unauthorized {
            needsSignIn = true   // the fields and the photo are kept
        } catch APIError.http(let status, let code) {
            let message = code.flatMap { Self.errors[$0] }
            switch (status, code) {
            case (413, _): photoError = Self.tooLarge
            case (400, "missing_photo"?), (400, "unsupported_file_type"?): photoError = message
            case (400, "invalid_location"?), (400, "location_outside_area"?), (502, "location_unavailable"?): locationError = message
            case (400, _): error = message ?? Self.errors["invalid_body"]
            default: error = "Couldn't submit the sighting. Please try again."
            }
        } catch is CancellationError {
        } catch {
            self.error = "Couldn't submit the sighting. Please try again."   // nothing entered is lost
        }
    }

    /// Clears the form after a submission ("Submit another").
    func reset(keepOutcome: Bool = false) {
        photo = nil; preview = nil; photoError = nil
        place = nil; locationText = ""; places = []; placesMessage = nil; locationError = nil
        date = nil; cameraId = ""; notes = ""; plate = ""
        if !keepOutcome { outcome = .editing; error = nil }
    }

    static func dayString(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
