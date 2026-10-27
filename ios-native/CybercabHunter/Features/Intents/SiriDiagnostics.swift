import Foundation
import OSLog
import AppIntents
import CryptoKit
import MachO

/// Invocation evidence for device-side routing investigations. Logs only fixed
/// intent identifiers, finite public city/period choices, correlation IDs, and
/// error categories. No speech transcript, plate, VIN, token, or answer payload.
/// An answer_ready event means data was composed, not that Siri displayed it.
enum SiriDiagnostics {
    private static let logger = Logger(subsystem: "com.cybercabhunter.native", category: "SiriIntent")

    enum Presence: String, Sendable { case unset, set, derived, unavailable }

    /// Only finite public parameter values and presence flags. Never dates,
    /// coordinates, entity identifiers, answer text, or arbitrary user input.
    struct Parameters: Equatable, Sendable {
        var selection = "-"
        var city = "not_applicable", metric = "not_applicable", activity = "not_applicable"
        var model = "not_applicable", period = "not_applicable", compare = "not_applicable"
        var cityState = Presence.unavailable, metricState = Presence.unavailable
        var activityState = Presence.unavailable, modelState = Presence.unavailable
        var periodState = Presence.unavailable, compareState = Presence.unavailable
        var fromState = Presence.unavailable, toState = Presence.unavailable
        var customFrom = false, customTo = false
        var locationAuthorization = "not_applicable"
    }

    struct Event: Equatable, Sendable {
        let intent: String, phase: String, id: String, parameters: Parameters
        let selection: String, outcome: String, error: String
        var line: String {
            let p = parameters
            return "intent=\(intent) phase=\(phase) id=\(id) city=\(p.city) metric=\(p.metric) activity=\(p.activity) model=\(p.model) period=\(p.period) compare=\(p.compare) city_state=\(p.cityState.rawValue) metric_state=\(p.metricState.rawValue) activity_state=\(p.activityState.rawValue) model_state=\(p.modelState.rawValue) period_state=\(p.periodState.rawValue) compare_state=\(p.compareState.rawValue) from_state=\(p.fromState.rawValue) to_state=\(p.toState.rawValue) custom_from=\(p.customFrom) custom_to=\(p.customTo) location_authorization=\(p.locationAuthorization) selection=\(selection == "-" ? p.selection : selection) outcome=\(outcome) error=\(error)"
        }
    }

    #if DEBUG
    // Serialized tests observe the same finite event that OSLog receives.
    nonisolated(unsafe) static var testObserver: ((Event) -> Void)?
    #endif

    struct Invocation: Sendable {
        let intent: String
        let id: String
        var parameters: Parameters
        private var finished = false

        init(_ intent: String, parameters: Parameters, id: String = UUID().uuidString) {
            self.id = id
            self.intent = intent; self.parameters = parameters
            emit("entered")
        }
        func emit(_ phase: String, outcome: String = "pending", error: Error? = nil) {
            record(intent: intent, phase: phase, id: id, parameters: parameters, outcome: outcome, error: error)
        }
        mutating func complete(_ outcome: String = "answer_composed") {
            guard !finished else { return }; finished = true
            emit("answer_ready", outcome: outcome)
            emit("completed", outcome: outcome)
        }
        mutating func fail(_ error: Error) {
            guard !finished else { return }; finished = true
            emit("failed", outcome: "error", error: error)
        }
    }

    static func errorCategory(_ error: Error) -> String {
        switch error {
        case APIError.http(let status, _): return "http_\(status)"
        case APIError.unauthorized: return "http_401"
        case APIError.decoding: return "decoding"
        case APIError.transport: return "transport"
        case IntentFailure.activityRequired: return "activity_required"
        case IntentFailure.cityRequired: return "city_required"
        case IntentFailure.cityMismatch: return "city_mismatch"
        case IntentFailure.locationNotAllowedYet: return "location_not_configured"
        case IntentFailure.locationDenied: return "location_denied"
        case IntentFailure.locationUnavailable: return "location_unavailable"
        case IntentFailure.outsideServiceAreas: return "outside_service_areas"
        case IntentFailure.unavailable: return "unavailable"
        case IntentFailure.notFound: return "not_found"
        case is CancellationError: return "cancelled"
        case let e as URLError where e.code == .cancelled: return "cancelled"
        default: return "other"
        }
    }

    /// Fleet and briefing can also legitimately speak DMV data. Instrument
    /// their entry points so the next reproduction can identify that routing.
    static func traceAnswer(intent: String, selection: String = "-", operation: () async throws -> SiriAnswer) async throws -> SiriAnswer {
        let id = UUID().uuidString
        record(intent: intent, phase: "entered", id: id, selection: selection)
        do {
            let answer = try await operation()
            record(intent: intent, phase: "answer_ready", id: id, selection: selection)
            return answer
        } catch {
            record(intent: intent, phase: "data_failed", id: id, selection: selection, error: error)
            throw error
        }
    }

    static func record(intent: String, phase: String, id: String, city: String = "-", period: String = "-", selection: String = "-", parameters: Parameters? = nil, outcome: String = "-", error: Error? = nil) {
        var p = parameters ?? Parameters()
        if parameters == nil { p.city = city; p.period = period }
        let event = Event(intent: intent, phase: phase, id: id, parameters: p, selection: selection,
                          outcome: outcome, error: error.map(errorCategory) ?? "none")
        logger.notice("\(event.line, privacy: .public)")
        #if DEBUG
        testObserver?(event)
        #endif
    }
}

