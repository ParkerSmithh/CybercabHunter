import Foundation
import Observation

extension Notification.Name {
    /// The rider's name, username, photo or privacy changed: Community and
    /// other screens reload what they show about them.
    static let profileChanged = Notification.Name("cch.profileChanged")
}

/// The signed-in rider's settings (the website's Profile page, profile.html):
/// profile, photo and the Community privacy switch, saved through the same
/// endpoints. PATCH /api/profile always writes the full set, so every save
/// starts from the server's current values.
@MainActor
@Observable
final class AccountModel {
    private(set) var settings: ProfileSettings?
    private(set) var loadFailed = false
    private(set) var progress: MyProgress?
    /// The server's answer (GET /api/moderation/access); each moderation
    /// request is still authorized by the Worker on its own.
    private(set) var isModerator = false
    private(set) var savingPrivacy = false
    var privacyError: String?

    static let errors = [
        "handle_taken": "That username is already taken.",
        "invalid_handle": "Usernames must be 3-20 characters: lowercase letters, numbers, and underscores only.",
        "invalid_body": "Something went wrong. Please try again."
    ]
    static let avatarErrors = [
        "unsupported_file_type": "Please choose a JPEG, PNG or WebP image.",
        "file_too_large": "That image is too large. Please choose one under 5 MB.",
        "invalid_dimensions": "That image couldn't be used. Please try another.",
        "missing_image": "That image couldn't be used. Please try another."
    ]

    func load(api: APIClient) async {
        async let s: ProfileResponse? = try? api.get("/api/profile", authenticated: true)
        async let p: MyProgress? = try? api.get("/api/xp/me", authenticated: true)
        async let m: ModerationAccess? = try? api.get("/api/moderation/access", authenticated: true)
        let (profile, prog, access) = await (s, p, m)
        if let profile { settings = profile.user; loadFailed = false } else if settings == nil { loadFailed = true }
        progress = prog ?? progress
        isModerator = access?.moderator == true
    }

    func reset() { settings = nil; progress = nil; isModerator = false; loadFailed = false }

    /// Saves the full set (the website's Save). Returns an error message, or nil.
    func save(_ next: ProfileSettings, api: APIClient) async -> String? {
        if let h = ProfileSettings.handleProblem(next.handle ?? "") { return h }
        do {
            let r: ProfileSaved = try await api.send("/api/profile", method: "PATCH", body: JSONBody.make(next.body()))
            var merged = next
            merged.displayName = r.user.displayName
            merged.handle = r.user.handle
            merged.bio = r.user.bio
            merged.profileVisibility = r.user.profileVisibility
            merged.leaderboardOptIn = r.user.leaderboardOptIn
            settings = merged
            NotificationCenter.default.post(name: .profileChanged, object: nil)
            return nil
        } catch {
            return SocialText.code(error).flatMap { Self.errors[$0] } ?? (error as? APIError == .unauthorized ? "Your session has ended. Sign in again." : Self.errors["invalid_body"])
        }
    }

    /// The privacy switch: the current settings with the opt-in changed.
    /// The value the switch shows: the one being saved, else the server's.
    var optInShown: Bool { pendingOptIn ?? settings?.leaderboardOptIn ?? false }
    private(set) var pendingOptIn: Bool?

    /// The switch was flipped: it shows the new value and is disabled at once
    /// (no second flip while saving); a refused save puts it back.
    func requestOptIn(_ on: Bool, api: APIClient) {
        guard settings != nil, !savingPrivacy else { return }
        savingPrivacy = true
        pendingOptIn = on
        privacyError = nil
        Task { await setOptIn(on, api: api) }
    }

    func setOptIn(_ on: Bool, api: APIClient) async {
        guard var next = settings else { return }
        next.leaderboardOptIn = on
        savingPrivacy = true
        defer { savingPrivacy = false; pendingOptIn = nil }
        privacyError = await save(next, api: api)
    }

    /// POST /api/profile/avatar with the two square variants (512 and 128 px).
    func uploadAvatar(large: Data, thumb: Data, api: APIClient) async -> String? {
        var form = MultipartForm()
        form.addFile("large", data: large, filename: "avatar-512", contentType: "image/jpeg")
        form.addFile("thumb", data: thumb, filename: "avatar-128", contentType: "image/jpeg")
        do {
            let r: AvatarSaved = try await api.upload("/api/profile/avatar", method: "POST", form: form)
            settings?.avatarUrl = r.avatarUrl
            settings?.avatarSource = "custom"
            NotificationCenter.default.post(name: .profileChanged, object: nil)
            return nil
        } catch {
            return SocialText.code(error).flatMap { Self.avatarErrors[$0] } ?? "Couldn't save your photo. Please try again."
        }
    }

    func removeAvatar(api: APIClient) async -> String? {
        do {
            let r: AvatarRemoved = try await api.send("/api/profile/avatar", method: "DELETE")
            // What the server shows now: the Google picture when there is one, else initials.
            settings?.avatarUrl = r.avatarUrl
            settings?.avatarSource = r.avatarSource
            NotificationCenter.default.post(name: .profileChanged, object: nil)
            return nil
        } catch { return "Couldn't remove your photo. Please try again." }
    }

    /// DELETE /api/account { confirm: "DELETE" } — the session's own account only.
    static func deleteAccount(api: APIClient) async -> String? {
        do {
            let _: SocialOK = try await api.send("/api/account", method: "DELETE", body: JSONBody.make(["confirm": "DELETE"]))
            return nil
        } catch APIError.http(409, "last_moderator"?) {
            return "You are the last moderator. Transfer the role before deleting your account."
        } catch APIError.unauthorized {
            return "Your session has ended. Sign in again to delete your account."
        } catch APIError.http(429, _) {
            return "Too many attempts. Please wait a minute and try again."
        } catch {
            return "Couldn't delete your account. Please try again."
        }
    }
}
