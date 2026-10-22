import Foundation
import Observation

/// Moderation (the website's moderation.html: js/moderation.js and
/// moderation-social.js). The app decides nothing: every request is
/// authorized by the Worker (requireModerator); a 401 or 403 here switches
/// the screen to "signed out" / "not a moderator". No XP is involved.
@MainActor
@Observable
final class ModerationModel {
    enum Access: Equatable { case loading, ok, signedOut, forbidden, failed(String) }

    private(set) var access: Access = .loading
    private(set) var queue: [ModerationQueue.Sighting] = []
    private(set) var approved: [ApprovedImages.Image] = []
    private(set) var overview: SocialModerationOverview?
    private(set) var reports: [SocialReports.Item]?
    private(set) var announcement: SocialSidebar.Announcement?
    private(set) var cameras: [TrafficCamera] = []
    /// Items with a request in flight (a second tap waits).
    private(set) var busy: Set<String> = []
    var toast: SocialFeedModel.Toast?

    var withPhoto: [ModerationQueue.Sighting] { queue.filter(\.hasPhoto) }
    var withoutPhoto: [ModerationQueue.Sighting] { queue.filter { !$0.hasPhoto } }

    // MARK: Loading

    func load(api: APIClient) async {
        do {
            let q: ModerationQueue = try await api.get("/api/moderation/vehicle-sightings", authenticated: true)
            queue = q.sightings
            access = .ok
        } catch {
            handle(error, fallback: "The server had a problem. Try again in a moment.")
            return
        }
        async let a: Void = loadApproved(api: api)
        async let s: Void = loadSocial(api: api)
        async let c: [TrafficCamera]? = try? api.get("/data/traffic-cameras.json")
        _ = await (a, s)
        cameras = await c ?? cameras
    }

    func loadApproved(api: APIClient) async {
        if let r: ApprovedImages = try? await api.get("/api/moderation/approved-photo-sightings", authenticated: true) { approved = r.sightings }
    }

    func loadSocial(api: APIClient) async {
        async let o: SocialModerationOverview? = try? api.get("/api/moderation/social/overview", authenticated: true)
        async let r: SocialReports? = try? api.get("/api/moderation/social/reports", authenticated: true)
        async let s: SocialSidebar? = try? api.get("/api/social/sidebar")
        let (ov, rep, side) = await (o, r, s)
        overview = ov ?? overview
        reports = rep?.reports ?? reports
        announcement = side?.announcement
    }

    private func handle(_ error: Error, fallback: String) {
        switch error {
        case APIError.unauthorized: access = .signedOut
        case APIError.http(403, _): access = .forbidden
        case is CancellationError: break
        default: if access != .ok { access = .failed(fallback) } else { toast = .init(text: fallback, isError: true) }
        }
    }

