import SwiftUI
import PhotosUI
import UserNotifications

/// "Submit a sighting" (the website's sighting drawer) as a sheet. The photo
/// comes from Apple's camera, Apple's picker (the app sees only the photo
/// picked) or the Share Sheet (SightingShareInbox); all three go through
/// SubmitSightingModel.setPhoto, so they look and validate the same. There is
/// no raw GPS attachment: a Location is a confirmed verified place, and only
/// its street and city are shown. Manual search remains available.
struct SubmitSightingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(AppRouter.self) private var router
    @State private var model = SubmitSightingModel()
    @State private var picked: PhotosPickerItem?
    @State private var choosingPhotoSource = false
    @State private var pickingFromLibrary = false
    @State private var takingPhoto = false
    @State private var cameraDenied = false
    /// A shared photo that arrived while the form already had one: replace it?
    @State private var sharedReplacement: Data?
    @State private var photoFromShare = false
    @State private var signingIn = false
    @State private var pickingCamera = false
    @State private var showingLocationSuggestion = false
    @FocusState private var locationFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if model.outcome == .submitted { success } else { form }
            }
            .background(Color.chSurface.ignoresSafeArea())
            .navigationTitle("Submit a sighting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(model.sending) }
            }
            .task { await model.load(api: session.api) }
            .onChange(of: picked) { _, item in
                guard let item else { return }
                picked = nil
                photoFromShare = false
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { model.photoError = SubmitSightingModel.errors["unsupported_file_type"]; return }
                    await model.setPhoto(data)
                }
            }
            .sheet(isPresented: $signingIn) { AccountView() }
            .sheet(isPresented: $pickingCamera) { SightingCameraPicker(model: model) }
            .confirmationDialog("Add a photo", isPresented: $choosingPhotoSource, titleVisibility: .hidden) {
                Button("Take Photo") { Task { await startCamera() } }
                Button("Choose from Photo Library") { pickingFromLibrary = true }
                Button("Cancel", role: .cancel) {}
            }
            .photosPicker(isPresented: $pickingFromLibrary, selection: $picked, matching: .images, photoLibrary: .shared())
            .fullScreenCover(isPresented: $takingPhoto) {
                SightingCameraCapture { data in photoFromShare = false; Task { await model.setPhoto(data) } }.ignoresSafeArea()
            }
            .alert("Camera access is off", isPresented: $cameraDenied) {
                Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Allow Cybercab Hunter to use the camera in Settings to take a sighting photo, or choose one from your library.") }
            // A photo shared from Photos (or any app) through the Share Sheet.
            .onChange(of: router.sharedSighting, initial: true) { attachSharedPhoto() }
            .confirmationDialog("Replace the photo?", isPresented: Binding(get: { sharedReplacement != nil }, set: { if !$0 { sharedReplacement = nil } }), titleVisibility: .visible) {
                Button("Use the shared photo") {
                    if let data = sharedReplacement { photoFromShare = true; Task { await model.setPhoto(data) } }
                    sharedReplacement = nil
                }
                Button("Keep the current photo", role: .cancel) { sharedReplacement = nil }
            } message: { Text("This sighting already has a photo. The photo you shared can replace it.") }
            .onChange(of: session.user?.id) { if session.user != nil { signingIn = false } }
        }
        .interactiveDismissDisabled(model.sending || model.photo != nil)
        .tint(.brandGold)
    }

    // MARK: Form

    private var form: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                photoField
                field("City / Service Area", optional: true) {
                    Menu {
                        Picker("City", selection: $model.cityName) {
                            Text("Choose a city").tag("")
                            ForEach(model.areas) { Text($0.name).tag($0.name) }
                        }
                    } label: {
                        HStack {
                            Text(model.cityName.isEmpty ? "Choose a city" : model.cityName).foregroundStyle(model.cityName.isEmpty ? Color.chCaption : Color.chInk)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(Color.chFog)
                        }
                        .inputBox()
                    }
                    .accessibilityLabel("City: \(model.cityName.isEmpty ? "none" : model.cityName)")
                    .accessibilityIdentifier("sightingCity")
                }
                locationField
                field("Date Spotted", optional: true, help: "Leave empty for today. The time is recorded automatically when you submit, in the area's local time.") {
                    HStack {
                        if let date = model.date {
                            DatePicker("Date spotted", selection: Binding(get: { date }, set: { model.date = $0 }), in: ...Date.now, displayedComponents: .date)
                                .labelsHidden()
                            Spacer()
                            Button { model.date = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }
                                .accessibilityLabel("Clear the date (today)")
                        } else {
                            Text("Today").foregroundStyle(Color.chMist)
                            Spacer()
                            Button("Choose a date") { model.date = .now }.font(.inter(13, .semibold))
                        }
                    }
                    .inputBox()
                }
                if model.isModerator { cameraField }
                field("Description", optional: true) {
                    TextField("What did you see?", text: $model.notes, axis: .vertical)
                        .lineLimit(3...6).inputBox(multiline: true)
                        .accessibilityIdentifier("sightingNotes")
                }
                field("License Plate", optional: true) {
                    TextField("e.g. ABC-1234", text: $model.plate)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .inputBox()
                        .accessibilityIdentifier("sightingPlateField")
                }
                if model.needsSignIn {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your session has ended. Sign in again to submit; everything you entered is kept.")
                            .font(.inter(13, .semibold)).foregroundStyle(Color(hex: 0xF08A84))
                        Button("Sign in") { signingIn = true }.buttonStyle(GoldButtonStyle(small: true))
                    }
                    .accessibilityIdentifier("sightingSignInAgain")
                }
                if let error = model.error {
                    Text(error).font(.inter(13, .semibold)).foregroundStyle(model.outcome == .duplicate ? Color.brandGold : Color(hex: 0xF08A84))
                        .accessibilityIdentifier("sightingError")
                }
                if model.sending {
                    ProgressView(value: model.progress) { Text("Uploading…").font(.inter(12)) }.tint(.brandGold)
                }
                Button { Task { await model.submit(api: session.api) } } label: {
                    Text(model.sending ? "Uploading…" : "Submit").frame(maxWidth: .infinity)
                }
                .buttonStyle(GoldButtonStyle())
                .disabled(model.sending || model.preparingPhoto)
                .accessibilityIdentifier("sightingSubmit")
                Text("Sightings are submitted for review. They're not verified or made public immediately.")
                    .font(.inter(12)).foregroundStyle(Color.chCaption)
            }
            .padding(16)
            .font(.inter(15))
        }
        .scrollDismissesKeyboard(.interactively)
        // Typing a place: the field moves to the top so its suggestions sit
        // above the keyboard, not behind it.
        .onChange(of: locationFocused) { _, on in if on { withAnimation { proxy.scrollTo("locationField", anchor: .top) } } }
        .onChange(of: model.places) { _, list in if locationFocused && !list.isEmpty { withAnimation { proxy.scrollTo("locationField", anchor: .top) } } }
        // A photo error (Submit without one) is shown where it is, at the top.
        .onChange(of: model.photoError) { _, e in if e != nil { withAnimation { proxy.scrollTo("photoField", anchor: .top) } } }
        }
    }

    /// Take Photo: the camera once allowed (asked the first time), else the way to Settings.
    private func startCamera() async {
        switch await SightingCameraCapture.requestAccess() {
        case .allowed: takingPhoto = true
        case .denied: cameraDenied = true
        }
    }

    /// The shared photo, taken from the inbox (so it is attached once), through
    /// the same preparation as any photo. A photo already in the form isn't
    /// replaced without asking.
    private func attachSharedPhoto() {
        guard let share = router.sharedSighting else { return }
        router.sharedSighting = nil
        // Its "Finish your Cybercab sighting" notification has done its job.
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [SightingShareInbox.notificationID(share.id)])
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [SightingShareInbox.notificationID(share.id)])
        guard let data = SightingShareInbox.take(share.id) else {
            model.photoError = "The shared photo is no longer available. Share it again, or add it from your library."
            return
        }
        if model.outcome != .editing { model.reset() }
        if model.photo != nil { sharedReplacement = data; return }
        photoFromShare = true
        Task { await model.setPhoto(data) }
    }

    private var photoField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PHOTO").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chFog)
            let preview = model.preview, preparing = model.preparingPhoto
            // Take Photo or Choose from Photo Library (no camera, as in the Simulator: the library).
            Button { if SightingCameraCapture.isAvailable { choosingPhotoSource = true } else { pickingFromLibrary = true } } label: {
                PhotoDropzone(preview: preview, preparing: preparing)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.preview == nil ? "Upload photo" : "Change photo")
            .accessibilityIdentifier("sightingPhotoPicker")
            if model.preview != nil {
                HStack {
                    Text(photoFromShare ? "Shared from Photos · Change Photo" : "Change Photo").font(.inter(12.5, .semibold)).foregroundStyle(Color.brandGold)
                    Spacer()
                    Button("Remove photo", role: .destructive) { model.removePhoto(); photoFromShare = false }.font(.inter(12.5, .semibold))
                }
                .accessibilityIdentifier("sightingPhotoChosen")
            }
            if let e = model.photoError { Text(e).font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("sightingPhotoError") }
        }
        .id("photoField")
    }

    /// Traffic Camera (optional): moderators only. Riders never see it (not
    /// disabled, not mentioned, no space): the form is exactly as before.
    private var cameraField: some View {
        field("Traffic Camera", optional: true,
              help: model.cameraCity == "dallas" ? "Only if this photo is a TxDOT (Dallas-area) traffic-camera capture. Once approved, it appears on the Zones map at that camera."
                                                 : "Only if this photo is a City of Austin traffic-camera capture. Once approved, it appears on the Zones map at that camera.") {
            HStack(spacing: 8) {
                Button { pickingCamera = true } label: {
                    HStack {
                        Image(systemName: "web.camera").foregroundStyle(model.cameraId.isEmpty ? Color.chCaption : Color.brandGold)
                        Text(model.selectedCamera.map { "\($0.name) (#\($0.cameraId))" } ?? "Not a traffic camera")
                            .foregroundStyle(model.cameraId.isEmpty ? Color.chCaption : Color.chInk).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.chFog)
                    }
                    .inputBox()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Traffic camera: \(model.selectedCamera?.name ?? "none")")
                .accessibilityIdentifier("sightingCamera")
                if !model.cameraId.isEmpty {
                    Button { model.cameraId = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 20)).foregroundStyle(Color.chFog) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear the traffic camera")
                        .accessibilityIdentifier("sightingCameraClear")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sightingCameraField")
    }

    private var locationField: some View {
        field("Location", optional: true, help: "Choose a city, then type and pick the place from the list. Only places in that city's area are offered. Only the street and city are shown publicly. Search © OpenStreetMap.") {
            VStack(alignment: .leading, spacing: 6) {
                Button("Use Current Location", systemImage: "location.fill") { showingLocationSuggestion = true }
                    .tint(Color.brandGold).disabled(model.area == nil)
                    .accessibilityIdentifier("useCurrentSightingLocation")
                    .sheet(isPresented: $showingLocationSuggestion) { SightingLocationSheet(submission: model) }
                TextField(model.area == nil ? "Choose a city first" : "Street or landmark", text: $model.locationText)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.words)
                    .disabled(model.area == nil)
                    .focused($locationFocused)
                    .inputBox()
                    .onChange(of: model.locationText) { _, new in if new != model.place?.label { model.locationEdited() } }
                    .task(id: model.locationText) { await model.searchPlaces(api: session.api) }
                    .accessibilityIdentifier("sightingLocation")
                if model.area == nil {
                    Text("Choose a City above to search for a place.").font(.inter(12)).foregroundStyle(Color.brandGold)
                }
                if let place = model.place {
                    Label("Picked: \(place.label)", systemImage: "checkmark.circle.fill").font(.inter(12)).foregroundStyle(Color.chOK)
                        .accessibilityIdentifier("sightingPlacePicked")
                }
                if model.searchingPlaces && model.places.isEmpty {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Searching…").font(.inter(12.5)).foregroundStyle(Color.chFog) }
                }
                if !model.places.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(model.places) { p in
                            Button { model.pick(p); locationFocused = false } label: {
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: "mappin").foregroundStyle(Color.brandGold)
                                    Text(p.label).font(.inter(14)).foregroundStyle(Color.chInk).multilineTextAlignment(.leading)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("placeSuggestion")
                            if p.id != model.places.last?.id { Rectangle().fill(Color.chLine).frame(height: 1) }
                        }
                    }
                    .background(Color.chSurface2, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.brandGold.opacity(0.3)))
                }
                if let m = model.placesMessage { Text(m).font(.inter(12.5)).foregroundStyle(Color.chFog).accessibilityIdentifier("placesMessage") }
                if let e = model.locationError { Text(e).font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("sightingLocationError") }
            }
        }
        .id("locationField")
    }

    private func field<C: View>(_ label: String, optional: Bool, help: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            (Text(label.uppercased()).foregroundStyle(Color.chFog) + Text(optional ? "  (optional)" : "").foregroundStyle(Color.chCaption))
                .font(.inter(11, .bold)).tracking(0.8)
            content()
            if let help { Text(help).font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true) }
        }
    }

    // MARK: Success (the drawer's "SIGHTING SUBMITTED!")

    private var success: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "checkmark").font(.system(size: 30, weight: .bold)).foregroundStyle(Color(hex: 0x1A1204))
                .frame(width: 64, height: 64).background(Color.brandGold, in: Circle())
            Text("SIGHTING SUBMITTED!").displayTitle(22).accessibilityIdentifier("sightingSubmitted")
            Text("Your photo has been received and is awaiting review.").font(.inter(14)).foregroundStyle(Color.chFog).multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Submit another") { model.reset() }.buttonStyle(GoldButtonStyle(small: true))
                Button("Done") { dismiss() }.font(.inter(14, .semibold))
            }
            .padding(.top, 6)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }
}

