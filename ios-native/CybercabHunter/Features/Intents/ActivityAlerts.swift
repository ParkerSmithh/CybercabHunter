import SwiftUI
import UserNotifications

// Activity Alerts: the rider's own choices, OFF until they turn them on here.
// Delivery needs a server push service (APNs credentials, a paid Apple
// Developer Program membership and a Worker job that decides what to send),
// none of which exists yet — so this screen saves the choices on this iPhone,
// says plainly that nothing is sent, and asks for notification permission only
// when the rider switches alerts on. ActivityAlertPolicy is the rule set the
// delivery side will apply (city, categories, quiet hours, staleness, no repeats).

enum AlertCity: String, Codable, CaseIterable, Identifiable, Sendable {
    case austin, dallas, both
    var id: String { rawValue }
    var title: String { switch self { case .austin: "Austin"; case .dallas: "Dallas"; case .both: "Both" } }
    func matches(_ city: String?) -> Bool {
        guard let city = city?.lowercased() else { return true }   // statewide (the Texas DMV)
        return self == .both || city == rawValue
    }
}

/// Only what trustworthy existing data supports. (Service-area changes aren't
/// offered: Cybercab Hunter has no reliable feed of them.)
enum AlertCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case verifiedSightings, cameraDetections, dmvVINs, fleetGrowth
    var id: String { rawValue }
    var title: String {
        switch self {
        case .verifiedSightings: "Approved sightings"
        case .cameraDetections: "Traffic-camera detections"
        case .dmvVINs: "Newly detected DMV VINs"
        case .fleetGrowth: "Significant registry growth"
        }
    }
    var detail: String {
        switch self {
        case .verifiedSightings: "Photo sightings after a moderator approves them."
        case .cameraDetections: "A public traffic camera saw a Cybercab."
        case .dmvVINs: "VINs Cybercab Hunter first detected in a Texas DMV dataset (not registration dates)."
        case .fleetGrowth: "Ten or more vehicles added to the public registry in a week."
        }
    }
}

enum AlertFrequency: String, Codable, CaseIterable, Identifiable, Sendable {
    case asItHappens, dailyDigest
    var id: String { rawValue }
    var title: String { self == .asItHappens ? "As it happens" : "Daily digest" }
}

struct ActivityAlertSettings: Codable, Equatable, Sendable {
    var enabled = false                      // OFF by default, always
    var city: AlertCity = .austin
    var categories: Set<AlertCategory> = []
    var frequency: AlertFrequency = .dailyDigest
    var significantOnly = false
    var quietHours = true
    var quietStart = 22                      // hour, Central time
    var quietEnd = 7

    static let key = "activityAlerts.v1"

    static func load(_ defaults: UserDefaults = .standard) -> ActivityAlertSettings {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(ActivityAlertSettings.self, from: $0) } ?? ActivityAlertSettings()
    }

    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(self), forKey: Self.key)
    }
}

/// Whether alerts can actually be delivered (not yet: see the top of the file).
enum ActivityAlertDelivery {
    static let isAvailable = false
    static let explanation = "Cybercab Hunter can't send these alerts yet: they need a push notification service on Cybercab Hunter's server, which isn't set up. Your choices are saved on this iPhone and nothing is sent until delivery is available."
}

/// Something that could become an alert.
struct AlertEvent: Equatable, Sendable {
    let key: String          // stable identity: the same event never alerts twice
    let category: AlertCategory
    let city: String?        // nil = statewide (Texas DMV)
    let at: Date
    let magnitude: Int       // VINs, vehicles, or 1 for a sighting
}

/// The rules every alert must pass. Pure, so the tests pin them down.
enum ActivityAlertPolicy {
    /// Older than this, it isn't news any more (never a stale sighting as if current).
    static func maxAge(_ c: AlertCategory) -> TimeInterval {
        switch c {
        case .verifiedSightings, .cameraDetections: 2 * 3600
        case .dmvVINs: 3 * 86400
        case .fleetGrowth: 7 * 86400
        }
    }

    static func shouldNotify(_ e: AlertEvent, settings s: ActivityAlertSettings, delivered: Set<String>, now: Date) -> Bool {
        guard s.enabled, s.categories.contains(e.category), s.city.matches(e.city) else { return false }
        guard !delivered.contains(e.key) else { return false }
        let age = now.timeIntervalSince(e.at)
        guard age >= -300, age <= maxAge(e.category) else { return false }
        if s.significantOnly {
            switch e.category {
            case .dmvVINs, .fleetGrowth: guard e.magnitude >= 10 else { return false }
            case .verifiedSightings, .cameraDetections: return false
            }
        }
        if e.category == .fleetGrowth && e.magnitude < 10 { return false }
        if s.quietHours && inQuietHours(now, start: s.quietStart, end: s.quietEnd) { return false }
        return true
    }

