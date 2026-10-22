import Foundation
import Observation

/// Registry Vehicles (the website's moderation.js registry section): list by
/// scope or plate, Approve / Return to Private, Save / Clear VIN, Delete.
/// The server re-checks every rule; a 409 answers with the vehicle as it is
/// now, and the card shows those facts. Messages are the website's.
@MainActor
@Observable
final class RegistryReviewModel {
    enum Scope: String, CaseIterable, Identifiable {
        case `private`, `public`, noVin = "no_vin"
        var id: String { rawValue }
        var title: String { switch self { case .private: "Private"; case .public: "Public"; case .noVin: "No VIN" } }
    }
    enum State: Equatable { case idle, loading, ready, failed }

    var scope: Scope = .private
    var plate = ""
    private(set) var state: State = .idle
    private(set) var vehicles: [ModVehicle] = []
    /// Vehicles with a request in flight (their buttons wait).
    private(set) var busy: Set<String> = []
    var toast: SocialFeedModel.Toast?
    /// Set when the server says the session ended or isn't a moderator's.
    private(set) var accessLost: ModerationModel.Access?

    var emptyText: String { scope == .noVin ? "No vehicles without VINs found." : "No registry vehicles match." }

    func load(api: APIClient) async {
        state = .loading
        let p = plate.trimmingCharacters(in: .whitespaces)
        var query: [URLQueryItem] = []
        if !p.isEmpty { query.append(URLQueryItem(name: "plate", value: String(p.prefix(40)))) }
        // A plate search ignores the scope, except No VIN (the site's rule).
        if p.isEmpty || scope == .noVin { query.append(URLQueryItem(name: "scope", value: scope.rawValue)) }
        do {
            let r: ModVehicleList = try await api.get("/api/moderation/robotaxi-vehicles", query: query, authenticated: true, fresh: true)
            vehicles = r.vehicles
            state = .ready
        } catch is CancellationError {
        } catch {
            if !lostAccess(error) { state = .failed }
        }
    }

    /// A new scope clears the plate search (as on the website).
    func setScope(_ s: Scope, api: APIClient) async {
        scope = s
        plate = ""
        await load(api: api)
    }

    private func lostAccess(_ error: Error) -> Bool {
        switch error {
        case APIError.unauthorized: accessLost = .signedOut; return true
        case APIError.http(403, _): accessLost = .forbidden; return true
        default: return false
        }
    }

    private func replace(_ fresh: ModVehicle) {
        vehicles = vehicles.map { $0.id == fresh.id ? fresh : $0 }
        if scope == .noVin && fresh.hasVin { vehicles.removeAll { $0.id == fresh.id } }
    }

    private func gone(_ id: String) {
        vehicles.removeAll { $0.id == id }
        toast = .init(text: "That vehicle no longer exists. Removed from the list.")
    }

    // MARK: Review (POST …/review): approve_cybercab, approve_manual, return_private, verify_vin

    /// Approve: with a VIN on file approve_cybercab (VIN verified), otherwise approve_manual.
    func approve(_ v: ModVehicle, api: APIClient) async {
        await review(v.id, action: v.hasVin ? "approve_cybercab" : "approve_manual", api: api)
    }

    func returnToPrivate(_ v: ModVehicle, api: APIClient) async {
        await review(v.id, action: "return_private", api: api)
    }

