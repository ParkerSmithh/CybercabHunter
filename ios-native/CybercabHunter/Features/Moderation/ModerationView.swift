import SwiftUI

/// Moderation for moderators (reached from Account): the website's
/// moderation page, natively. Vehicles (sightings without a photo, then
/// Registry Vehicles), Images, News, Social and Gmail Link, plus Import
/// Receipt from the header. Every request is authorized by the Worker.
struct ModerationView: View {
    enum Tab: String, CaseIterable, Identifiable {
        case vehicles, images, news, social, gmail
        var id: String { rawValue }
        var title: String { self == .gmail ? "GMAIL LINK" : rawValue.uppercased() }
    }

    /// Opens Registry Vehicles with this plate searched (Import Receipt's link).
    var initialPlate: String? = nil

    @Environment(SessionStore.self) private var session
    @State private var model = ModerationModel()
    @State private var registry = RegistryReviewModel()
    @State private var news = NewsModerationModel()
    @State private var gmail = GmailLinkModel()
    @State private var tab: Tab = .images
    @State private var rejecting: ModerationQueue.Sighting?
    @State private var reason = ""
    @State private var deletingPhoto: String?
    @State private var mapping: ApprovedImages.Image?
    @State private var resolving: (SocialReports.Item, Bool)?
    @State private var note = ""