    static func inQuietHours(_ date: Date, start: Int, end: Int) -> Bool {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = SiriSpeech.central
        let h = cal.component(.hour, from: date)
        return start == end ? false : start < end ? (h >= start && h < end) : (h >= start || h < end)
    }

    /// The lock screen shows no plate, VIN or person: only a category and city.
    static func lockScreenTitle(_ e: AlertEvent) -> String {
        let place = e.city.map { " in \($0.capitalized)" } ?? ""
        switch e.category {
        case .verifiedSightings: return "New approved Cybercab sighting\(place)"
        case .cameraDetections: return "Cybercab seen by a traffic camera\(place)"
        case .dmvVINs: return "\(e.magnitude) newly detected Texas DMV VINs"
        case .fleetGrowth: return "\(e.magnitude) vehicles added to the registry\(place)"
        }
    }
}

// MARK: - The settings screen (Account › Activity Alerts)

struct ActivityAlertsView: View {
    @State private var settings = ActivityAlertSettings.load()
    @State private var permission: UNAuthorizationStatus = .notDetermined
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { settings.enabled }, set: { on in setEnabled(on) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Activity Alerts").font(.inter(15, .semibold))
                        Text(settings.enabled ? "On" : "Off").font(.inter(12.5)).foregroundStyle(settings.enabled ? Color.brandGold : Color.chFog)
                    }
                }
                .tint(Color.brandGold)
                .accessibilityIdentifier("alertsMasterToggle")
            } footer: {
                Text("Off unless you turn it on. You can turn it off any time.")
            }

            Section("Delivery") {
                Label { Text("Not available yet").font(.inter(15, .semibold)) } icon: { Image(systemName: "exclamationmark.circle").foregroundStyle(Color(hex: 0xFCD34D)) }
                    .accessibilityIdentifier("alertsDeliveryStatus")
                Text(ActivityAlertDelivery.explanation).font(.inter(12.5)).foregroundStyle(Color.chMist)
                LabeledContent("Notification permission") {
                    Text(permissionText).foregroundStyle(Color.chFog)
                }
                .accessibilityIdentifier("alertsPermissionStatus")
                if permission == .denied {
                    Button("Open Settings") { if let u = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(u) } }
                }
            }

            Group {
                Section("City") {
                    Picker("City", selection: binding(\.city)) { ForEach(AlertCity.allCases) { Text($0.title).tag($0) } }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("alertsCity")
                }
                Section {
                    ForEach(AlertCategory.allCases) { c in
                        Toggle(isOn: Binding(get: { settings.categories.contains(c) }, set: { on in
                            if on { settings.categories.insert(c) } else { settings.categories.remove(c) }
                            settings.save()
                        })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title).font(.inter(15))
                                Text(c.detail).font(.inter(12)).foregroundStyle(Color.chFog)
                            }
                        }
                        .tint(Color.brandGold)
                        .accessibilityIdentifier("alertsCategory-\(c.rawValue)")
                    }
                } header: { Text("Alert types") } footer: {
                    Text(settings.enabled && settings.categories.isEmpty ? "Choose at least one type." : "Service-area changes aren't offered: there's no reliable source for them yet.")
                }
                Section("Frequency") {
                    Picker("Frequency", selection: binding(\.frequency)) { ForEach(AlertFrequency.allCases) { Text($0.title).tag($0) } }
                    Toggle("Significant updates only", isOn: binding(\.significantOnly)).tint(Color.brandGold)
                    Toggle("Quiet hours", isOn: binding(\.quietHours)).tint(Color.brandGold)
                    if settings.quietHours {
                        Picker("From", selection: binding(\.quietStart)) { ForEach(0..<24, id: \.self) { Text(Self.hour($0)).tag($0) } }
                        Picker("Until", selection: binding(\.quietEnd)) { ForEach(0..<24, id: \.self) { Text(Self.hour($0)).tag($0) } }
                    }
                }
            }
            .disabled(!settings.enabled)
        }
        .font(.inter(15))
        .appBackground()
        .navigationTitle("Activity Alerts")
        .navigationBarTitleDisplayMode(.inline)
        .task { permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
    }

    private var permissionText: String {
        switch permission {
        case .authorized, .provisional, .ephemeral: "Allowed"
        case .denied: "Not allowed"
        default: "Not asked"
        }
    }

    private func binding<T>(_ kp: WritableKeyPath<ActivityAlertSettings, T>) -> Binding<T> {
        Binding(get: { settings[keyPath: kp] }, set: { settings[keyPath: kp] = $0; settings.save() })
    }

    /// Turning alerts on is the rider's own action; only then is permission asked.
    private func setEnabled(_ on: Bool) {
        settings.enabled = on
        settings.save()
        guard on else { return }
        Task {
            let center = UNUserNotificationCenter.current()
            if await center.notificationSettings().authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            }
            permission = await center.notificationSettings().authorizationStatus
        }
    }

    static func hour(_ h: Int) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.dateFormat = "h a"
        return f.string(from: Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: .now) ?? .now)
    }
}
