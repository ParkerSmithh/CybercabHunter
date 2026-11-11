import AppIntents
import Foundation

// iPhone system entry points: Control Center, Lock Screen controls, the Action
// Button and the Shortcuts app. They all name a QuickAction and hand it to ONE
// place, AppRouter.perform(_:) in the app, through QuickActionCenter. This file
// is compiled into the app AND the widget extension (Shared/), because a
// control's intent type must exist in both; with openAppWhenRun the system
// always runs perform() in the app, never in the extension.

/// What a system control or shortcut asks the app to show.
enum QuickAction: String, CaseIterable, Codable, Sendable {
    /// The sighting form, opening Apple's camera (asked for permission only then).
    case camera
    /// The sighting form, as the Sightings tab's button opens it.
    case newSighting = "new-sighting"
    /// The Zones map, on the city the rider last looked at.
    case map
    /// Home: the fleet dashboard.
    case fleet
    /// The Community tab.
    case community
    /// Just the app, as the rider left it.
    case open

    var title: String {
        switch self {
        case .camera: "New Sighting"
        case .newSighting: "Submit a Sighting"
        case .map: "Cybercab Map"
        case .fleet: "Fleet Stats"
        case .community: "Community"
        case .open: "Cybercab Hunter"
        }
    }

    /// Monochrome SF Symbols: the system tints them for Control Center and the Lock Screen.
    var systemImage: String {
        switch self {
        case .camera: "camera.fill"
        case .newSighting: "square.and.pencil"
        case .map: "map.fill"
        case .fleet: "chart.bar.fill"
        case .community: "person.2.fill"
        case .open: "car.fill"
        }
    }

    /// `cybercabhunter-widget://action?do=<action>`: the same request as a link
    /// (the app's existing widget URL scheme), for tests and `simctl openurl`.
    var url: URL { WidgetLink.url("action", query: ["do": rawValue]) }

    init?(url: URL) {
        guard url.scheme == WidgetLink.scheme, url.host() == "action",
              let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "do" })?.value
        else { return nil }
        self.init(rawValue: value)
    }

    /// Asks for the camera (the only action that does, and only when run).
    var usesCamera: Bool { self == .camera }
    var opensSightingForm: Bool { self == .camera || self == .newSighting }
}

/// The hand-off from an intent's perform() to the app's router. The app
/// connects its router at launch; a request that arrives first (a cold
/// launch) waits here and is delivered when it connects.
@MainActor
enum QuickActionCenter {
    private static var handler: ((QuickAction) -> Void)?
    private(set) static var pending: QuickAction?

    static func request(_ action: QuickAction) {
        if let handler { handler(action) } else { pending = action }
    }

    /// Called once by the app's router; delivers a request that came first.
    static func connect(_ handler: @escaping (QuickAction) -> Void) {
        self.handler = handler
        if let p = pending { pending = nil; handler(p) }
    }

    #if DEBUG
    /// Tests only.
    static func reset() { handler = nil; pending = nil }
    #endif
}

// MARK: - The intents (Shortcuts, Action Button, controls)

/// Opens the sighting form with Apple's camera. Nothing is taken or submitted
/// automatically: the rider takes the photo and taps Submit.
struct OpenSightingCameraIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Cybercab Hunter Camera"
    static let description = IntentDescription("Opens the sighting form with the camera, ready to photograph a Cybercab. Camera access is asked for only the first time. Nothing is submitted until you tap Submit.", categoryName: "Open")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary { Summary("Open the Cybercab Hunter camera") }
    @MainActor func perform() async throws -> some IntentResult {
        QuickActionCenter.request(.camera)
        return .result()
    }
}

/// Opens the sighting form (the existing "Submit a sighting" shortcut, same
/// type so shortcuts people already built keep working).
struct SubmitSightingIntent: AppIntent {
    static let title: LocalizedStringResource = "New Cybercab Sighting"
    static let description = IntentDescription("Opens the form to submit a photo of a Cybercab you spotted. You need to be signed in. Nothing is submitted until you tap Submit.", categoryName: "Open")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary { Summary("Start a Cybercab sighting") }
    @MainActor func perform() async throws -> some IntentResult {
        QuickActionCenter.request(.newSighting)
        return .result()
    }
}

/// Opens the Zones map on the city the rider last chose (no location needed).
struct OpenCybercabMapIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Cybercab Map"
    static let description = IntentDescription("Opens the Zones map on the city you last looked at. It doesn't use your location.", categoryName: "Open")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary { Summary("Open the Cybercab map") }
    @MainActor func perform() async throws -> some IntentResult {
        QuickActionCenter.request(.map)
        return .result()
    }
}

/// Opens Home: the fleet dashboard.
struct OpenFleetDashboardIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Fleet Dashboard"
    static let description = IntentDescription("Opens the Cybercab Hunter home dashboard with the latest fleet statistics.", categoryName: "Open")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary { Summary("Open the fleet dashboard") }
    @MainActor func perform() async throws -> some IntentResult {
        QuickActionCenter.request(.fleet)
        return .result()
    }
}

/// Opens the Community tab.
struct OpenCommunityIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Cybercab Community"
    static let description = IntentDescription("Opens Community: posts, leaderboards and spotters.", categoryName: "Open")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary { Summary("Open Cybercab Community") }
    @MainActor func perform() async throws -> some IntentResult {
        QuickActionCenter.request(.community)
        return .result()
    }
}

/// Opens the app as the rider left it.
struct OpenCybercabHunterIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Cybercab Hunter"
    static let description = IntentDescription("Opens Cybercab Hunter where you left it.", categoryName: "Open")
    static let openAppWhenRun = true
    static var parameterSummary: some ParameterSummary { Summary("Open Cybercab Hunter") }
    @MainActor func perform() async throws -> some IntentResult {
        QuickActionCenter.request(.open)
        return .result()
    }
}
