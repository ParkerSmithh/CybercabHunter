import SwiftUI
import PhotosUI

/// Write or edit a post (the website's composer), as a sheet: text with the
/// 2,000-character counter, photos from the library (only the ones the rider
/// picks; no library access beyond that), the post type, and the optional ride
/// review, Cybercab and link attachments.
struct ComposerView: View {
    let social: SocialFeedModel
    var editing: SocialPost? = nil

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model: ComposerModel
    @State private var picked: [PhotosPickerItem] = []
    @FocusState private var bodyFocused: Bool

    init(social: SocialFeedModel, editing: SocialPost? = nil) {
        self.social = social
        self.editing = editing
        _model = State(initialValue: ComposerModel(editing: editing))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    author
                    TextField("What's happening in the Cybercab world?", text: $model.body, axis: .vertical)
                        .font(.inter(16))
                        .foregroundStyle(Color.chInk)
                        .lineLimit(4...16)
                        .focused($bodyFocused)
                        .accessibilityIdentifier("composerBody")
                    counter
                    photos
                    if model.reviewOn { reviewFields }
                    if model.vehicleOn { vehicleFields }
                    if model.linkOn { linkField }
                    if let error = model.error {
                        Text(error).font(.inter(13, .semibold)).foregroundStyle(Color(hex: 0xF08A84))
                            .accessibilityIdentifier("composerError")
                    }
                    if model.sending {
                        ProgressView(value: model.progress) { Text(model.added.isEmpty ? "Posting…" : "Uploading photos…").font(.inter(12)) }
                            .tint(.brandGold)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.chSurface.ignoresSafeArea())
            .safeAreaInset(edge: .bottom) { toolbar }
            .navigationTitle(editing == nil ? "New post" : "Edit post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing == nil ? "Post" : "Save") { publish() }
                        .fontWeight(.bold)
                        .disabled(!model.canPublish)
                        .accessibilityIdentifier("composerPublish")
                }
            }
            .onChange(of: picked) { _, items in importPhotos(items) }
            .onAppear { if editing == nil { bodyFocused = true } }
        }
        .interactiveDismissDisabled(model.sending || model.hasContent)
        .tint(.brandGold)
    }

    private var author: some View {
        HStack(spacing: 10) {
            if let user = session.user { AvatarView(user: user, size: 34) }
            VStack(alignment: .leading, spacing: 1) {
                Text(session.user?.displayName ?? "You").font(.inter(14, .bold)).foregroundStyle(Color.chInk)
                if editing != nil { Text("Editing your post").font(.inter(12)).foregroundStyle(Color.brandGold) }
            }
            Spacer()
            Menu {
                Picker("Post type", selection: $model.category) {
                    ForEach(PostCategory.allCases) { Text($0.title).tag($0) }
                }
            } label: {
                HStack(spacing: 5) { Text(model.category.title); Image(systemName: "chevron.up.chevron.down").font(.system(size: 10)) }
                    .font(.inter(12.5, .semibold)).foregroundStyle(Color.chMist)
                    .padding(.horizontal, 10).frame(minHeight: 34)
                    .overlay(Capsule().strokeBorder(Color.chHair2))
            }
            .accessibilityLabel("Post type: \(model.category.title)")
            .accessibilityIdentifier("composerCategory")
        }
    }

    private var counter: some View {
        HStack(alignment: .top) {
            if let msg = model.countMessage {
                Text(msg).font(.inter(12)).foregroundStyle(model.left < 0 ? Color(hex: 0xF08A84) : Color.brandGold)
            }
            Spacer()
            Text(model.counter).font(.inter(12.5, model.left < 0 ? .bold : .regular)).monospacedDigit()
                .foregroundStyle(model.left < 0 ? Color(hex: 0xF08A84) : model.left <= 200 ? Color.brandGold : Color.chFog)
                .accessibilityIdentifier("composerCounter")
        }
    }

    @ViewBuilder private var photos: some View {
        if model.photoCount > 0 {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(model.keep) { p in
                    preview(RemoteImage(url: p.fullURL, points: 90)) { model.removeKept(p.id) }
                }
                ForEach(model.added) { p in
                    preview(Group { if let img = p.preview { Image(uiImage: img).resizable().scaledToFill() } else { Color.chLine } }) { model.removeAdded(p.id) }
                }
                ForEach(0..<model.preparingPhotos, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 10).fill(Color.chLine).aspectRatio(1, contentMode: .fit).overlay(ProgressView())
                }
            }
        }
    }

    private func preview<V: View>(_ image: V, remove: @escaping () -> Void) -> some View {
        Color.clear.aspectRatio(1, contentMode: .fit)
            .overlay { image }
            .clipShape(.rect(cornerRadius: 10))
            .overlay(alignment: .topTrailing) {
                Button(action: remove) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 26, height: 26).background(.black.opacity(0.72), in: Circle())
                }
                .padding(4)
                .accessibilityLabel("Remove photo")
            }
    }

    // MARK: Attachments

    private var reviewFields: some View {
        AttachmentBox(title: "Ride review", icon: "star", remove: { model.reviewOn = false }) {
            VStack(alignment: .leading, spacing: 12) {
                StarRating(rating: $model.rating)
                Picker("Vehicle", selection: $model.reviewVehicle) {
                    Text("Not sure").tag("")
                    Text("Cybercab").tag("cybercab")
                    Text("Model Y").tag("model_y")
                }
                .pickerStyle(.segmented)
                HStack(spacing: 10) {
                    field("Fare ($, optional)", text: $model.fare, keyboard: .decimalPad)
                    field("Pickup wait (min)", text: $model.wait, keyboard: .numberPad)
                }
                HStack {
                    Text("Ride date").font(.inter(12, .semibold)).foregroundStyle(Color.chFog)
                    Spacer()
                    if let date = model.rideDate {
                        DatePicker("Ride date", selection: Binding(get: { date }, set: { model.rideDate = $0 }),
                                   in: ComposerModel.firstRideDate...Date.now, displayedComponents: .date)
                            .labelsHidden()
                        Button { model.rideDate = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }
                            .accessibilityLabel("Clear ride date")
                    } else {
                        Button("Add date") { model.rideDate = .now }.font(.inter(13, .semibold))
                    }
                }
            }
        }
    }

    private func field(_ label: String, text: Binding<String>, keyboard: UIKeyboardType) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.inter(12, .semibold)).foregroundStyle(Color.chFog)
            TextField("", text: text).keyboardType(keyboard).font(.inter(15))
                .padding(.horizontal, 10).frame(minHeight: 38)
                .background(Color.chBackground, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
                .accessibilityLabel(label)
        }
    }

    private var vehicleFields: some View {
        AttachmentBox(title: "Attach Cybercab", icon: "car", remove: { model.vehicleOn = false }) {
            VStack(alignment: .leading, spacing: 10) {
                if let v = model.vehicle {
                    VehicleAttachmentCard(vehicle: v)
                    HStack(spacing: 16) {
                        Spacer()
                        Button("Change") { model.vehicle = nil }.font(.inter(13, .semibold))
                        Button("Remove") { model.vehicleOn = false }.font(.inter(13, .semibold))
                    }
                } else {
                    TextField("Search by plate, VIN or vehicle ID", text: $model.vehicleQuery)
                        .font(.inter(15))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 10).frame(minHeight: 40)
                        .background(Color.chBackground, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
                        .accessibilityIdentifier("vehicleSearch")
                        .task(id: model.vehicleQuery) { await model.searchVehicles(api: session.api) }
                    if model.vehicleSearchFailed {
                        Text("Search is unavailable right now. Try again in a moment.").font(.inter(13)).foregroundStyle(Color.chFog)
                    } else if let results = model.vehicleResults {
                        if results.isEmpty {
                            Text(model.vehicleQuery.isEmpty ? "No public Cybercabs to show." : "No public Cybercab matches “\(model.vehicleQuery)”. Check the plate or VIN.")
                                .font(.inter(13)).foregroundStyle(Color.chFog)
                        }
                        ForEach(results) { v in
                            Button { model.vehicle = v } label: { VehicleAttachmentCard(vehicle: v) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("vehicleResult")
                        }
                    }
                }
                Text("Registry vehicles only. Attaching one doesn't verify a sighting: submit the sighting for moderator review to count it.")
                    .font(.inter(12)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var linkField: some View {
        AttachmentBox(title: "Link", icon: "link", remove: { model.linkOn = false; model.link = "" }) {
            TextField("https://", text: $model.link)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(.inter(15))
                .padding(.horizontal, 10).frame(minHeight: 40)
                .background(Color.chBackground, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
                .accessibilityLabel("Article link")
        }
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack(spacing: 2) {
            PhotosPicker(selection: $picked, maxSelectionCount: max(1, ComposerModel.maxPhotos - model.photoCount), matching: .images, photoLibrary: .shared()) {
                ToolLabel(title: "Photos", icon: "photo")
            }
            .disabled(model.photoCount >= ComposerModel.maxPhotos)
            .accessibilityIdentifier("composerPhotos")
            Button { model.reviewOn.toggle() } label: { ToolLabel(title: "Review", icon: "star", on: model.reviewOn) }
                .accessibilityIdentifier("composerAttachReview")
            Button { model.vehicleOn.toggle() } label: { ToolLabel(title: "Cybercab", icon: "car", on: model.vehicleOn) }
                .accessibilityIdentifier("composerAttachVehicle")
            Button { model.linkOn.toggle() } label: { ToolLabel(title: "Link", icon: "link", on: model.linkOn) }
            Spacer()
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.chSurface2)
        .overlay(alignment: .top) { Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1) }
    }


    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        picked = []
        for item in items {
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else { model.error = SocialText.errors["unsupported_file_type"]; return }
                await model.addPhoto(data)
            }
        }
    }

    private func publish() {
        Task {
            guard let post = await model.publish(api: session.api) else { return }
            Haptics.success()
            if editing != nil { social.edited(post) } else { social.published(post) }
            dismiss()
        }
    }
}

/// A composer toolbar button's label (the site's .social-tool).
struct ToolLabel: View {
    let title: String
    let icon: String
    var on = false
    var body: some View {
        Label(title, systemImage: icon)
            .font(.inter(12.5, .semibold)).foregroundStyle(Color.brandGold)
            .padding(.horizontal, 10).frame(minHeight: 38)
            .background(on ? Color.brandGold.opacity(0.14) : .clear, in: .capsule)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// An attachment section (the composer's fieldsets), with a Remove button.
struct AttachmentBox<Content: View>: View {
    let title: String
    let icon: String
    let remove: () -> Void
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(title, systemImage: icon).font(.inter(13, .bold)).foregroundStyle(Color.chInk)
                Spacer()
                Button("Remove", action: remove).font(.inter(12.5, .semibold))
            }
            content()
        }
        .padding(12)
        .background(Color.chBackground.opacity(0.6), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chInk.opacity(0.1)))
    }
}

/// 1–5 stars with the website's words (Poor … Superb).
struct StarRating: View {
    @Binding var rating: Int
    static let labels = ["Poor", "Fair", "Good", "Great", "Superb"]
    var body: some View {
        HStack(spacing: 6) {
            Text("Rating").font(.inter(12, .semibold)).foregroundStyle(Color.chFog)
            ForEach(1...5, id: \.self) { n in
                Button { rating = n } label: {
                    Image(systemName: n <= rating ? "star.fill" : "star")
                        .font(.system(size: 24)).foregroundStyle(n <= rating ? Color.brandGold : Color.chFog)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(n) \(n == 1 ? "star" : "stars"), \(Self.labels[n - 1])")
                .accessibilityAddTraits(n == rating ? .isSelected : [])
                .accessibilityIdentifier("star\(n)")
            }
            if rating > 0 { Text(Self.labels[rating - 1]).font(.inter(13, .semibold)).foregroundStyle(Color.brandGold) }
        }
        .sensoryFeedback(.selection, trigger: rating)
    }
}
