import SwiftUI
import PhotosUI
import AuthenticationServices

/// Edit profile (the website's Settings › Profile): photo, display name,
/// username and bio. Saving sends the full set, as the website does; the
/// privacy switch keeps its current value.
struct ProfileEditView: View {
    let model: AccountModel
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var name = ""
    @State private var handle = ""
    @State private var bio = ""
    @State private var saving = false
    @State private var error: String?
    @State private var picked: PhotosPickerItem?
    @State private var cropping: UIImage?
    @State private var avatarError: String?
    @State private var avatarBusy = false
    @State private var loaded = false
    @State private var confirmRemove = false

    private var original: ProfileSettings? { model.settings }
    private var changed: Bool {
        guard let o = original else { return false }
        return name.trimmingCharacters(in: .whitespaces) != (o.displayName ?? "") || handle.trimmingCharacters(in: .whitespaces).lowercased() != (o.handle ?? "") || bio.trimmingCharacters(in: .whitespacesAndNewlines) != (o.bio ?? "")
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    PersonAvatar(name: name.isEmpty ? (session.user?.displayName ?? "") : name, url: SocialAuthor.avatarURL(original?.avatarUrl, size: 512), size: 72)
                        .accessibilityIdentifier("profilePhoto")
                    if avatarBusy { ProgressView() }
                }
                // One control per row: in a Form, a row holding several buttons runs
                // EVERY button's action when it is tapped (that once removed a photo
                // when "Change photo" was tapped).
                let title = original?.avatarUrl == nil ? "Add photo" : "Change photo"
                PhotosPicker(selection: $picked, matching: .images, photoLibrary: .shared()) { Label(title, systemImage: "photo") }
                    .buttonStyle(.borderless)
                    .disabled(avatarBusy)
                    .accessibilityIdentifier("changePhoto")
                if original?.canRemovePhoto == true {
                    Button("Remove photo", systemImage: "trash", role: .destructive) { confirmRemove = true }
                        .buttonStyle(.borderless)
                        .disabled(avatarBusy)
                        .accessibilityIdentifier("removePhoto")
                }
                if original?.canRestoreGooglePhoto == true {
                    Button("Use Google photo", systemImage: "person.crop.circle") { Task { await restoreGooglePhoto() } }
                        .buttonStyle(.borderless)
                        .disabled(avatarBusy)
                        .accessibilityIdentifier("restoreGooglePhoto")
                }
                if let avatarError { Text(avatarError).font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0xF08A84)) }
            } header: { Text("Photo") } footer: { Text("JPEG, PNG or WebP. You'll crop it to a square before it's saved.") }

            Section {
                TextField("Cybercab Hunter Rider", text: $name)
                    .onChange(of: name) { if name.count > ProfileSettings.maxDisplayName { name = String(name.prefix(ProfileSettings.maxDisplayName)) } }
                    .accessibilityIdentifier("displayNameField")
            } header: { Text("Display name") }

            Section {
                HStack(spacing: 2) {
                    Text("@").foregroundStyle(Color.chFog)
                    TextField("No username set", text: $handle)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onChange(of: handle) { if handle.count > 20 { handle = String(handle.prefix(20)) } }
                        .accessibilityIdentifier("handleField")
                }
            } header: { Text("Username") } footer: {
                Text("Your public profile is at cybercabhunter.com/rider/\(handle.isEmpty ? "username" : handle.lowercased()). Letters, numbers and underscores.")
            }

            Section {
                TextField("No bio yet.", text: $bio, axis: .vertical)
                    .lineLimit(3...6)
                    .onChange(of: bio) { if bio.count > ProfileSettings.maxBio { bio = String(bio.prefix(ProfileSettings.maxBio)) } }
                    .accessibilityIdentifier("bioField")
            } header: { Text("Bio") } footer: { Text("Up to 280 characters.") }

            if let error {
                Section { Text(error).foregroundStyle(Color(hex: 0xF08A84)).accessibilityIdentifier("profileError") }
            }
        }
        .font(.inter(15))
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle("Edit profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(!changed || saving)
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("saveProfile")
            }
        }
        .confirmationDialog("Remove your profile photo?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove photo", role: .destructive) { Task { await removePhoto() } }
        } message: {
            Text(original?.hasGoogleAvatar == true || original?.googleLinked == true ? "Your uploaded photo is removed and your Google photo shows instead." : "Your profile shows your initials instead.")
        }
        .onAppear(perform: fill)
        .onChange(of: model.settings) { if !loaded { fill() } }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            picked = nil
            Task {
                avatarError = nil
                guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                    avatarError = AccountModel.avatarErrors["unsupported_file_type"]; return
                }
                cropping = image
            }
        }
        .fullScreenCover(isPresented: Binding(get: { cropping != nil }, set: { if !$0 { cropping = nil } })) {
            if let image = cropping {
                AvatarCropView(image: image) { large, thumb in
                    cropping = nil
                    Task { await upload(large: large, thumb: thumb) }
                } cancel: { cropping = nil }
            }
        }
    }

    private func fill() {
        guard let s = original else { return }
        name = s.displayName ?? ""
        handle = s.handle ?? ""
        bio = s.bio ?? ""
        loaded = true
    }

    private func save() async {
        guard var next = original else { return }
        next.displayName = name
        next.handle = handle.trimmingCharacters(in: .whitespaces).lowercased()
        next.bio = bio
        saving = true
        error = nil
        defer { saving = false }
        if let problem = await model.save(next, api: session.api) { error = problem; return }
        await session.refreshAccount()
        Haptics.success()
        dismiss()
    }

    private func upload(large: Data, thumb: Data) async {
        avatarBusy = true
        defer { avatarBusy = false }
        avatarError = await model.uploadAvatar(large: large, thumb: thumb, api: session.api)
        if avatarError == nil { await session.refreshAccount() }
    }

    private func removePhoto() async {
        avatarBusy = true
        defer { avatarBusy = false }
        avatarError = await model.removeAvatar(api: session.api)
        guard avatarError == nil else { return }
        // No Google picture on record yet: a Google sign-in records it and shows it.
        if model.settings?.canRestoreGooglePhoto == true { await restoreGooglePhoto(); return }
        await session.refreshAccount()
    }

    /// Google sign-in (Apple's sheet, as on the Account tab): the server records
    /// the Google picture and shows it, since no upload is in place.
    private func restoreGooglePhoto() async {
        avatarBusy = true
        defer { avatarBusy = false }
        await session.signIn { url, scheme in
            try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: scheme, preferredBrowserSession: .shared)
        }
        if let problem = session.signInError { avatarError = problem; return }
        await model.load(api: session.api)
        NotificationCenter.default.post(name: .profileChanged, object: nil)
    }
}

