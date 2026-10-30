import SwiftUI
import UserNotifications
import Observation

@MainActor @Observable
final class PushCoordinator {
    static let shared = PushCoordinator()
    var authorization: UNAuthorizationStatus = .notDetermined
    var registered = false
    var status = "Push delivery requires server and Apple Developer configuration."
    var pendingURL: URL?
    var token: String?
    private let tokenStore = KeychainStore(service: "com.cybercabhunter.native.push")
    private var api: APIClient?
    private var userID: String?
    private var syncing = false
    var installationID: String {
        if let id = UserDefaults.standard.string(forKey: "push.installation.v1") { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "push.installation.v1")
        return id
    }
    var allowed: Bool { [.authorized, .provisional, .ephemeral].contains(authorization) }
    func refresh() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
    func requestPermission() async {
        await refresh()
        if authorization == .notDetermined {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refresh()
        }
        if allowed { UIApplication.shared.registerForRemoteNotifications() }
    }
    func connect(api: APIClient, user: String?) async {
        self.api = api; userID = user
        if token == nil { token = tokenStore.read("apns-token") }
        await refresh()
        if user != nil && allowed { UIApplication.shared.registerForRemoteNotifications() }
        await synchronize()
    }
    func receive(_ data: Data) async {
        token = data.map { String(format: "%02x", $0) }.joined()
        if let token { try? tokenStore.write(token, account: "apns-token") }
        await synchronize()
    }
    func synchronize() async {
        guard !syncing, let api, userID != nil, let token else { return }
        let owner = userID
        syncing = true
        defer { syncing = false }
        // Explicit configuration determines the APNs environment, never a guess
        // based on DEBUG (Ad Hoc builds also use production tokens).
        guard let environment = Bundle.main.object(forInfoDictionaryKey: "PushEnvironment") as? String,
              ["sandbox", "production"].contains(environment) else {
            registered = false; status = "Push signing has not been configured for this build."; return
        }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["id": installationID, "token": token, "environment": environment, "authorized": allowed, "timezone": TimeZone.current.identifier])
            let _: PushWriteResponse = try await api.send("/api/push/device", method: "PUT", body: body)
            guard userID == owner else { return }
            registered = allowed
            status = allowed ? "Device registered for push notifications." : "Notifications are disabled in iOS Settings."
        } catch {
            guard userID == owner else { return }
            registered = false; status = "Device registration is pending. Open Notifications to retry."
        }
    }
    /// Called with the captured authenticated API before erasing the session.
    func unregister(api: APIClient) async {
        registered = false; self.api = nil; userID = nil
        UIApplication.shared.unregisterForRemoteNotifications()
        let body = try? JSONSerialization.data(withJSONObject: ["id": installationID])
        let _: PushWriteResponse? = try? await api.send("/api/push/device", method: "DELETE", body: body)
    }
}

final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushCoordinator.shared.receive(deviceToken) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushCoordinator.shared.registered = false; PushCoordinator.shared.status = "Remote notification registration is unavailable. Your preferences are saved." }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // "Finish your Cybercab sighting" (the Share extension): the form, with the shared photo.
        if response.notification.request.content.userInfo[SightingShareInbox.notificationKey] != nil {
            await MainActor.run { AppRouter.shared.openSharedSighting() }
            return
        }
        guard let raw = response.notification.request.content.userInfo["link"] as? String,
              raw.hasPrefix("/"), !raw.hasPrefix("//"), let url = URL(string: raw, relativeTo: URL(string: "https://cybercabhunter.com")!)?.absoluteURL,
              url.host == "cybercabhunter.com" else { return }
        await MainActor.run { PushCoordinator.shared.pendingURL = url }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [] }
}
