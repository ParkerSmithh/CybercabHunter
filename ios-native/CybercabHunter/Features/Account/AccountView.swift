import SwiftUI
import AuthenticationServices

/// Account: sign in (the same Google account and session as the website, via
/// the Worker's app sign-in flow; see SessionStore), then the website's
/// Settings natively: profile and photo, the Community privacy switch, your
/// sightings, moderation for moderators, sign out and account deletion.
struct AccountView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.dismiss) private var dismiss
    @State private var model = AccountModel()
    @State private var confirmingSignOut = false
    @State private var webPage: WebPage?
    @State private var path = NavigationPath()
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack(path: $path) {
            List {
                switch session.state {
                case .restoring:
                    Section { ProgressView().frame(maxWidth: .infinity) }
                case .signedOut:
                    signedOut
                case .signedIn(let user):
                    signedIn(user)
                }
                Section("Notifications") {
                    NavigationLink("Notifications", value: AccountRoute.notifications)
                        .accessibilityIdentifier("pushSettingsLink")
                }
                // Siri, Shortcuts and Activity Alerts live on this iPhone: signed in or not.
                Section {
                    NavigationLink(value: AccountRoute.siri) { Label("Siri & Shortcuts", systemImage: "mic.circle") }
                        .accessibilityIdentifier("siriSettingsLink")
                    NavigationLink(value: AccountRoute.alerts) {
                        LabeledContent { Text(ActivityAlertSettings.load().enabled ? "On" : "Off") } label: { Label("Activity Alerts", systemImage: "bell.badge") }
                    }
                    .accessibilityIdentifier("alertSettingsLink")
                } header: { Text("Siri & Alerts") }
                Section {
                    // The privacy policy is a legal document: shown as published on the website.
                    Button("Privacy policy") { webPage = WebPage(title: "Privacy", path: "/privacy", systemImage: "hand.raised.fill") }
                } footer: {
                    Text("Cybercab Hunter \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") · native preview")
                }
            }
            .font(.inter(15))
            .appBackground()
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .navigationDestination(for: AccountRoute.self) { route in
                switch route {
                case .profile: ProfileEditView(model: model)
                case .sightings: MySightingsView()
                case .moderation: ModerationView()
                case .importReceipt: ImportReceiptView()
                case .delete: DeleteAccountView()
                case .rider(let handle): RiderProfileView(route: RiderRoute(handle: handle))
                case .siri: SiriSettingsView()
                case .alerts: ActivityAlertsView()
                case .notifications: PushSettingsView()
                }
            }
            .navigationDestination(for: RiderDataRoute.self) { route in
                switch route {
                case .data: RiderDataView()
                case .gmail: GmailForwardingView()
                }
            }
            .navigationDestination(for: VehicleRoute.self) { VehicleDetailView(route: $0) }
            .navigationDestination(for: RegistryPlateRoute.self) { ModerationView(initialPlate: $0.plate) }
            .fullScreenCover(item: $webPage) { page in
                SafariView(url: AppConfig.webURL(page.path)).ignoresSafeArea()
            }
            // Siri asked for one of these screens: open it right away.
            .onChange(of: router.accountRequest, initial: true) {
                guard let r = router.accountRequest else { return }
                router.accountRequest = nil
                path = NavigationPath()
                path.append(r)
            }
            .task(id: session.user?.id) {
                if session.user != nil { await model.load(api: session.api) } else { model.reset() }
            }
        }
    }

    // MARK: Signed out

    @ViewBuilder
    private var signedOut: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Image("BrandMark").resizable().frame(width: 56, height: 56)
                Text("Sign in to Cybercab Hunter").font(.inter(20, .bold))
                Text("Use the same Google account as on the website: your sightings, rides, XP and Social posts come with you.")
                    .font(.inter(14))
                    .foregroundStyle(Color.secondaryText)
            }
            .padding(.vertical, 6)
            Button {
                Task {
                    await session.signIn { url, scheme in
                        try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: scheme, preferredBrowserSession: .shared)
                    }
                }
            } label: {
                HStack {
                    if session.isSigningIn { ProgressView().tint(Color.appBackground) }
                    Text(session.isSigningIn ? "Signing in…" : "Sign in with Google").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .foregroundStyle(Color.appBackground)
            .disabled(session.isSigningIn)
            .accessibilityIdentifier("googleSignIn")
            if let error = session.signInError {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
            }
        }
    }

    // MARK: Signed in

    @ViewBuilder
    private func signedIn(_ user: MeResponse.User) -> some View {
        Section {
            HStack(spacing: 14) {
                AvatarView(user: user, size: 56)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.settings?.displayName ?? user.displayName ?? "Cybercab Hunter rider").font(.inter(17, .bold)).accessibilityIdentifier("accountName")
                    if let handle = model.settings?.handle { Text("@\(handle)").font(.inter(13, .semibold)).foregroundStyle(Color.brandGold) }
                    if let since = memberSince(user.createdAt) {
                        Text("Joined \(since)").font(.inter(12.5)).foregroundStyle(Color.secondaryText)
                    }
                }
            }
            .padding(.vertical, 4)
            if let p = model.progress {
                HStack(spacing: 6) {
                    Text(p.rank.name).font(.inter(13, .bold)).foregroundStyle(RankColor.color(p.rank.key))
                    Text("· Level \(p.level.n) · \(Format.int(p.xp)) XP").font(.inter(13)).foregroundStyle(Color.chFog)
                }
                .accessibilityElement(children: .combine)
            }
        }
        Section {
            NavigationLink(value: AccountRoute.profile) { Label("Edit profile", systemImage: "person.crop.circle") }
                .accessibilityIdentifier("editProfile")
        } header: { Text("Profile") } footer: { Text("How other riders see you on the Community leaderboard and your public profile.") }
        Section {
            privacyToggle
        } header: { Text("Privacy") } footer: {
            Text("Show my name, photo and ride counts on the Community leaderboard and a public profile. On by default. Turn it off to be left off the leaderboard."
                 + (model.settings?.handle == nil ? " Set a username to get a public profile page." : ""))
        }
        Section("Your activity") {
            NavigationLink(value: AccountRoute.sightings) { Label("My sightings", systemImage: "camera") }
                .accessibilityIdentifier("mySightings")
            if let s = model.settings, s.leaderboardOptIn, let handle = s.handle {
                NavigationLink(value: AccountRoute.rider(handle)) { Label("Your public profile", systemImage: "person.text.rectangle") }
            }
            NavigationLink(value: RiderDataRoute.data) { Label("Rider data", systemImage: "list.bullet.rectangle") }
                .accessibilityIdentifier("riderData")
            NavigationLink(value: RiderDataRoute.gmail) { Label("Receipt sync (Gmail)", systemImage: "envelope.arrow.triangle.branch") }
                .accessibilityIdentifier("receiptSync")
        }
        if model.isModerator {
            Section {
                NavigationLink(value: AccountRoute.moderation) { Label("Moderation", systemImage: "checkmark.shield") }
                    .accessibilityIdentifier("moderationLink")
            } footer: { Text("Shown because the server says this account is a moderator. Every action is checked by the server again.") }
        }
        Section {
            Button("Sign out", role: .destructive) { confirmingSignOut = true }
                .confirmationDialog("Sign out of Cybercab Hunter on this iPhone?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                    Button("Sign out", role: .destructive) { session.signOut() }
                }
            NavigationLink(value: AccountRoute.delete) { Text("Delete account").foregroundStyle(Color(hex: 0xF08A84)) }
                .accessibilityIdentifier("deleteAccount")
        } header: { Text("Account") }
    }

    @ViewBuilder private var privacyToggle: some View {
        if model.settings != nil {
            Toggle(isOn: Binding(get: { model.optInShown }, set: { on in model.requestOptIn(on, api: session.api) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Community leaderboard & public profile").font(.inter(15, .semibold))
                    if model.savingPrivacy { Text("Saving…").font(.inter(12)).foregroundStyle(Color.chFog) }
                }
            }
            .disabled(model.savingPrivacy)
            .accessibilityIdentifier("privacyToggle")
            if let e = model.privacyError { Text(e).font(.inter(12.5, .semibold)).foregroundStyle(Color(hex: 0xF08A84)) }
        } else if model.loadFailed {
            Button("Couldn't load your settings. Try again") { Task { await model.load(api: session.api) } }
        } else {
            ProgressView()
        }
    }

    private func memberSince(_ raw: String?) -> String? {
        guard let date = Format.calendarDate(raw) else { return nil }
        return date.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.wide).year())
    }
}

