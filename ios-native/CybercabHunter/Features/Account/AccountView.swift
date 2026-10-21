import SwiftUI
import AuthenticationServices

/// Sign in, who you are, sign out. The same Google account and session as
/// the website (the Worker's app sign-in flow; see SessionStore).
struct AccountView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var webPage: WebPage?

    var body: some View {
        NavigationStack {
            List {
                switch session.state {
                case .restoring:
                    Section { ProgressView().frame(maxWidth: .infinity) }
                case .signedOut:
                    signedOut
                case .signedIn(let user):
                    signedIn(user)
                }
                Section {
                    Button("Privacy") { webPage = WebPage(title: "Privacy", path: "/privacy", systemImage: "hand.raised.fill") }
                } footer: {
                    Text("Cybercab Hunter \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") · native preview")
                }
            }
            .appBackground()
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fullScreenCover(item: $webPage) { page in
                SafariView(url: AppConfig.webURL(page.path)).ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private var signedOut: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Image("BrandMark").resizable().frame(width: 56, height: 56)
                Text("Sign in to Cybercab Hunter").font(.title3.weight(.bold))
                Text("Use the same Google account as on the website: your sightings, rides, XP and Social posts come with you.")
                    .font(.subheadline)
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
            if let error = session.signInError {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder
    private func signedIn(_ user: MeResponse.User) -> some View {
        Section {
            HStack(spacing: 14) {
                AvatarView(user: user, size: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(user.displayName ?? "Cybercab Hunter rider").font(.headline)
                    if let since = memberSince(user.createdAt) {
                        Text("Member since \(since)").font(.subheadline).foregroundStyle(Color.secondaryText)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        Section("On the website for now") {
            Button("Profile settings") { webPage = WebPage(title: "Profile", path: "/profile", systemImage: "person.fill") }
            Button("Rider data") { webPage = WebPage(title: "Rider data", path: "/rider-data", systemImage: "list.bullet") }
        }
        Section {
            Button("Sign out", role: .destructive) { confirmingSignOut = true }
                .confirmationDialog("Sign out of Cybercab Hunter on this iPhone?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                    Button("Sign out", role: .destructive) { session.signOut() }
                }
        }
    }

    private func memberSince(_ raw: String?) -> String? {
        guard let raw, raw.count >= 10 else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: String(raw.prefix(10))) else { return nil }
        return date.formatted(.dateTime.month(.wide).year())
    }
}