    func review(_ id: String, action: String, api: APIClient, alreadyBusy: Bool = false) async {
        guard alreadyBusy || !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let outcome: WriteOutcome<ModVehicleUpdated, ModVehicleConflict> = try await api.sendOrConflict(
                "/api/moderation/robotaxi-vehicles/\(id)/review", method: "POST", body: JSONBody.make(["action": action]))
            switch outcome {
            case .conflict(let c):
                // Someone else changed it, or its rides changed: show the current facts.
                if let v = c.vehicle { replace(v) }
                if c.error == "not_eligible" {
                    let why = (c.blockingReasons ?? []).map { ModVehicle.label(ModVehicle.reasonLabels, $0) }.joined(separator: ", ")
                    toast = .init(text: "Not approved. Not eligible\(why.isEmpty ? "" : ": " + why).", isError: true)
                } else if action == "verify_vin" {
                    toast = .init(text: c.error == "already_vin_verified" ? "That vehicle is already VIN verified."
                                  : c.error == "no_vin" ? "Save a VIN first." : "Only a public vehicle can be marked VIN verified.")
                } else {
                    toast = .init(text: c.error == "already_public" ? "That vehicle is already public." : "That vehicle is already private.")
                }
            case .done(let r):
                let v = r.vehicle
                toast = .init(text: action == "verify_vin" ? "VIN saved. Vehicle is now VIN verified."
                              : action == "return_private" ? "Vehicle returned to private."
                              : v.approvalBasis == "vin-verified" ? "Vehicle approved for the public registry (VIN verified)."
                              : "Vehicle approved for the public registry (manual, no VIN).")
                // Its visibility changed, so it may no longer belong in this scope.
                let searching = !plate.trimmingCharacters(in: .whitespaces).isEmpty
                if !searching && scope != .noVin && v.visibility != scope.rawValue { vehicles.removeAll { $0.id == v.id } } else { replace(v) }
            }
        } catch APIError.http(404, _) {
            gone(id)
        } catch APIError.transport {
            toast = .init(text: "Couldn't reach the server. Please try again.", isError: true)
        } catch is CancellationError {
        } catch {
            if !lostAccess(error) { toast = .init(text: "Couldn't record that review. Please try again.", isError: true) }
        }
    }

    // MARK: VIN (POST …/vin): save, edit or clear; never approves by itself

    func setVin(_ v: ModVehicle, raw: String, api: APIClient) async {
        let vin = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if vin.isEmpty && !v.hasVin { toast = .init(text: "Enter a VIN first.", isError: true); return }
        guard !busy.contains(v.id) else { return }
        busy.insert(v.id)
        defer { busy.remove(v.id) }
        do {
            let r: ModVehicleUpdated = try await api.send("/api/moderation/robotaxi-vehicles/\(v.id)/vin", method: "POST",
                                                        body: JSONBody.make(["vin": vin.isEmpty ? NSNull() : vin]))
            replace(r.vehicle)
            // A public Manual vehicle: saving its VIN marks it VIN verified in the same tap (the site's rule).
            if r.vehicle.hasVin && r.vehicle.canVerifyVin == true {
                await review(v.id, action: "verify_vin", api: api, alreadyBusy: true)
                return
            }
            toast = .init(text: r.vehicle.hasVin ? "VIN saved." : "VIN cleared.")
        } catch APIError.http(404, _) {
            gone(v.id)
        } catch APIError.http(400, "invalid_vin"?) {
            toast = .init(text: "That doesn't look like a valid VIN. Check it and try again.", isError: true)
        } catch APIError.transport {
            toast = .init(text: "Couldn't reach the server. Please try again.", isError: true)
        } catch is CancellationError {
        } catch {
            if !lostAccess(error) { toast = .init(text: "Couldn't save that VIN. Please try again.", isError: true) }
        }
    }

    // MARK: Delete (DELETE …/:id): the vehicle and every ride/receipt logged against it

    func delete(_ v: ModVehicle, api: APIClient) async {
        guard !busy.contains(v.id) else { return }
        busy.insert(v.id)
        defer { busy.remove(v.id) }
        do {
            let _: SocialOK = try await api.send("/api/moderation/robotaxi-vehicles/\(v.id)", method: "DELETE")
            vehicles.removeAll { $0.id == v.id }
            toast = .init(text: "Vehicle and its ride history removed. The receipt can be resent.")
        } catch APIError.http(404, _) {
            gone(v.id)
        } catch APIError.transport {
            toast = .init(text: "Couldn't reach the server. Please try again.", isError: true)
        } catch is CancellationError {
        } catch {
            if !lostAccess(error) { toast = .init(text: "Couldn't delete that vehicle. Please try again.", isError: true) }
        }
    }
}
