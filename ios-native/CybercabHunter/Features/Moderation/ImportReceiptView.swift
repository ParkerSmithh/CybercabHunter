import SwiftUI
import UniformTypeIdentifiers

/// Moderation → Import Receipt (the website's /moderation/import-receipt).
/// Pushed from the Moderation header. The server checks the role on every
/// request; GET /api/moderation/access only picks which state to show.
struct ImportReceiptView: View {
    enum Access: Equatable { case loading, ready, signedOut, forbidden, failed }

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = ImportReceiptModel()
    @State private var access: Access = .loading
    @State private var picking = false
    @State private var searchTask: Task<Void, Never>?

    private static let types: [UTType] = [UTType(filenameExtension: "eml") ?? .emailMessage, .emailMessage, .plainText]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch model.accessLost.map(mapped) ?? access {
                case .loading: PanelSkeleton(height: 220)
                case .signedOut: EmptyStateCard(title: "Sign in required", text: "This page requires a moderator account.")
                case .forbidden: EmptyStateCard(title: "Not authorized", text: "Your account doesn't have moderator access.").accessibilityIdentifier("importForbidden")
                case .failed:
                    VStack(spacing: 10) {
                        EmptyStateCard(title: "Couldn't check access", text: "Something went wrong reaching the server.")
                        Button("Try again") { Task { await checkAccess() } }.buttonStyle(GoldButtonStyle(small: true))
                    }
                case .ready: form
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .appBackground()
        .navigationTitle("Import Receipt")
        .navigationBarTitleDisplayMode(.inline)
        .task { await checkAccess() }
        .fileImporter(isPresented: $picking, allowedContentTypes: Self.types, allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url) { model.addFile(name: url.lastPathComponent, data: data) }
            }
        }
    }

    private func mapped(_ a: ModerationModel.Access) -> Access { a == .signedOut ? .signedOut : .forbidden }

    private func checkAccess() async {
        struct ModAccess: Decodable, Sendable { let moderator: Bool? }
        access = .loading
        do {
            let r: ModAccess = try await session.api.get("/api/moderation/access", authenticated: true, fresh: true)
            access = r.moderator == true ? .ready : .forbidden
        } catch APIError.unauthorized { access = .signedOut } catch is CancellationError {} catch { access = .failed }
    }

    // MARK: The form

    private var form: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 16) {
            Eyebrow(text: "Moderation")
            Text("Adds a Tesla Robotaxi ride to the chosen rider's Rider Data through the normal receipt pipeline. A plate the registry hasn't seen becomes a private registry vehicle. Nothing is made public here: to publish it, verify the vehicle, enter its VIN and approve it in Registry Vehicles.")
                .font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 18) {
                riderPicker
                VStack(alignment: .leading, spacing: 8) {
                    Text("Receipt files").font(.inter(13, .medium)).foregroundStyle(Color.chMist)
                    Button { picking = true } label: { Label("Choose files", systemImage: "doc.badge.plus") }
                        .modifier(OutlineButton(color: Color.chInk)).buttonStyle(.plain)
                        .accessibilityIdentifier("importChooseFiles")
                    ForEach(model.files) { f in
                        HStack {
                            Image(systemName: "doc.text").foregroundStyle(Color.chFog)
                            Text(f.name).font(.inter(13)).foregroundStyle(Color.chInk).lineLimit(1)
                            Spacer()
                            Button { model.removeFile(f) } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).foregroundStyle(Color.chFog).accessibilityLabel("Remove \(f.name)")
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        bullet(".eml: the Tesla receipt email saved as a file (in Gmail: open the email, ⋮ → Download message). Best: the sender and headers help confirm it.")
                        bullet(".txt: the receipt email's text copied into a plain-text file.")
                        bullet("Up to 25 files, about 2 MB each. PDFs and screenshots aren't supported.")
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    (Text("Or paste the receipt text ") + Text("(optional)").foregroundColor(Color.chCaption)).font(.inter(13, .medium)).foregroundStyle(Color.chMist)
                    TextField("Paste the full text of the Tesla receipt email", text: $model.pasted, axis: .vertical)
                        .lineLimit(5...10)
                        .font(.inter(13)).autocorrectionDisabled().textInputAutocapitalization(.never)
                        .padding(10).background(Color.chBackground, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.25)))
                        .accessibilityIdentifier("importText")
                }
                if !model.formError.isEmpty {
                    Text(model.formError).font(.inter(13)).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("importError")
                }
                Button(model.importing ? "Importing…" : "Import") { Task { await model.submit(api: session.api) } }
                    .buttonStyle(GoldButtonStyle())
                    .disabled(model.importing)
                    .accessibilityIdentifier("importSubmit")
            }
            .glassCard()
            if let r = model.result { results(r) }
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("•"); Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(.inter(11.5)).foregroundStyle(Color.chCaption)
    }

    private var riderPicker: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 8) {
            (Text("Rider ") + Text("(required)").foregroundColor(Color.chCaption)).font(.inter(13, .medium)).foregroundStyle(Color.chMist)
            if let rider = model.rider {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(rider.displayName).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                        Text((rider.handle.map { "@\($0) · " } ?? "") + "ID \(rider.id)").font(.inter(11.5)).foregroundStyle(Color.chCaption)
                    }
                    Spacer()
                    Button("Change") { model.clearRider() }.modifier(OutlineButton(color: Color.chInk)).buttonStyle(.plain)
                        .accessibilityIdentifier("importRiderChange")
                }
                .padding(12)
                .background(Color.brandGold.opacity(0.06), in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.5)))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("importRiderSelected")
            } else {
                TextField("Search by display name", text: $model.query)
                    .font(.inter(14)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .onChange(of: model.query) {
                        searchTask?.cancel()
                        searchTask = Task { await model.searchRiders(api: session.api) }
                    }
                    .padding(.horizontal, 10).frame(minHeight: 40)
                    .background(Color.chBackground, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.25)))
                    .accessibilityIdentifier("importRiderSearch")
                Text("The ride is added to this rider's Rider Data. Only riders with a display name can be chosen.")
                    .font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
                if !model.riderStatus.isEmpty { Text(model.riderStatus).font(.inter(12)).foregroundStyle(Color.chFog).accessibilityIdentifier("importRiderStatus") }
                ForEach(model.riders) { r in
                    Button { model.choose(r) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.displayName).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                            Text((r.handle.map { "@\($0) · " } ?? "") + "ID \(r.id)").font(.inter(11.5)).foregroundStyle(Color.chCaption)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.brandGold.opacity(0.15)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("importRiderResult")
                }
            }
        }
    }

    // MARK: Results

    private func results(_ r: ReceiptImportResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Results").displayTitle(20)
            Text(model.summary.uppercased()).font(.inter(11)).tracking(0.6).foregroundStyle(Color.chCaption).accessibilityIdentifier("importSummary")
            ForEach(r.results) { item in resultCard(item) }
        }
        .padding(.top, 8)
    }

    private func resultCard(_ r: ReceiptImportResult.Item) -> some View {
        let (text, tone) = ImportReceiptModel.outcomes[r.outcome] ?? ImportReceiptModel.outcomes["error"]!
        let color: Color = switch tone { case .good: .chOK; case .info: Color(hex: 0x5BC0EB); case .plain: .chMist; case .warn: Color(hex: 0xF5B83D); case .bad: Color(hex: 0xF08A84) }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.vehicle?.licensePlate ?? "No plate").font(.inter(18, .bold)).foregroundStyle(Color.chInk)
                    Text(model.labels.indices.contains(r.index) ? model.labels[r.index] : "Receipt \(r.index + 1)").font(.inter(11.5)).foregroundStyle(Color.chCaption)
                }
                Spacer()
                Text(text.uppercased()).font(.inter(10, .semibold)).tracking(0.5).foregroundStyle(color)
                    .multilineTextAlignment(.trailing)
                    .padding(.horizontal, 8).padding(.vertical, 4).overlay(Capsule().strokeBorder(color.opacity(0.45)))
                    .accessibilityIdentifier("importOutcome")
            }
            if let reason = r.reason, let msg = ImportReceiptModel.reasons[reason] {
                Text(msg).font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
            if let ride = r.ride {
                MetricGrid(columns: 2) {
                    Metric(label: "Ride date", value: ImportReceiptModel.date(ride.rideDate), size: 15)
                    Metric(label: "Pickup", value: ImportReceiptModel.time(ride.pickupTime), size: 15)
                    Metric(label: "Distance", value: ImportReceiptModel.distance(ride.distance, ride.distanceUnit), size: 15)
                    Metric(label: "Fare", value: ImportReceiptModel.fare(ride.fareAmountCents, ride.currency), size: 15)
                }
                if ride.reviewState == "under_review" {
                    Text("This ride is held for review, so it won't count toward public totals yet.").font(.inter(11.5)).foregroundStyle(Color(hex: 0xF5B83D))
                }
            } else if r.rideDate != nil {
                Metric(label: "Ride date", value: ImportReceiptModel.date(r.rideDate), size: 15)
            }
            if let v = r.vehicle {
                Divider().overlay(Color.brandGold.opacity(0.12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(v.created ? "New registry vehicle created." : "Matched an existing registry vehicle.").font(.inter(13)).foregroundStyle(Color.chMist)
                    Group {
                        if v.publiclyEligible { Text("This vehicle is public. The ride counts toward public totals.").foregroundStyle(Color.chOK) }
                        else if v.visibility == "public" { Text("This vehicle is public but has no counted ride yet, so it isn't shown publicly.").foregroundStyle(Color.chFog) }
                        else { Text(v.hasVin ? "Private. A VIN is on file. Review it and use Approve Cybercab to publish." : "Private. To publish it: verify it's a Cybercab, then Approve Cybercab. A VIN is optional.").foregroundStyle(Color.chFog) }
                    }
                    .font(.inter(13)).fixedSize(horizontal: false, vertical: true)
                    NavigationLink(value: RegistryPlateRoute(plate: v.licensePlate ?? "")) {
                        Text("Open in Registry Vehicles →").font(.inter(13, .semibold)).foregroundStyle(Color(hex: 0x5BC0EB))
                    }
                    .accessibilityIdentifier("importOpenRegistry")
                }
            }
        }
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("importResult")
    }
}

/// Moderation opened on Registry Vehicles with this plate searched (the
/// website's moderation?plate=… link from the import results).
struct RegistryPlateRoute: Hashable, Sendable { let plate: String }