extension IntentParameter {
    /// Framework-provided vs unset, not a claim about the user's transcript.
    var diagnosticPresence: SiriDiagnostics.Presence {
        if #available(iOS 18.2, *) {
            switch valueState {
            case .unset: return .unset
            case .set: return .set
            @unknown default: return .unavailable
            }
        }
        return .unavailable
    }
}

/// Artifact identity only. This is separate from invocation evidence: metadata
/// presence and a returned refresh call do not prove system-side registration.
enum SiriStartupDiagnostics {
    static let marker = "siri-growth-diagnostics-v3"
    static let metadataLimit = 4 * 1024 * 1024
    private static let logger = Logger(subsystem: "com.cybercabhunter.native", category: "SiriRegistration")

    struct Metadata: Equatable, Sendable {
        let status: String
        let sha256: String
        let growth: String
        let actions: Int?

        init(data: Data?, unavailable: String = "missing") {
            guard let data else {
                status = unavailable; sha256 = "unavailable"; growth = "unknown"; actions = nil
                return
            }
            guard data.count <= SiriStartupDiagnostics.metadataLimit else {
                status = "too_large"; sha256 = "unavailable"; growth = "unknown"; actions = nil
                return
            }
            sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let exported = root["actions"] as? [String: Any],
                  exported.values.allSatisfy({ $0 is [String: Any] }) else {
                status = "invalid"; growth = "unknown"; actions = nil
                return
            }
            status = "readable"
            growth = exported["FleetGrowthIntent"] == nil ? "absent" : "present"
            actions = exported.count
        }
    }

    /// Only controlled version/build values and canonical UUIDs may be public.
    static func safeVersion(_ value: String?) -> String {
        guard let value, !value.isEmpty, value.count <= 32,
              value.allSatisfy({ "0123456789.".contains($0) }) else { return "unavailable" }
        return value
    }

    static func snapshotLine(version: String?, build: String?, executableUUID: String?, metadata: Metadata) -> String {
        let uuid = executableUUID.flatMap(UUID.init(uuidString:))?.uuidString ?? "unavailable"
        return "event=startup_artifact marker=\(marker) version=\(safeVersion(version)) build=\(safeVersion(build)) executable_uuid=\(uuid) metadata_status=\(metadata.status) metadata_sha256=\(metadata.sha256) FleetGrowthIntent=\(metadata.growth) action_count=\(metadata.actions.map(String.init) ?? "unknown")"
    }

    /// Image zero can be a simulator/runtime image. Select the loaded app
    /// executable explicitly; never log an installation or user path.
    static func executableUUID() -> String? {
        guard let executable = Bundle.main.executableURL?.lastPathComponent else { return nil }
        for index in 0..<_dyld_image_count() {
            guard let name = _dyld_get_image_name(index),
                  URL(fileURLWithPath: String(cString: name)).lastPathComponent == executable,
                  let header = _dyld_get_image_header(index) else { continue }
            return uuid(header: header)
        }
        return nil
    }

    static func uuid(header: UnsafePointer<mach_header>) -> String? {
        guard header.pointee.magic == MH_MAGIC_64 else { return nil }
        let base = UnsafeRawPointer(header)
        let h = base.load(as: mach_header_64.self)
        var offset = MemoryLayout<mach_header_64>.size
        let end = offset + Int(h.sizeofcmds)
        for _ in 0..<h.ncmds {
            guard offset + MemoryLayout<load_command>.size <= end else { return nil }
            let command = base.advanced(by: offset).load(as: load_command.self)
            let size = Int(command.cmdsize)
            guard size >= MemoryLayout<load_command>.size, size <= end - offset else { return nil }
            if command.cmd == LC_UUID {
                guard size >= MemoryLayout<uuid_command>.size else { return nil }
                return UUID(uuid: base.advanced(by: offset).load(as: uuid_command.self).uuid).uuidString
            }
            offset += size
        }
        return nil
    }

    static func bundledMetadata(_ bundle: Bundle = .main) -> Metadata {
        guard let url = bundle.url(forResource: "extract", withExtension: "actionsdata", subdirectory: "Metadata.appintents") else {
            return Metadata(data: nil)
        }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
            guard let size, size <= metadataLimit else { return Metadata(data: nil, unavailable: "too_large") }
            return Metadata(data: try Data(contentsOf: url, options: .mappedIfSafe))
        } catch { return Metadata(data: nil, unavailable: "unreadable") }
    }

    static func refresh(request: () -> Void, record: (String) -> Void) {
        record("event=refresh_requested marker=\(marker)")
        request()
        record("event=refresh_call_returned marker=\(marker) system_completion=unobservable error_channel=not_provided")
    }

    static func start() {
        // No API exposes completion/error for this synchronous Void method.
        refresh(request: { CybercabShortcuts.updateAppShortcutParameters() }, record: {
            logger.notice("\($0, privacy: .public)")
        })
        Task.detached(priority: .utility) {
            let bundle = Bundle.main
            let line = snapshotLine(version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                                    build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                                    executableUUID: executableUUID(), metadata: bundledMetadata(bundle))
            logger.notice("\(line, privacy: .public)")
        }
    }
}