    /// A section that lost access (session ended, or no longer a moderator) switches the whole screen.
    private var access: ModerationModel.Access {
        registry.accessLost ?? news.accessLost ?? gmail.accessLost ?? model.access
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch access {
                case .loading:
                    PanelSkeleton(height: 220)
                case .signedOut:
                    EmptyStateCard(title: "Sign in to moderate", text: "Your session has ended. Sign in again with a moderator account.")
                case .forbidden:
                    EmptyStateCard(title: "Moderators only", text: "This account isn't a moderator.").accessibilityIdentifier("moderationForbidden")
                case .failed(let message):
                    EmptyStateCard(title: "We couldn't load the queue", text: message)
                case .ok:
                    header
                    tabs
                    switch tab {
                    case .vehicles: vehiclesTab
                    case .images: imagesTab
                    case .news: NewsModerationSection(model: news)
                    case .social: socialTab
                    case .gmail: GmailLinkSection(model: gmail)
                    }
                }
            }
            .padding(16)
        }
        .appBackground()
        .navigationTitle("Moderation")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if let initialPlate, registry.state == .idle { tab = .vehicles; registry.plate = initialPlate }
            await model.load(api: session.api)
        }
        .refreshable {
            await model.load(api: session.api)
            switch tab {
            case .vehicles: await registry.load(api: session.api)
            case .news: await news.load(api: session.api)
            case .gmail: await gmail.load(api: session.api)
            default: break
            }
        }
        .overlay(alignment: .top) { ToastHost(toast: $model.toast) }
        .overlay(alignment: .top) { ToastHost(toast: $registry.toast) }
        .alert("Reject this sighting?", isPresented: Binding(get: { rejecting != nil }, set: { if !$0 { rejecting = nil } })) {
            TextField("Why is this sighting being rejected?", text: $reason)
            Button("Confirm Reject", role: .destructive) { if let s = rejecting { Task { await model.reject(s, reason: reason, api: session.api) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("A rejection reason is required.") }
        .confirmationDialog("Delete this photo?", isPresented: Binding(get: { deletingPhoto != nil }, set: { if !$0 { deletingPhoto = nil } }), titleVisibility: .visible) {
            Button("Delete photo", role: .destructive) { if let id = deletingPhoto { Task { await model.deletePhoto(submissionId: id, api: session.api) } } }
        } message: { Text("It is removed permanently and can't be undone.") }
        .alert(resolving.map { $0.1 ? "Remove this \($0.0.targetType) for everyone?" : "Dismiss these reports?" } ?? "", isPresented: Binding(get: { resolving != nil }, set: { if !$0 { resolving = nil } })) {
            TextField("Optional note for the log", text: $note)
            Button(resolving?.1 == true ? "Remove" : "Dismiss", role: resolving?.1 == true ? .destructive : nil) {
                if let res = resolving { Task { await model.resolve(res.0, remove: res.1, note: note, api: session.api) } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $mapping) { a in
            CameraPickerSheet(cameras: model.cameras(for: a), current: a.cameraId) { id in
                mapping = nil
                Task { await model.addToMap(a, cameraId: id, api: session.api) }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Eyebrow(text: "Review Queue")
                Text("VEHICLE SIGHTINGS").displayTitle(22)
            }
            Spacer()
            NavigationLink(value: AccountRoute.importReceipt) {
                Text("Import Receipt").font(.inter(12.5, .semibold)).foregroundStyle(Color.chInk)
                    .padding(.horizontal, 12).frame(minHeight: 38)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.35)))
            }
            .accessibilityIdentifier("modImportReceipt")
        }
    }

    private var tabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Tab.allCases) { t in
                    let count = switch t {
                    case .vehicles: model.withoutPhoto.count
                    case .images: model.withPhoto.count
                    case .social: model.overview?.stats.openReportItems ?? 0
                    default: 0
                    }
                    PillToggle(title: count > 0 ? "\(t.title) \(count)" : t.title, selected: tab == t, compact: true) { tab = t }
                        .accessibilityIdentifier("modTab-\(t.rawValue)")
                }
            }
        }
    }

    // MARK: Vehicles: sightings without a photo, then Registry Vehicles

    @ViewBuilder private var vehiclesTab: some View {
        Eyebrow(text: "Sightings · pending review")
        if model.withoutPhoto.isEmpty { InlineMessage(text: "No vehicle sightings waiting for review.") }
        ForEach(model.withoutPhoto) { s in queueCard(s) }
        RegistryVehiclesSection(model: registry)
    }

    // MARK: Images: photo sightings, then recently approved

    @ViewBuilder private var imagesTab: some View {
        Eyebrow(text: "Images · pending review")
        if model.withPhoto.isEmpty { InlineMessage(text: "No images waiting for review.").accessibilityIdentifier("imagesEmpty") }
        ForEach(model.withPhoto) { s in queueCard(s) }
        if !model.approved.isEmpty {
            Eyebrow(text: "Recently approved images").padding(.top, 10)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(model.approved) { a in approvedCard(a) }
            }
        }
    }

    private func queueCard(_ s: ModerationQueue.Sighting) -> some View {
        let isBusy = model.busy.contains(s.submissionId)
        return VStack(alignment: .leading, spacing: 10) {
            if s.hasPhoto {
                ModeratorPhoto(submissionId: s.submissionId, delete: { deletingPhoto = s.submissionId })
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.licensePlate ?? "Plate not given").font(.inter(18, .bold)).foregroundStyle(Color.chInk)
                    Text("Submitted \(Format.dateTime(Format.instant(s.submittedAt))) · Observed \(Format.dateTime(Format.instant(s.observedAt)))")
                        .font(.inter(11.5)).foregroundStyle(Color.chCaption)
                }
                Spacer()
                Text((s.serviceArea ?? "Area unknown").uppercased()).font(.inter(10.5, .semibold)).tracking(0.6).foregroundStyle(Color.chMist)
                    .padding(.horizontal, 8).padding(.vertical, 3).overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.3)))
            }
            if let vid = s.robotaxiVehicleId {
                NavigationLink(value: VehicleRoute(id: vid, plate: s.licensePlate)) {
                    Text("Linked to a registry vehicle →").font(.inter(13, .semibold)).foregroundStyle(Color(hex: 0x5BC0EB))
                }
            } else {
                Text("No matching vehicle in the registry. Plate is unrecognized").font(.inter(13)).foregroundStyle(Color.chCaption)
            }
            let details = [s.model.map { "Model: \($0)" }, s.color.map { "Color: \($0)" }, s.approxLocation.map { "Near: \($0)" }].compactMap { $0 }
            ForEach(details, id: \.self) { Text($0).font(.inter(12)).foregroundStyle(Color.chFog) }
            if let cam = s.cameraName { Text("Traffic camera: \(cam)").font(.inter(12)).foregroundStyle(Color.brandGold) }
            if let notes = s.notes {
                Text(notes).font(.inter(13)).foregroundStyle(Color.chMist).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.chInk.opacity(0.05), in: .rect(cornerRadius: 8))
            }
            HStack(spacing: 8) {
                Button(isBusy ? "Working…" : "Approve") { Task { await model.approve(s, api: session.api) } }
                    .buttonStyle(GoldButtonStyle(small: true))
                    .accessibilityIdentifier("approveSighting")
                if s.canPromote {
                    Button("Add to registry") { Task { await model.promote(s, api: session.api) } }
                        .font(.inter(12.5, .bold)).foregroundStyle(Color.brandGold)
                        .padding(.horizontal, 12).frame(minHeight: 34).overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.45)))
                }
                Button("Reject") { reason = ""; rejecting = s }
                    .font(.inter(12.5, .bold)).foregroundStyle(Color(hex: 0xF08A84))
                    .padding(.horizontal, 12).frame(minHeight: 34).overlay(Capsule().strokeBorder(Color(hex: 0xF08A84, opacity: 0.5)))
                    .accessibilityIdentifier("rejectSighting")
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
        }
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queueCard")
    }

    private func approvedCard(_ a: ApprovedImages.Image) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ModeratorPhoto(submissionId: a.submissionId, delete: { deletingPhoto = a.submissionId })
            Text(a.licensePlate ?? "Plate not given").font(.inter(13, .bold)).foregroundStyle(Color.chInk)
            Text("\(a.serviceArea ?? "Area unknown") · \(Format.dateTime(Format.instant(a.observedAt)))").font(.inter(11)).foregroundStyle(Color.chCaption)
            if let cam = a.cameraName { Text("Traffic camera: \(cam)").font(.inter(11)).foregroundStyle(Color.brandGold) }
            if a.onMap && a.visibleOnMap {
                Text("On the Zones map ✓").font(.inter(11.5, .semibold)).foregroundStyle(Color.brandGold)
            } else if a.onMap {
                Text("Off the Zones map: the map shows the last 24 hours").font(.inter(11)).foregroundStyle(Color.chFog)
            } else {
                Button("Add to map") { mapping = a }.font(.inter(12, .bold)).foregroundStyle(Color.brandGold)
                    .disabled(model.busy.contains(a.submissionId))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.chSurface, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chLine))
    }

    // MARK: Social

    @ViewBuilder private var socialTab: some View {
        if let o = model.overview {
            MetricGrid(columns: 3) {
                Metric(label: "Posts", value: Format.int(o.stats.posts))
                Metric(label: "Comments", value: Format.int(o.stats.comments))
                Metric(label: "Reported items", value: Format.int(o.stats.openReportItems), note: o.stats.openReports != o.stats.openReportItems ? "\(Format.plural(o.stats.openReports, "report", "reports")) in all" : nil)
            }
            .dataPanel()
            Footnote(text: "Posts and comments as the public sees them (removed ones are not counted).")
        }
        Eyebrow(text: "Open reports")
        if let reports = model.reports {
            if reports.isEmpty { InlineMessage(text: "No open reports.").accessibilityIdentifier("noReports") }
            ForEach(reports) { r in reportCard(r) }
        } else { ProgressView().frame(maxWidth: .infinity) }
        Eyebrow(text: "Pinned posts").padding(.top, 8)
        if let o = model.overview {
            Text(o.pinned.isEmpty ? "No pinned posts." : "\(o.pinned.count) of \(o.maxPins) pins in use.").font(.inter(12.5)).foregroundStyle(Color.chFog)
            ForEach(o.pinned) { p in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(p.author.name ?? p.author.handle.map { "@\($0)" } ?? "Rider").font(.inter(13.5, .bold)).foregroundStyle(Color.chInk)
                        Text(p.body.isEmpty ? (p.hasReview ? "Ride review" : p.hasPhotos ? "Photo post" : "") : p.body).font(.inter(13)).foregroundStyle(Color.chMist).lineLimit(3)
                        Text("Pinned \(Format.dateTime(Format.instant(p.pinnedAt)))").font(.inter(11)).foregroundStyle(Color.chCaption)
                    }
                    Spacer()
                    Button("Unpin") { Task { await model.unpin(p.id, api: session.api) } }.font(.inter(12.5, .semibold))
                        .disabled(model.busy.contains(p.id))
                }
                .glassCard(padding: 12)
            }
        }
        AnnouncementEditor(model: model)
    }

    private func reportCard(_ r: SocialReports.Item) -> some View {
        let who = r.author.flatMap { $0.name ?? $0.handle.map { "@\($0)" } } ?? "unknown"
        return VStack(alignment: .leading, spacing: 8) {
            Text("\(r.targetType == "post" ? "Post" : "Comment") by \(who)").font(.inter(14, .bold)).foregroundStyle(Color.chInk)
            Text("\(Format.plural(r.reportCount, "report", "reports")): \(r.reasons.map { ModerationModel.reasonNames[$0] ?? $0 }.joined(separator: ", "))")
                .font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0xF08A84))
            if let h = r.authorHistory {
                Text("Author history: \(Format.plural(h.removals, "earlier removal", "earlier removals")) · \(Format.plural(h.posts24h, "post", "posts")) in the last 24 hours")
                    .font(.inter(12)).foregroundStyle(h.removals > 0 ? Color.brandGold : Color.chCaption)
                    .accessibilityIdentifier("authorHistory")
            }
            if r.targetMissing {
                Text("Already deleted.").font(.inter(13).italic()).foregroundStyle(Color.chCaption)
            } else if let t = r.target {
                VStack(alignment: .leading, spacing: 4) {
                    if let body = t.body, !body.isEmpty { Text(body).font(.inter(13.5)).foregroundStyle(Color.chMist) }
                    if let review = t.review { Text("Ride review: \(review.rating)/5").font(.inter(12)).foregroundStyle(Color.chFog) }
                    if let link = t.linkUrl { Text("Link: \(link)").font(.inter(12)).foregroundStyle(Color.chFog) }
                    if let photos = t.photos, !photos.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack { ForEach(photos) { p in RemoteImage(url: p.fullURL, points: 90, token: session.token).frame(width: 90, height: 90).clipShape(.rect(cornerRadius: 8)) } }
                        }
                    }
                    if let at = t.createdAt { Text("Posted \(Format.dateTime(Format.instant(at)))").font(.inter(11)).foregroundStyle(Color.chCaption) }
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.chInk.opacity(0.04), in: .rect(cornerRadius: 10))
            }
            ForEach(Array(r.details.enumerated()), id: \.offset) { _, d in
                if let text = d.details { Text("“\(text)” — \(ModerationModel.reasonNames[d.reason] ?? d.reason)").font(.inter(12)).foregroundStyle(Color.chFog) }
            }
            HStack(spacing: 10) {
                if !r.targetMissing {
                    Button("Remove") { note = r.reasons.map { ModerationModel.reasonNames[$0] ?? $0 }.joined(separator: ", "); resolving = (r, true) }
                        .font(.inter(12.5, .bold)).foregroundStyle(Color(hex: 0xF08A84))
                        .accessibilityIdentifier("removeReported")
                }
                Button("Dismiss") { note = ""; resolving = (r, false) }.font(.inter(12.5, .bold))
                    .accessibilityIdentifier("dismissReport")
            }
            .disabled(model.busy.contains(r.id))
        }
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reportCard")
    }
}

