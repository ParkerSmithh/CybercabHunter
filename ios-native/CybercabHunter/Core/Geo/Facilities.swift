import Foundation
import CoreLocation
import Observation

/// Robotaxi facilities: the website's one list, public/data/facilities.json.
/// The app ships a copy (Resources/WebData/facilities.json, written by
/// ios-native/scripts/sync-web-data.mjs) so the map has them at once and
/// offline, then refreshes once per launch from
/// https://cybercabhunter.com/data/facilities.json (a static file, no Worker
/// call) and keeps that copy, so new facilities and photos arrive without an
/// app update. Photos are the site's own images, loaded when they're shown.
struct FacilityData: Decodable, Equatable {
    struct Labels: Decodable, Equatable {
        let type: [String: String]
        let operational: [String: String]
        let verification: [String: String]
        let verificationHelp: [String: String]?
    }
    let version: Int
    let updated: String
    let labels: Labels
    let facilities: [Facility]
}

struct Facility: Decodable, Identifiable, Hashable {
    enum Kind: String, Decodable { case charging, staging, combined }

    struct Photo: Decodable, Hashable {
        let src: String
        let thumb: String
        let width: Int
        let height: Int
        let caption: String
        let alt: String
        let credit: String
        let license: String?
        var aspect: CGFloat { height > 0 ? CGFloat(width) / CGFloat(height) : 4 / 3 }
        /// Only the site's own facility images (never a hotlink).
        static func url(_ path: String) -> URL? {
            guard path.range(of: #"^/images/facilities/[a-z0-9-]+/[a-z0-9-]+\.(webp|jpg|png)$"#, options: .regularExpression) != nil else { return nil }
            return URL(string: path, relativeTo: FacilityStore.photoBase)?.absoluteURL
        }
        var url: URL? { Self.url(src) }
        var thumbURL: URL? { Self.url(thumb) }
    }

    struct Source: Decodable, Hashable, Identifiable {
        let title: String
        let publisher: String
        let url: String
        let date: String?
        var id: String { url }
        var link: URL? { url.hasPrefix("https://") ? URL(string: url) : nil }
    }

    let id: String
    let name: String
    let city: String
    let address: String
    let locationNote: String?
    let lat: Double
    let lng: Double
    let type: Kind
    let operational: String
    let verification: String
    let summary: String
    let description: String
    let charging: [String]
    let staging: [String]
    let photos: [Photo]
    let photoReview: String?
    let sources: [Source]
    let lastVerified: String

    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lng) }
    /// The website's page for this facility (shared and copied links).
    var webURL: URL { AppConfig.webURL("/infrastructure?city=\(city)&facility=\(id)") }
    var hasCharging: Bool { type != .staging }
    var hasStaging: Bool { type != .charging }

    /// "Nov 16, 2026"
    static func day(_ iso: String?) -> String {
        let utc = TimeZone(identifier: "UTC")!
        let parts = (iso ?? "").split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let d = Calendar(identifier: .gregorian).date(from: DateComponents(timeZone: utc, year: parts[0], month: parts[1], day: parts[2], hour: 12)) else { return "" }
        return d.formatted(Date.FormatStyle(timeZone: utc).month(.abbreviated).day().year())
    }
}

/// The map's facility filter, as on the website (a combined site shows under both).
enum FacilityFilter: String, CaseIterable, Identifiable {
    case all, charging, staging
    var id: Self { self }
    var title: String {
        switch self {
        case .all: "All Facilities"
        case .charging: "Charging Hubs"
        case .staging: "Staging Grounds"
        }
    }
    var systemImage: String {
        switch self {
        case .all: "square.grid.2x2"
        case .charging: "bolt.fill"
        case .staging: "parkingsign"
        }
    }
    func includes(_ kind: Facility.Kind) -> Bool { self == .all || kind == .combined || kind.rawValue == rawValue }
}

@MainActor
@Observable
final class FacilityStore {
    static let shared = FacilityStore()
    static let remoteURL = URL(string: "https://cybercabhunter.com/data/facilities.json")!

    /// Where facility photos load from: the site. DEBUG `-facilityPhotoBase <url>`
    /// points it elsewhere (UI tests of the unavailable-photo state).
    nonisolated static var photoBase: URL {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-facilityPhotoBase"), i + 1 < args.count, let u = URL(string: args[i + 1]) { return u }
        #endif
        return URL(string: "https://cybercabhunter.com")!
    }

    private(set) var data: FacilityData
    /// Each city keeps its own filter; it never changes the city or the zones.
    var filters: [String: FacilityFilter] = [:]
    private var refreshed = false

    private static var cacheURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("facilities.json")
    }

    init() {
        let bundled = Self.decode(Bundle.main.url(forResource: "facilities", withExtension: "json").flatMap { try? Data(contentsOf: $0) })
        let cached = Self.decode(Self.cacheURL.flatMap { try? Data(contentsOf: $0) })
        // The newer of the shipped copy and the last downloaded one.
        if let cached, let bundled { data = cached.updated >= bundled.updated ? cached : bundled }
        else if let any = cached ?? bundled { data = any }
        else { data = FacilityData(version: 1, updated: "", labels: .init(type: [:], operational: [:], verification: [:], verificationHelp: nil), facilities: []) }
    }

    static func decode(_ raw: Data?) -> FacilityData? {
        guard let raw, let d = try? JSONDecoder().decode(FacilityData.self, from: raw), !d.facilities.isEmpty else { return nil }
        return d
    }

    /// Once per launch; a failure keeps what the app already has.
    func refresh() async {
        guard !refreshed else { return }
        refreshed = true
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-facilitiesOffline") { return }
        #endif
        var request = URLRequest(url: Self.remoteURL, timeoutInterval: 12)
        request.cachePolicy = .reloadRevalidatingCacheData
        guard let (raw, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let fresh = Self.decode(raw) else { return }
        if fresh != data { data = fresh }
        if let url = Self.cacheURL {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? raw.write(to: url, options: .atomic)
        }
    }

    func facilities(in city: String) -> [Facility] { data.facilities.filter { $0.city == city } }
    func filter(for city: String) -> FacilityFilter { filters[city] ?? .all }
    func visible(in city: String) -> [Facility] { let f = filter(for: city); return facilities(in: city).filter { f.includes($0.type) } }
    func facility(_ id: String) -> Facility? { data.facilities.first { $0.id == id } }

    /// The type names, for places that can't wait on the store (map marker labels);
    /// the same words as the file's labels (WebDataSyncTests checks).
    nonisolated static func typeTitle(_ kind: Facility.Kind) -> String {
        switch kind {
        case .charging: "Charging Hub"
        case .staging: "Staging Ground"
        case .combined: "Charging & Staging"
        }
    }
    func typeLabel(_ f: Facility) -> String { data.labels.type[f.type.rawValue] ?? Self.typeTitle(f.type) }
    func operationalLabel(_ f: Facility) -> String { data.labels.operational[f.operational] ?? f.operational }
    func verificationLabel(_ f: Facility) -> String { data.labels.verification[f.verification] ?? f.verification }
    func verificationHelp(_ f: Facility) -> String { data.labels.verificationHelp?[f.verification] ?? "" }
}