/// The photo box (the website's dropzone): the preview, or the prompt.
private struct PhotoDropzone: View {
    let preview: UIImage?
    let preparing: Bool
    var body: some View {
        ZStack {
            if let preview {
                Image(uiImage: preview).resizable().scaledToFit().frame(maxHeight: 220)
            } else if preparing {
                ProgressView().tint(Color.chFog).frame(height: 140)
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "camera").font(.system(size: 26)).foregroundStyle(Color.brandGold)
                    Text("Upload Photo").font(.inter(15, .bold)).foregroundStyle(Color.chInk)
                    Text("JPEG, PNG or WebP · up to 10 MB").font(.inter(12)).foregroundStyle(Color.chCaption)
                }
                .frame(maxWidth: .infinity).frame(height: 140)
            }
        }
        .frame(maxWidth: .infinity)
        .background(Color.chBackground, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.brandGold.opacity(0.35), style: StrokeStyle(lineWidth: 1.5, dash: preview == nil ? [6, 5] : [])))
    }
}

private extension View {
    /// The form's input box (dark field, graphite border).
    /// A multi-line field gets the same inset on every side, so the placeholder
    /// and the typed text start at the top-left, 12 pt in.
    func inputBox(multiline: Bool = false) -> some View {
        self.padding(.horizontal, 12).padding(.vertical, multiline ? 12 : 0)
            .frame(minHeight: 44, alignment: multiline ? .topLeading : .leading)
            .background(Color.chBackground, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
    }
}

/// The moderator's camera picker: the selected city's cameras from the camera
/// registry, searchable by name or number, with loading, empty and error states.
struct SightingCameraPicker: View {
    let model: SubmitSightingModel
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                switch model.cameraList {
                case .idle, .loading:
                    ProgressView("Loading cameras…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed:
                    ContentUnavailableView {
                        Label("Couldn't load the cameras", systemImage: "wifi.exclamationmark")
                    } description: { Text("Check your connection and try again.") } actions: {
                        Button("Try again") { Task { await model.loadCameras(api: session.api) } }
                    }
                    .accessibilityIdentifier("cameraPickerError")
                case .loaded:
                    let list = model.cityCameras(matching: query)
                    List {
                        Button { model.cameraId = ""; dismiss() } label: {
                            row("Not a traffic camera", detail: nil, selected: model.cameraId.isEmpty)
                        }
                        .accessibilityIdentifier("cameraNone")
                        ForEach(list) { c in
                            Button { model.cameraId = c.cameraId; dismiss() } label: {
                                row(c.name, detail: "#\(c.cameraId) · \(c.cityKey == "dallas" ? "Dallas (TxDOT)" : "Austin")", selected: c.cameraId == model.cameraId)
                            }
                            .accessibilityIdentifier("cameraOption")
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .overlay {
                        if list.isEmpty && !query.isEmpty {
                            ContentUnavailableView.search(text: query).accessibilityIdentifier("cameraPickerEmpty")
                        }
                    }
                }
            }
            .background(Color.chSurface.ignoresSafeArea())
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name or camera number")
            .navigationTitle(model.cameraCity == "dallas" ? "Dallas cameras" : "Austin cameras")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { if model.cameraList == .idle || model.cameraList == .failed { await model.loadCameras(api: session.api) } }
        }
        .tint(.brandGold)
    }

    private func row(_ title: String, detail: String?, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.inter(14.5, .semibold)).foregroundStyle(Color.chInk)
                if let detail { Text(detail).font(.inter(12)).foregroundStyle(Color.chCaption) }
            }
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(Color.brandGold) }
        }
        .contentShape(Rectangle())
    }
}