/// A sighting photo only moderators may see (fetched with the session), with Delete.
struct ModeratorPhoto: View {
    let submissionId: String
    let delete: () -> Void
    @Environment(SessionStore.self) private var session
    @State private var full = false
    var body: some View {
        let url = AppConfig.webURL("/api/moderation/vehicle-sightings/\(submissionId)/photo")
        Button { full = true } label: {
            Color.clear.aspectRatio(4 / 3, contentMode: .fit)
                .overlay { RemoteImage(url: url, points: 360, token: session.token) }
                .clipShape(.rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .overlay(alignment: .topTrailing) {
            Button(role: .destructive, action: delete) {
                Image(systemName: "trash").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 30, height: 30).background(Color.chDanger.opacity(0.85), in: Circle())
            }
            .padding(6)
            .accessibilityLabel("Delete this photo")
        }
        .fullScreenCover(isPresented: $full) {
            ZStack(alignment: .topTrailing) {
                Color.black.ignoresSafeArea()
                RemoteImage(url: url, points: 1400, contentMode: .fit, token: session.token)
                Button { full = false } label: {
                    Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 44, height: 44).background(.white.opacity(0.14), in: Circle())
                }
                .padding(16)
                .accessibilityLabel("Close")
            }
        }
    }
}

/// "Add to map": the cameras of the sighting's own city.
struct CameraPickerSheet: View {
    let cameras: [TrafficCamera]
    let current: String?
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List(cameras) { c in
                Button { choose(c.cameraId) } label: {
                    HStack { Text("\(c.name) (#\(c.cameraId))").foregroundStyle(Color.chInk); Spacer(); if c.cameraId == current { Image(systemName: "checkmark").foregroundStyle(Color.brandGold) } }
                }
            }
            .navigationTitle("Add to map")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

/// The pinned announcement: set (≤ 280, optional link, notify everyone) or clear.
struct AnnouncementEditor: View {
    let model: ModerationModel
    @Environment(SessionStore.self) private var session
    @State private var body_ = ""
    @State private var link = ""
    @State private var notify = false
    @State private var status = ""
    @State private var confirmClear = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "Announcement")
            Text(model.announcement.map { "Current: “\($0.body)”\($0.linkUrl.map { " (\($0))" } ?? "")" } ?? "Current: none")
                .font(.inter(12.5)).foregroundStyle(Color.chFog)
            TextField("Announcement (up to 280 characters)", text: $body_, axis: .vertical)
                .lineLimit(2...5)
                .onChange(of: body_) { if body_.count > 280 { body_ = String(body_.prefix(280)) } }
                .padding(10).background(Color.chBackground, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
            TextField("Link (optional, https://)", text: $link)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(10).background(Color.chBackground, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
            Toggle("Notify everyone", isOn: $notify).font(.inter(14))
            HStack(spacing: 12) {
                Button("Publish") { Task { status = await model.publishAnnouncement(body: body_, link: link, notify: notify, api: session.api) } }
                    .buttonStyle(GoldButtonStyle(small: true))
                if model.announcement != nil {
                    Button("Clear", role: .destructive) { confirmClear = true }.font(.inter(13, .semibold))
                }
            }
            if !status.isEmpty { Text(status).font(.inter(12.5)).foregroundStyle(Color.chFog) }
        }
        .glassCard()
        .padding(.top, 8)
        .confirmationDialog("Remove the pinned announcement?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear", role: .destructive) { Task { status = await model.clearAnnouncement(api: session.api) } }
        }
    }
}
