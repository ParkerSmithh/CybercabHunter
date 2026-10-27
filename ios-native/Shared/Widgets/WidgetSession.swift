import Foundation
import Security

/// The rider's session, as the widgets see it: a copy of the app's token in a
/// Keychain group the app and the widget extension share (Keychain Sharing,
/// "<team>.com.cybercabhunter.shared", named by each target's Info.plist
/// CCHSharedKeychainGroup). The app writes it when the rider signs in or the
/// session is confirmed, and deletes it on sign-out; the widgets only read it,
/// to fetch the rider's own progress and leaderboard place. This device only,
/// after first unlock; never synced.
enum WidgetSession {
    static let service = "com.cybercabhunter.native.widget-session"
    static let account = "session"

    /// The shared group, or nil when this build has none (then nothing is shared).
    static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "CCHSharedKeychainGroup") as? String,
              !g.isEmpty, !g.hasPrefix("$(") else { return nil }
        return g
    }

    private static func query() -> [String: Any]? {
        guard let group else { return nil }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecAttrAccessGroup as String: group]
    }

    static func read() -> String? {
        guard var q = query() else { return nil }
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The app's side: the current token, or nil to remove it. Returns whether
    /// the shared copy changed (so the widgets are only reloaded when it did).
    @discardableResult
    static func write(_ token: String?) -> Bool {
        guard let q = query() else { return false }
        guard let token else {
            return SecItemDelete(q as CFDictionary) == errSecSuccess
        }
        if read() == token { return false }
        let data = Data(token.utf8)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }
}