enum AccountRoute: Hashable {
    case profile, sightings, moderation, importReceipt, delete
    case rider(String)
    /// Siri & Shortcuts, Activity Alerts: on this iPhone, signed in or not.
    case siri, alerts, notifications
}

/// The rider's own sightings and where each one is in review (GET /api/submissions).
struct MySightingsView: View {
    @Environment(SessionStore.self) private var session
    @State private var items: [MySubmissions.Item]?
    @State private var failed = false
    @State private var submitting = false

    var body: some View {
        List {
            Section {
                Text("Sightings are submitted for review. They're not verified or made public immediately; approved photos appear in Sightings.")
                    .font(.inter(13)).foregroundStyle(Color.chFog)
                    .listRowBackground(Color.clear)
            }
            if let items {
                if items.isEmpty {
                    Text("No sightings yet.").font(.inter(14)).foregroundStyle(Color.chFog).listRowBackground(Color.clear)
                }
                ForEach(items) { s in
                    let status = SubmissionStatus(rawValue: s.status)
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: s.evidenceType == "photo" ? "photo" : "text.alignleft").foregroundStyle(Color.brandGold).frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Submitted \(Format.dateTime(Format.instant(s.submittedAt)))").font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                            if let r = s.reviewedAt { Text("Reviewed \(Format.dateTime(Format.instant(r)))").font(.inter(12)).foregroundStyle(Color.chCaption) }
                        }
                        Spacer()
                        Text(status?.title ?? s.status).font(.inter(11.5, .bold))
                            .foregroundStyle(statusColor(status))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .overlay(Capsule().strokeBorder(statusColor(status).opacity(0.45)))
                    }
                    .listRowBackground(Color.chSurface)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("mySighting-\(s.status)")
                }
            } else if failed {
                Text("Couldn't load your sightings. Pull to try again.").foregroundStyle(Color.chFog).listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .font(.inter(15))
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle("My sightings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button { submitting = true } label: { Label("Submit a sighting", systemImage: "plus") } }
        }
        .sheet(isPresented: $submitting, onDismiss: { Task { await load() } }) { SubmitSightingView() }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let r: MySubmissions = try await session.api.get("/api/submissions", authenticated: true)
            items = r.sightings
            failed = false
        } catch is CancellationError {} catch { failed = items == nil }
    }

    private func statusColor(_ s: SubmissionStatus?) -> Color {
        switch s {
        case .approved: .chOK
        case .rejected: Color(hex: 0xF08A84)
        case .needsReview: .brandGold
        default: .chMist
        }
    }
}
