import SwiftUI
import PhotosUI

/// "Submit a sighting" (the website's sighting drawer) as a sheet. The photo
/// comes from Apple's picker (the app sees only the photo picked). There is
/// no map pin and no location permission: as on the website, a Location is a
/// real place picked from search, and only its street and city are shown.
struct SubmitSightingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = SubmitSightingModel()
    @State private var picked: PhotosPickerItem?
    @State private var signingIn = false
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
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { model.photoError = SubmitSightingModel.errors["unsupported_file_type"]; return }
                    await model.setPhoto(data)
                }
            }
            .sheet(isPresented: $signingIn) { AccountView() }
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
                field("Traffic Camera", optional: true,
                      help: model.cameraCity == "dallas" ? "Only if this photo is a TxDOT (Dallas-area) traffic-camera capture. Once approved, it appears on the Zones map at that camera."
                                                         : "Only if this photo is a City of Austin traffic-camera capture. Once approved, it appears on the Zones map at that camera.") {
                    Menu {
                        Picker("Traffic camera", selection: $model.cameraId) {
                            Text("Not a traffic camera").tag("")
                            ForEach(model.cityCameras) { Text("\($0.name) (#\($0.cameraId))").tag($0.cameraId) }
                        }
                    } label: {
                        HStack {
                            Text(model.cityCameras.first { $0.cameraId == model.cameraId }.map { "\($0.name) (#\($0.cameraId))" } ?? "Not a traffic camera")
                                .foregroundStyle(model.cameraId.isEmpty ? Color.chCaption : Color.chInk).lineLimit(1)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(Color.chFog)
                        }
                        .inputBox()
                    }
                }
                field("Description", optional: true) {
                    TextField("What did you see?", text: $model.notes, axis: .vertical)
                        .lineLimit(3...6).inputBox()
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

    private var photoField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PHOTO").font(.inter(11, .bold)).tracking(1.2).foregroundStyle(Color.chFog)
            let preview = model.preview, preparing = model.preparingPhoto
            PhotosPicker(selection: $picked, matching: .images, photoLibrary: .shared()) {
                PhotoDropzone(preview: preview, preparing: preparing)
            }
            .accessibilityLabel(model.preview == nil ? "Upload photo" : "Change photo")
            .accessibilityIdentifier("sightingPhotoPicker")
            if model.preview != nil {
                HStack {
                    Text("Change Photo").font(.inter(12.5, .semibold)).foregroundStyle(Color.brandGold)
                    Spacer()
                    Button("Remove photo", role: .destructive) { model.removePhoto() }.font(.inter(12.5, .semibold))
                }
                .accessibilityIdentifier("sightingPhotoChosen")
            }
            if let e = model.photoError { Text(e).font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("sightingPhotoError") }
        }
        .id("photoField")
    }

    private var locationField: some View {
        field("Location", optional: true, help: "Choose a city, then type and pick the place from the list. Only places in that city's area are offered. Only the street and city are shown publicly. Search © OpenStreetMap.") {
            VStack(alignment: .leading, spacing: 6) {
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
    func inputBox() -> some View {
        self.padding(.horizontal, 12).frame(minHeight: 44)
            .background(Color.chBackground, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
    }
}
