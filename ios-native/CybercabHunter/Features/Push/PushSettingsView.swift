import SwiftUI

struct PushSettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var phase
    @Environment(\.openURL) private var openURL
    @State private var preferences = PushPreferences()
    @State private var coordinator = PushCoordinator.shared
    @State private var synchronized = PushPreferences()
    @State private var loaded = false
    @State private var saving = false
    @State private var syncStatus = "Saved on this iPhone."
    var body: some View {
        Form {
            Section {
                LabeledContent("iOS permission", value: permissionLabel)
                if coordinator.authorization == .notDetermined {
                    Button("Allow notifications") { Task { await coordinator.requestPermission(); await coordinator.synchronize() } }
                } else if !coordinator.allowed {
                    Button("Open iOS notification settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                    }
                }
                Text(coordinator.status).font(.footnote).foregroundStyle(.secondary)
                Toggle("Push Notifications", isOn: $preferences.master)
                Toggle("Quiet Hours", isOn: $preferences.quiet)
                if preferences.quiet {
                    time("Start", $preferences.quietStart)
                    time("End", $preferences.quietEnd)
                    Toggle("Major News During Quiet Hours", isOn: $preferences.majorDuringQuiet)
                }
                Toggle("Group Similar Notifications", isOn: $preferences.group)
                Picker("Notification Frequency", selection: $preferences.frequency) {
                    Text("Standard").tag("standard"); Text("Reduced").tag("reduced")
                }
            } header: { Text("General") } footer: {
                Text("Quiet hours use your current timezone. Major news can bypass app quiet hours only; iOS Focus and notification settings still apply. Reduced frequency spaces ordinary news and Community alerts hourly. Explicit category frequency choices take precedence.")
            }
            Section {
                Picker("News", selection: $preferences.news) {
                    Text("Major stories only").tag("major"); Text("All news stories").tag("all"); Text("Off").tag("off")
                }
            } header: { Text("News") } footer: { Text("New stories from the News page, using its existing importance classification.") }
            Section { mode("DMV Entries", $preferences.dmv) } header: { Text("DMV") } footer: { Text("Newly discovered Tesla and Cybercab registrations, grouped by batch.") }
            Section {
                Toggle("Cybercab Daily Report", isOn: $preferences.daily)
                time("Delivery time", $preferences.dailyTime)
                metrics($preferences.dailyMetrics)
                Toggle("Compare with previous day", isOn: $preferences.comparison)
            } header: { Text("Cybercab Daily Report") } footer: { Text("The previous completed day in America/Chicago, matching Cybercab Daily. Delivery uses your local timezone. Unavailable reports wait for complete data. Select at least one metric.") }
            Section {
                mode("New Cybercabs", $preferences.registry)
                mode("Sightings", $preferences.sightings)
                mode("Camera Detections", $preferences.cameras)
            } header: { Text("Fleet & activity") } footer: { Text("Public vehicles, approved public sightings, and valid tracked camera detections. Daily summaries use your report delivery time.") }
            Section {
                Toggle("Comments on my posts", isOn: $preferences.comments)
                Toggle("Replies to my comments", isOn: $preferences.replies)
                Toggle("Mentions", isOn: $preferences.mentions)
                Toggle("Likes on my posts", isOn: $preferences.likes)
            } header: { Text("Community") } footer: { Text("Available when signed in. Replies to posts are comments in Social. Push previews contain no names or post text. Turn all controls off to disable Community alerts.") }
            Section {
                Toggle("Weekly Fleet Recap", isOn: $preferences.weekly)
                Picker("Delivery day", selection: $preferences.weeklyDay) {
                    ForEach(0..<7) { day in Text(Calendar.current.weekdaySymbols[day]).tag(day) }
                }
                time("Delivery time", $preferences.weeklyTime)
                metrics($preferences.weeklyMetrics)
            } header: { Text("Weekly recap") } footer: { Text("Seven completed Cybercab Daily dates. Recaps begin once seven complete daily snapshots are available.") }
            Section {
                Button(saving ? "Saving…" : "Save notification settings") { Task { await save() } }.disabled(!loaded || saving)
                Text(syncStatus).font(.footnote).foregroundStyle(.secondary)
                if session.user == nil { Text("Sign in to synchronize preferences and register this device. Choices remain saved on this iPhone.").font(.footnote) }
            }
        }
        .navigationTitle("Notifications")
        .appBackground()
        .tint(Color(hex: 0xFFD60A))
        .task(id: session.user?.id) { await load() }
        .onChange(of: preferences) { if loaded { preferences.save(session.user?.id); UserDefaults.standard.set(preferences != synchronized, forKey: PushPreferences.key(session.user?.id) + ".dirty"); syncStatus = "Saved on this iPhone. Save to synchronize." } }
        .onChange(of: phase) { if phase == .active { Task { await coordinator.connect(api: session.api, user: session.user?.id) } } }
    }
    private var permissionLabel: String {
        switch coordinator.authorization {
        case .notDetermined: "Not requested"
        case .denied: "Disabled"
        case .authorized: "Allowed"
        case .provisional: "Deliver quietly"
        case .ephemeral: "Temporary"
        @unknown default: "Unknown"
        }
    }
    private func mode(_ title: String, _ value: Binding<String>) -> some View {
        Picker(title, selection: value) {
            Text("Instant alerts").tag("instant"); Text("Daily summary").tag("daily"); Text("Off").tag("off")
        }
    }
    private func time(_ title: String, _ value: Binding<Int>) -> some View {
        DatePicker(title, selection: Binding(get: {
            Calendar.current.date(bySettingHour: value.wrappedValue / 60, minute: value.wrappedValue % 60, second: 0, of: Date()) ?? Date()
        }, set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            value.wrappedValue = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        }), displayedComponents: .hourAndMinute)
    }
    private func metrics(_ values: Binding<[String]>) -> some View {
        ForEach(["registry", "dmv", "sightings", "cameras"], id: \.self) { key in
            Toggle(["registry": "New Cybercabs", "dmv": "DMV additions", "sightings": "Sightings", "cameras": "Camera detections"][key]!, isOn: Binding(get: { values.wrappedValue.contains(key) }, set: { enabled in
                if enabled { values.wrappedValue.append(key) } else if values.wrappedValue.count > 1 { values.wrappedValue.removeAll { $0 == key } }
            }))
        }
    }
    private func load() async {
        loaded = false
        preferences = .load(session.user?.id)
        if session.user != nil {
            do {
                let response: PushPreferencesResponse = try await session.api.get("/api/push/preferences", authenticated: true, fresh: true)
                if let remote = response.preferences {
                    synchronized = remote
                    if !UserDefaults.standard.bool(forKey: PushPreferences.key(session.user?.id) + ".dirty") { preferences = remote; preferences.save(session.user?.id) }
                }
                syncStatus = response.preferences == nil ? "Save to initialize server preferences." : "Settings synchronized."
            } catch { syncStatus = "Server sync unavailable. Your saved preferences are preserved." }
        }
        preferences.timezone = TimeZone.current.identifier
        loaded = true
        await coordinator.connect(api: session.api, user: session.user?.id)
    }
    private func save() async {
        preferences.timezone = TimeZone.current.identifier
        preferences.save(session.user?.id)
        guard session.user != nil else { syncStatus = "Saved on this iPhone."; return }
        saving = true
        defer { saving = false }
        do {
            let _: PushPreferencesResponse = try await session.api.send("/api/push/preferences", method: "PUT", body: JSONEncoder().encode(preferences))
            synchronized = preferences
            UserDefaults.standard.set(false, forKey: PushPreferences.key(session.user?.id) + ".dirty")
            syncStatus = "Settings synchronized."
            await coordinator.synchronize()
        } catch { syncStatus = "Saved on this iPhone. Server sync failed; tap Save to retry." }
    }
}