    private func run(_ id: String, _ body: () async throws -> Void) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        do { try await body() } catch { handleAction(error, id: id) }
    }

    private func handleAction(_ error: Error, id: String) {
        switch error {
        case APIError.http(409, "already_reviewed"?):
            queue.removeAll { $0.submissionId == id }
            toast = .init(text: "That sighting was already reviewed. Removed from the queue.")
        case APIError.http(409, "vehicle_exists"?):
            toast = .init(text: "A registry vehicle with that plate already exists. Approve the sighting instead.", isError: true)
        case APIError.http(400, "plate_required"?):
            toast = .init(text: "This sighting has no usable plate, so it cannot become a vehicle.", isError: true)
        case APIError.http(400, "rejection_reason_required"?):
            toast = .init(text: "A rejection reason is required.", isError: true)
        case APIError.unauthorized, APIError.http(403, _):
            handle(error, fallback: "")
        default:
            toast = .init(text: "Couldn't submit the review. Please try again.", isError: true)
        }
    }

    // MARK: Sightings (PATCH / promote / photo)

    func approve(_ s: ModerationQueue.Sighting, api: APIClient) async {
        await run(s.submissionId) {
            let r: ReviewResult = try await api.send("/api/moderation/vehicle-sightings/\(s.submissionId)", method: "PATCH", body: JSONBody.make(["action": "approve"]))
            queue.removeAll { $0.submissionId == s.submissionId }
            toast = .init(text: r.message("Sighting approved"))
            await loadApproved(api: api)
        }
    }

    func reject(_ s: ModerationQueue.Sighting, reason: String, api: APIClient) async {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { toast = .init(text: "A rejection reason is required.", isError: true); return }
        await run(s.submissionId) {
            let _: ReviewResult = try await api.send("/api/moderation/vehicle-sightings/\(s.submissionId)", method: "PATCH",
                                                     body: JSONBody.make(["action": "reject", "rejection_reason": String(trimmed.prefix(280))]))
            queue.removeAll { $0.submissionId == s.submissionId }
            toast = .init(text: "Sighting rejected.")
        }
    }

    func promote(_ s: ModerationQueue.Sighting, api: APIClient) async {
        await run(s.submissionId) {
            let r: ReviewResult = try await api.send("/api/moderation/vehicle-sightings/\(s.submissionId)/promote", method: "POST")
            queue.removeAll { $0.submissionId == s.submissionId }
            toast = .init(text: r.message("Added to the registry as a private vehicle. Find it under Registry Vehicles"))
            await loadApproved(api: api)
        }
    }

    /// Deletes a sighting's photo permanently (a pending one is closed as rejected).
    func deletePhoto(submissionId: String, api: APIClient) async {
        await run(submissionId) {
            let _: SocialOK = try await api.send("/api/moderation/vehicle-sightings/\(submissionId)/photo", method: "DELETE")
            queue.removeAll { $0.submissionId == submissionId }
            approved.removeAll { $0.submissionId == submissionId }
            toast = .init(text: "Photo deleted.")
        }
    }

    func addToMap(_ a: ApprovedImages.Image, cameraId: String, api: APIClient) async {
        await run(a.submissionId) {
            do {
                let r: MapAdded = try await api.send("/api/moderation/vehicle-sightings/\(a.submissionId)/map", method: "POST", body: JSONBody.make(["camera_id": cameraId]))
                toast = .init(text: r.visibleOnMap == false ? "Recorded, but this capture is over 24 hours old, so it won't show on the Zones map."
                                                            : (r.alreadyOnMap == true ? "Already on the Zones map." : "Added to the Zones map ✓"))
                await loadApproved(api: api)
            } catch APIError.http(_, let code) where code == "photo_missing" || code == "not_found" {
                toast = .init(text: "This photo is no longer stored, so it can't go on the map.", isError: true)
            } catch APIError.http(400, _) {
                toast = .init(text: "Couldn't add it to the map. Please try again.", isError: true)
            }
        }
    }

    func cameras(for a: ApprovedImages.Image) -> [TrafficCamera] {
        cameras.filter { $0.cityKey == a.cityKey }.sorted { ($0.name, $0.cameraId) < ($1.name, $1.cameraId) }
    }

    // MARK: Social

    func resolve(_ r: SocialReports.Item, remove: Bool, note: String, api: APIClient) async {
        await run(r.id) {
            var body: [String: Any] = ["target_type": r.targetType, "target_id": r.targetId, "action": remove ? "remove" : "dismiss"]
            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { body["reason"] = String(trimmed.prefix(200)) }
            let _: ResolveResult = try await api.send("/api/moderation/social/resolve", method: "POST", body: JSONBody.make(body))
            reports?.removeAll { $0.id == r.id }
            toast = .init(text: remove ? "Removed." : "Dismissed.")
            await loadSocial(api: api)
        }
    }

    func unpin(_ id: String, api: APIClient) async {
        await run(id) {
            let _: SocialOK = try await api.send("/api/social/posts/\(id)/pin", method: "DELETE")
            await loadSocial(api: api)
        }
    }

    /// Publishes the announcement; returns the website's status line.
    func publishAnnouncement(body: String, link: String, notify: Bool, api: APIClient) async -> String {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "Write the announcement first." }
        do {
            var json: [String: Any] = ["body": text, "notify": notify]
            let l = link.trimmingCharacters(in: .whitespaces)
            json["link_url"] = l.isEmpty ? NSNull() : l
            let _: SocialOK = try await api.send("/api/moderation/social/announcement", method: "PUT", body: JSONBody.make(json))
            await loadSocial(api: api)
            return "Published. It can take up to 2 minutes to show everywhere."
        } catch APIError.http(400, "invalid_link"?) {
            return "That link doesn't look right."
        } catch { return "Couldn't publish. Try again." }
    }

    func clearAnnouncement(api: APIClient) async -> String {
        do {
            let _: SocialOK = try await api.send("/api/moderation/social/announcement", method: "DELETE")
            await loadSocial(api: api)
            return "Cleared."
        } catch { return "Couldn't clear. Try again." }
    }

    static let reasonNames = ["spam": "Spam", "harassment": "Harassment", "off_topic": "Off-topic", "misleading": "Misleading information", "privacy": "Privacy concern", "other": "Other"]
}
