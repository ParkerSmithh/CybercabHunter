import SwiftUI

/// Registry Vehicles, under the sighting queue on the Vehicles tab (the
/// website's #modVehicles): scope or plate search, then one card per vehicle
/// with the server's facts, the review actions and the VIN panel.
struct RegistryVehiclesSection: View {
    let model: RegistryReviewModel
    @Environment(SessionStore.self) private var session
    @State private var vinDrafts: [String: String] = [:]
    /// Vehicles whose inline delete confirmation is open.
    @State private var confirmingDelete: Set<String> = []
    @FocusState private var plateFocused: Bool

    private static let trackerURL = URL(string: "https://robotaxitracker.com/vehicles")!

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            Text("REGISTRY VEHICLES").displayTitle(20).padding(.top, 18).accessibilityIdentifier("registryVehiclesTitle")
            Text("Receipts create vehicles internally, but nothing confirms who actually issued a receipt, so a new vehicle stays private until you make it public. Public visibility alone is not enough: a vehicle also needs at least one counted ride before it appears on the public site.")
                .font(.inter(12)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            note("Provenance describes how data entered Cybercab Hunter. It does not prove that a receipt was genuinely issued by Tesla.")
            note("Approving a vehicle means a Cybercab Hunter moderator reviewed this registry record and intentionally approved it for public visibility. Each approval or return to private is recorded in the vehicle's review history.")
            HStack(spacing: 8) {
                Menu {
                    ForEach(RegistryReviewModel.Scope.allCases) { s in
                        Button(s.title) { Task { await model.setScope(s, api: session.api) } }
                    }
                } label: {
                    HStack(spacing: 4) { Text(model.scope.title); Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)) }
                        .font(.inter(13, .semibold)).foregroundStyle(Color.chInk)
                        .padding(.horizontal, 12).frame(minHeight: 40)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.3)))
                }
                .accessibilityIdentifier("registryScope")
                .accessibilityLabel("Which vehicles to list: \(model.scope.title)")
                TextField("Or search by plate", text: $model.plate)
                    .font(.inter(14)).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .focused($plateFocused)
                    .submitLabel(.search)
                    .onSubmit { Task { await model.load(api: session.api) } }
                    .onChange(of: model.plate) { if model.plate.count > 40 { model.plate = String(model.plate.prefix(40)) } }
                    .padding(.horizontal, 10).frame(minHeight: 40)
                    .background(Color.chBackground, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.25)))
                    .accessibilityIdentifier("registryPlate")
                Button("Search") { plateFocused = false; Task { await model.load(api: session.api) } }
                    .font(.inter(12.5, .semibold)).foregroundStyle(Color.chInk)
                    .padding(.horizontal, 12).frame(minHeight: 40)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.35)))
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("registrySearch")
            }
            switch model.state {
            case .idle, .loading:
                PanelSkeleton(height: 96)
            case .failed:
                HStack {
                    Text("Couldn't load registry vehicles.").font(.inter(13)).foregroundStyle(Color.chFog)
                    Button("Try again") { Task { await model.load(api: session.api) } }.font(.inter(13, .semibold))
                }
                .glassCard()
                .accessibilityIdentifier("registryError")
            case .ready:
                if model.vehicles.isEmpty {
                    Text(model.emptyText).font(.inter(13)).foregroundStyle(Color.chFog).frame(maxWidth: .infinity).glassCard()
                        .accessibilityIdentifier("registryEmpty")
                }
                ForEach(model.vehicles) { v in card(v) }
            }
        }
        .task { if model.state == .idle { await model.load(api: session.api) } }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            .padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(Color.brandGold.opacity(0.35)).frame(width: 2) }
    }

    // MARK: A vehicle card (moderation.js vehicleCard)

    private func card(_ v: ModVehicle) -> some View {
        let view = v.stateView
        let busy = model.busy.contains(v.id)
        let deleting = confirmingDelete.contains(v.id)
        let ap = v.approval
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(v.licensePlate ?? "Plate unknown").font(.inter(19, .bold)).foregroundStyle(Color.chInk)
                    Text(Format.plural(v.countedRideCount, "counted ride", "counted rides")).font(.inter(11.5)).foregroundStyle(Color.chCaption)
                }
                Spacer()
                Text(view.badge.uppercased()).font(.inter(10.5, .semibold)).tracking(0.5).foregroundStyle(Color.chMist)
                    .padding(.horizontal, 8).padding(.vertical, 4).overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.3)))
                    .accessibilityIdentifier("registryBadge")
            }
            Text(view.line).font(.inter(13.5, .semibold))
                .foregroundStyle(view.tone == .good ? Color.chOK : view.tone == .info ? Color(hex: 0x5BC0EB) : Color(hex: 0xF5B83D))
                .accessibilityIdentifier("registryStateLine")
            if let reasons = ap?.blockingReasons, !reasons.isEmpty {
                Text(reasons.map { ModVehicle.label(ModVehicle.reasonLabels, $0) }.joined(separator: " · "))
                    .font(.inter(12)).foregroundStyle(Color(hex: 0xF5B83D))
            }
            if let notes = ap?.notes, !notes.isEmpty {
                FlowTags(tags: notes.map { ModVehicle.label(ModVehicle.noteLabels, $0) })
            }
            small("Rides attached: \(v.countedRideCount) counted · \(v.needsReviewRideCount ?? 0) needs review · \(v.rejectedRideCount ?? 0) rejected · \(v.totalTripCount ?? 0) total trips on record")
            provenance(v)
            small("Vehicle record created \(Format.dateTime(Format.instant(v.createdAt))) · First seen \(Format.dateTime(Format.instant(v.firstSeenAt))) · Last \(v.fromSighting ? "sighting" : "receipt") activity \(Format.dateTime(Format.instant(v.lastSeenAt)))", dim: true)
            small("Record field verification_status: \(v.verificationStatus ?? "—")", dim: true)
            if let r = v.latestReview {
                small("Last review: \(r.action == "approved_public" ? "Approved for public" : "Returned to private") by \(r.moderatorDisplayName ?? "a moderator") · \(Format.dateTime(Format.instant(r.createdAt)))")
                    .accessibilityIdentifier("registryLastReview")
            } else {
                small("No moderator review recorded for this vehicle yet.", dim: true)
            }
            if (v.plateVehicleCount ?? 1) > 1 {
                Text("Duplicate plate: \(v.plateVehicleCount ?? 0) registry vehicles share this plate, so it cannot be approved and its sightings are not matched publicly.")
                    .font(.inter(12)).foregroundStyle(Color(hex: 0xF5B83D)).fixedSize(horizontal: false, vertical: true)
            }
            Divider().overlay(Color.brandGold.opacity(0.12)).padding(.vertical, 4)
            if deleting {
                deletePanel(v, busy: busy)
            } else {
                HStack(spacing: 8) {
                    if v.isPublic {
                        Button(busy ? "Working…" : "Return to Private") { Task { await model.returnToPrivate(v, api: session.api) } }
                            .modifier(OutlineButton(color: Color(hex: 0xF08A84)))
                            .accessibilityIdentifier("registryReturnPrivate")
                    }
                    Button("Delete Vehicle") { confirmingDelete.insert(v.id) }
                        .modifier(OutlineButton(color: Color.chFog))
                        .accessibilityIdentifier("registryAskDelete")
                    if v.publiclyEligible {
                        NavigationLink(value: VehicleRoute(id: v.id, plate: v.licensePlate)) {
                            Text("View public page →").font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0x5BC0EB))
                        }
                        .accessibilityIdentifier("registryPublicPage")
                    }
                }
                .buttonStyle(.plain)
                .disabled(busy)
                verification(v, busy: busy)
            }
        }
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("registryCard-\(v.licensePlate ?? v.id)")
    }

    private func small(_ text: String, dim: Bool = false) -> some View {
        Text(text).font(.inter(11.5)).foregroundStyle(dim ? Color.chCaption : Color.chFog).fixedSize(horizontal: false, vertical: true)
    }

    /// How the counted rides entered, and how the vehicle was added. Descriptive only.
    @ViewBuilder private func provenance(_ v: ModVehicle) -> some View {
        if v.countedRideCount > 0 {
            let src = v.countedRidesBySource
            VStack(alignment: .leading, spacing: 2) {
                Text("How the counted rides entered").font(.inter(11.5, .semibold)).foregroundStyle(Color.chMist)
                small("Forwarded email: \(src?.receiptEmail ?? 0) · Import (pasted text or .eml file): \(src?.receiptImport ?? 0) · Other: \(src?.other ?? 0)")
                small("First counted ride: \(Format.day(v.firstCountedRideDate)) · Latest counted ride: \(Format.day(v.lastCountedRideDate))")
            }
        }
        if v.fromSighting {
            VStack(alignment: .leading, spacing: 2) {
                Text("How this vehicle was added").font(.inter(11.5, .semibold)).foregroundStyle(Color.chMist)
                small("From a community sighting, added to the registry without a receipt." + (v.countedRideCount > 0 ? "" : " It has no receipt and no rides; your approval stands in for a counted ride (a VIN is optional)."))
            }
        }
        if v.countedRideCount == 0 && !v.fromSighting {
            small("No counted rides yet, so there is no ride provenance to show.", dim: true)
        }
    }

    private func deletePanel(_ v: ModVehicle, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            (Text("Permanently delete ") + Text(v.licensePlate ?? "this vehicle").bold().foregroundColor(Color.chInk)
             + Text(" from the registry? This cannot be undone. It disappears from the public site immediately, and the ride(s)/receipt(s) logged against it are deleted too."))
                .font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(busy ? "Working…" : "Confirm Delete") {
                    Task { await model.delete(v, api: session.api); confirmingDelete.remove(v.id) }
                }
                .modifier(OutlineButton(color: Color(hex: 0xF08A84)))
                .accessibilityIdentifier("registryConfirmDelete")
                Button("Cancel") { confirmingDelete.remove(v.id) }
                    .modifier(OutlineButton(color: Color.chFog))
                    .accessibilityIdentifier("registryCancelDelete")
            }
            .buttonStyle(.plain)
            .disabled(busy)
        }
    }

    // MARK: Cybercab verification (moderation.js cybercabPanel)

    private func verification(_ v: ModVehicle, busy: Bool) -> some View {
        let draft = Binding(get: { vinDrafts[v.id] ?? v.vin ?? "" }, set: { vinDrafts[v.id] = String($0.uppercased().prefix(17)) })
        return VStack(alignment: .leading, spacing: 8) {
            Text("CYBERCAB VERIFICATION").font(.inter(11, .semibold)).tracking(0.8).foregroundStyle(Color.chMist)
            Link("Check Robotaxi Tracker →", destination: Self.trackerURL).font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0x5BC0EB))
            small("Look up \(v.licensePlate ?? "this plate") there. If it's shown as a Cybercab, copy its VIN and enter it below. The VIN is optional: you can approve without one and add it later. If it's shown as a Model Y (or anything else), use Delete Vehicle instead. There is no separate rejection step.", dim: true)
            if let vin = v.vin, !vin.isEmpty {
                (Text("VIN on file: ") + Text(vin).font(.system(size: 12, design: .monospaced))).font(.inter(12)).foregroundStyle(Color.chMist)
                    .accessibilityIdentifier("registryVinOnFile")
            } else {
                small("No VIN on file (optional).")
            }
            HStack(spacing: 8) {
                TextField("17-character VIN", text: draft)
                    .font(.system(size: 13, design: .monospaced)).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .padding(.horizontal, 10).frame(minHeight: 38)
                    .background(Color.black.opacity(0.3), in: .rect(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.brandGold.opacity(0.25)))
                    .accessibilityIdentifier("registryVinField")
                Button(busy ? "Working…" : "Save VIN") {
                    let raw = draft.wrappedValue
                    Task { await model.setVin(v, raw: raw, api: session.api); vinDrafts[v.id] = nil }
                }
                .modifier(OutlineButton(color: Color.chInk))
                .accessibilityIdentifier("registrySaveVin")
                if v.hasVin {
                    Button("Clear VIN") { Task { await model.setVin(v, raw: "", api: session.api); vinDrafts[v.id] = nil } }
                        .modifier(OutlineButton(color: Color.chFog))
                        .accessibilityIdentifier("registryClearVin")
                }
            }
            .buttonStyle(.plain)
            .disabled(busy)
            if v.isPublic {
                (Text("Approval basis: ") + Text(v.approvalBasis.map { ModVehicle.label(ModVehicle.basisLabels, $0) } ?? "Not recorded").bold())
                    .font(.inter(12)).foregroundStyle(Color.chMist)
                    .accessibilityIdentifier("registryBasis")
                if v.approvalBasis != "vin-verified" {
                    small("Save VIN marks it VIN verified (public badge). Only save a VIN Robotaxi Tracker shows for this Cybercab.", dim: true)
                }
            } else {
                Button(busy ? "Working…" : "Approve Cybercab") { Task { await model.approve(v, api: session.api) } }
                    .buttonStyle(GoldButtonStyle(small: true))
                    .disabled(busy || !v.canApprove)
                    .accessibilityIdentifier("registryApprove")
                small(v.hasVin ? "Approves it as VIN verified (public VIN verified badge)." : "No VIN: approves it as Manual, with no VIN verified badge. You can add a VIN and verify it later.", dim: true)
            }
        }
        .padding(.top, 4)
    }
}

/// An outlined small action button (the website's bordered moderation buttons).
struct OutlineButton: ViewModifier {
    let color: Color
    @Environment(\.isEnabled) private var enabled
    func body(content: Content) -> some View {
        content
            .font(.inter(12.5, .bold)).foregroundStyle(color)
            .padding(.horizontal, 12).frame(minHeight: 36)
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(color.opacity(0.45)))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.5)
    }
}

/// Small rounded tags that wrap (approval notes).
struct FlowTags: View {
    let tags: [String]
    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(tags, id: \.self) { t in
                Text(t).font(.inter(11.5)).foregroundStyle(Color.chMist)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.white.opacity(0.06), in: .capsule)
            }
        }
    }
}

/// Wraps its children onto new lines as needed.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