/// Crop a photo to a square (drag and zoom, as on the website), then export it
/// at exactly 512 × 512 and 128 × 128 px: the original never leaves the phone,
/// and the re-encoded JPEGs carry no metadata.
struct AvatarCropView: View {
    let image: UIImage
    let done: (Data, Data) -> Void
    let cancel: () -> Void
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var dragStart: CGSize = .zero

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let side = min(geo.size.width - 40, 340)
                VStack(spacing: 18) {
                    Spacer()
                    ZStack {
                        Image(uiImage: image).resizable().scaledToFill()
                            .frame(width: side * zoom, height: side * zoom)
                            .offset(offset)
                    }
                    .frame(width: side, height: side)
                    .clipped()
                    .overlay(Rectangle().strokeBorder(Color.brandGold, lineWidth: 2))
                    .gesture(DragGesture()
                        .onChanged { g in offset = clamp(CGSize(width: dragStart.width + g.translation.width, height: dragStart.height + g.translation.height), side: side) }
                        .onEnded { _ in dragStart = offset })
                    .accessibilityLabel("Crop area")
                    HStack {
                        Image(systemName: "minus.magnifyingglass")
                        Slider(value: $zoom, in: 1...4).onChange(of: zoom) { offset = clamp(offset, side: side); dragStart = offset }
                        Image(systemName: "plus.magnifyingglass")
                    }
                    .foregroundStyle(Color.chFog)
                    .padding(.horizontal, 30)
                    .accessibilityLabel("Zoom")
                    Text("Drag the photo to reposition it. The square is exactly what your profile picture will show.")
                        .font(.inter(12.5)).foregroundStyle(Color.chFog).multilineTextAlignment(.center).padding(.horizontal, 30)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save photo") {
                            let large = render(px: 512, side: side), thumb = render(px: 128, side: side)
                            if let large, let thumb { done(large, thumb) }
                        }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("saveCrop")
                    }
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Crop photo")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    /// The image can't be dragged past the square's edges.
    private func clamp(_ o: CGSize, side: CGFloat) -> CGSize {
        let limit = side * (zoom - 1) / 2
        return CGSize(width: min(limit, max(-limit, o.width)), height: min(limit, max(-limit, o.height)))
    }

    /// Draws what the square shows at `px` × `px` (scale 1, so the pixel size is exact).
    private func render(px: CGFloat, side: CGFloat) -> Data? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let k = px / side
        let fill = side * zoom
        let aspect = image.size.width / image.size.height
        let drawSize = aspect >= 1 ? CGSize(width: fill * aspect, height: fill) : CGSize(width: fill, height: fill / aspect)
        let origin = CGPoint(x: (side - drawSize.width) / 2 + offset.width, y: (side - drawSize.height) / 2 + offset.height)
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: px, height: px), format: format).image { _ in
            image.draw(in: CGRect(x: origin.x * k, y: origin.y * k, width: drawSize.width * k, height: drawSize.height * k))
        }
        return rendered.jpegData(compressionQuality: 0.9)
    }
}

/// Delete account (the website's two steps): what is removed, then type DELETE.
struct DeleteAccountView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = ""
    @State private var deleting = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Text("This is permanent and can't be undone.").font(.inter(15, .bold)).foregroundStyle(Color(hex: 0xF08A84))
                Text("Deleting your account removes:").font(.inter(14))
                ForEach(["your account, profile, username and Community listing",
                         "your Google, Tesla and Gmail connections (Gmail access is revoked)",
                         "your ride history, receipts and receipt forwarding address",
                         "your submissions and sightings, including their photos"], id: \.self) { item in
                    Label(item, systemImage: "minus.circle").font(.inter(13.5)).foregroundStyle(Color.chMist)
                }
                Text("Vehicles in the public registry stay listed; your name is removed from them.").font(.inter(13)).foregroundStyle(Color.chFog)
            } header: { Text("1 · Review what happens") }
            Section {
                TextField("Type DELETE to confirm", text: $confirm)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .accessibilityIdentifier("deleteConfirmField")
                Button(deleting ? "Deleting…" : "Permanently delete my account", role: .destructive) { Task { await delete() } }
                    .disabled(confirm.trimmingCharacters(in: .whitespaces) != "DELETE" || deleting)
                    .accessibilityIdentifier("deleteAccountSubmit")
                if let error { Text(error).foregroundStyle(Color(hex: 0xF08A84)) }
            } header: { Text("2 · Confirm") }
        }
        .font(.inter(15))
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func delete() async {
        guard confirm.trimmingCharacters(in: .whitespaces) == "DELETE", !deleting else { return }
        deleting = true
        defer { deleting = false }
        if let e = await AccountModel.deleteAccount(api: session.api) { error = e; return }
        session.signOut()   // the server ended every session of the account
        dismiss()
    }
}
