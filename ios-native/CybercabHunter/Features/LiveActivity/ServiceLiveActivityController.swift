import ActivityKit
import Foundation
import Observation
import UIKit

// The service-status Live Activity (Dynamic Island + Lock Screen), from the app's
// side. OFF until the rider turns it on in the Live now card; turning it off ends
// it at once. Its state comes from ServiceSchedule (the card's own logic) and is
// fixed until the next change of service: the countdown and the bar are drawn by
// the system, so nothing polls the website or runs timers. The app updates it
// whenever it's opened (and when service changes while it's open); if it isn't
// opened at a change, the activity turns stale at that moment (staleDate) and
// says so. iOS ends Live Activities after about 8 hours; the next app open
// starts a fresh one, while the switch is on.

/// What the controller needs from ActivityKit (tests use a fake).
@MainActor
protocol ServiceActivityBackend: AnyObject {
    /// The device can show Live Activities at all (iPhone).
    var isSupported: Bool { get }
    /// Live Activities are allowed for this app (Settings › Cybercab Hunter › Live Activities).
    var isAuthorized: Bool { get }
    /// The states of this app's running service activities.
    var running: [ServiceActivityAttributes.ContentState] { get }
    func start(_ attributes: ServiceActivityAttributes, _ state: ServiceActivityAttributes.ContentState, staleDate: Date) throws
    /// Updates the first running activity and ends any others.
    func update(_ state: ServiceActivityAttributes.ContentState, staleDate: Date) async
    func endAll() async
}

@MainActor
final class ActivityKitServiceBackend: ServiceActivityBackend {
    var isSupported: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    var isAuthorized: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    private var activities: [Activity<ServiceActivityAttributes>] {
        Activity<ServiceActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }
    var running: [ServiceActivityAttributes.ContentState] { activities.map(\.content.state) }

    func start(_ attributes: ServiceActivityAttributes, _ state: ServiceActivityAttributes.ContentState, staleDate: Date) throws {
        // No push type: nothing is sent to Apple's push service or to Cybercab Hunter's server.
        _ = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: staleDate), pushType: nil)
    }

    func update(_ state: ServiceActivityAttributes.ContentState, staleDate: Date) async {
        await Self.updateAll(state, staleDate: staleDate)
    }

    func endAll() async { await Self.endEvery() }

    // Off the main actor: each Activity stays inside this task (it isn't Sendable).
    nonisolated private static func updateAll(_ state: ServiceActivityAttributes.ContentState, staleDate: Date) async {
        let list = Activity<ServiceActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
        for (i, a) in list.enumerated() {
            if i == 0 { await a.update(ActivityContent(state: state, staleDate: staleDate)) }
            else { await a.end(nil, dismissalPolicy: .immediate) }
        }
    }

    nonisolated private static func endEvery() async {
        for a in Activity<ServiceActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
    }
}

@MainActor
@Observable
final class ServiceLiveActivityController {
    static let shared = ServiceLiveActivityController()
    static let enabledKey = "serviceLiveActivity.enabled"

    /// The rider's choice: false until they turn it on.
    private(set) var enabled: Bool
    /// Why it isn't showing (or nil when all is well).
    private(set) var problem: Problem?

    enum Problem: Equatable {
        case unsupported, notAuthorized, couldNotStart
        var message: String {
            switch self {
            case .unsupported: "Live Activities aren't available on this device."
            case .notAuthorized: "Live Activities are turned off for Cybercab Hunter. Turn them on in Settings › Cybercab Hunter › Live Activities."
            case .couldNotStart: "iOS didn't start the Live Activity. Try again in a moment."
            }
        }
    }

    @ObservationIgnored let backend: ServiceActivityBackend
    @ObservationIgnored let defaults: UserDefaults
    /// The service hours last loaded (the card passes the API's); the standard day until then.
    @ObservationIgnored var schedule: ServiceSchedule = .standard

    init(backend: ServiceActivityBackend? = nil, defaults: UserDefaults = .standard) {
        self.backend = backend ?? ActivityKitServiceBackend()
        self.defaults = defaults
        self.enabled = defaults.bool(forKey: Self.enabledKey)   // absent = false
        if !self.backend.isSupported { problem = .unsupported }
    }

    var isSupported: Bool { backend.isSupported }
    /// Showing right now (on, allowed, running).
    var isShowing: Bool { enabled && backend.isAuthorized && !backend.running.isEmpty }

    /// The switch. On: only when the device supports it and Live Activities are
    /// allowed (otherwise it stays off and says why). Off: ends it at once.
    func setEnabled(_ on: Bool, now: Date = .now) async {
        if on {
            guard backend.isSupported else { problem = .unsupported; return }
            guard backend.isAuthorized else { problem = .notAuthorized; return }
            enabled = true
            defaults.set(true, forKey: Self.enabledKey)
            await reconcile(now: now)
        } else {
            enabled = false
            defaults.set(false, forKey: Self.enabledKey)
            problem = backend.isSupported ? nil : .unsupported
            await backend.endAll()
        }
    }

    /// Brings the running activity in line with the switch and the service day:
    /// at launch, when the app comes back, when the hours load and at each change
    /// of service while the app is open. Never turns the switch on by itself.
    func reconcile(now: Date = .now) async {
        guard enabled else {
            if !backend.running.isEmpty { await backend.endAll() }
            return
        }
        guard backend.isSupported else { problem = .unsupported; return }
        guard backend.isAuthorized else { problem = .notAuthorized; return }
        let state = ServiceActivityAttributes.ContentState(schedule.status(at: now))
        let running = backend.running
        if running.isEmpty {
            do {
                try backend.start(attributes, state, staleDate: state.until)
                problem = nil
            } catch {
                problem = .couldNotStart
            }
        } else {
            if running.count > 1 || running[0] != state { await backend.update(state, staleDate: state.until) }
            problem = nil
        }
    }

    var attributes: ServiceActivityAttributes {
        ServiceActivityAttributes(cityName: "Austin", openLabel: schedule.label(schedule.openMinute), closeLabel: schedule.label(schedule.closeMinute))
    }
}
