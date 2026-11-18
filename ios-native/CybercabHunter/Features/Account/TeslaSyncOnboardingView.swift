import SwiftUI

/// The one-time Tesla Sync invitation a brand-new account sees (the website's
/// /link-gmail?welcome=1; worker/onboarding.js keeps one record for both).
/// Optional: Set Up Gmail opens the app's own receipt-forwarding setup
/// (GmailForwardingView, the same screen as Receipts › Manage), Skip for Now
/// closes it. Either way the rider is back exactly where they were, and it is
/// never offered automatically again, on any device.
struct TeslaSyncOnboardingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var path: [Step] = []
    @State private var succeeded = false

    enum Step: Hashable { case setup }

    var body: some View {
        NavigationStack(path: $path) {
            welcome
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Step.self) { _ in
                    GmailForwardingView(onSetUp: succeed)
                        .toolbar {
                            // Never a trap: leave the setup at any point.
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Skip for Now") { session.finishTeslaSyncInvite("skip") }
                                    .font(.inter(15, .semibold, relativeTo: .body))
                                    .tint(.brandGold)
                                    .accessibilityIdentifier("onboardingSetupSkip")
                            }
                        }
                }
        }
        .tint(.brandGold)
        .overlay { if succeeded { success.transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity)) } }
        .sensoryFeedback(.success, trigger: succeeded) { _, now in now }
        // On screen now: not offered automatically again (here or on the website).
        .task { await session.recordTeslaSync("presented") }
        // A container: its own identifier without overriding the ones inside.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("teslaSyncOnboarding")
    }

    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image("BrandMark").resizable().scaledToFit().frame(width: 60, height: 60)
                    .accessibilityHidden(true)
                    .padding(.top, 28)
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: "Tesla Sync")
                    Text("WELCOME TO CYBERCABHUNTER")
                        .font(.inter(30, .bold, relativeTo: .largeTitle)).foregroundStyle(Color.chInk)
                        // Two lines, never a word split: only when "CYBERCABHUNTER" alone is
                        // wider than the screen (the largest text sizes) does it shrink to fit.
                        .lineLimit(2)
                        .minimumScaleFactor(0.5)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("onboardingTitle")
                    Text("SET UP TESLA SYNC")
                        .font(.inter(20, .semibold, relativeTo: .title3)).foregroundStyle(Color.brandGold)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("onboardingSubtitle")
                }
                Text("Automatically track your Tesla Robotaxi rides by forwarding your Tesla receipts to CybercabHunter.")
                    .font(.inter(16, relativeTo: .body)).foregroundStyle(Color.chMist)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboardingDescription")
                VStack(alignment: .leading, spacing: 14) {
                    point("envelope.arrow.triangle.branch", "Your own private forwarding address", "Gmail forwards Tesla's receipt emails to it. No Gmail password or Google permission.")
                    point("car.side", "Rides fill in on their own", "Each receipt becomes a ride in Rider Data.")
                    point("clock.arrow.circlepath", "Optional", "Skip it now and set it up any time from Rider Data or Receipts.")
                }
                .padding(16)
                .background(Color.chSurface, in: .rect(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.chLine))
                VStack(spacing: 10) {
                    Button { path.append(.setup) } label: {
                        Text("Set Up Gmail").font(.inter(16, .bold, relativeTo: .body))
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .foregroundStyle(Color(hex: 0x1A1204))
                            .background(Color.brandGold, in: .rect(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the receipt forwarding setup")
                    .accessibilityIdentifier("onboardingSetUp")
                    Button { session.finishTeslaSyncInvite("skip") } label: {
                        Text("Skip for Now").font(.inter(16, .semibold, relativeTo: .body))
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .foregroundStyle(Color.chInk)
                            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.brandGold.opacity(0.4)))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("You can set up Tesla Sync later from Rider Data")
                    .accessibilityIdentifier("onboardingSkip")
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .appBackground()
    }

    private func point(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.brandGold)
                .frame(width: 26).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.inter(15, .semibold, relativeTo: .subheadline)).foregroundStyle(Color.chInk)
                Text(text).font(.inter(13.5, relativeTo: .footnote)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Setup done: a short confirmation, then back into the app.
    private var success: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill").font(.system(size: 48, weight: .semibold)).foregroundStyle(Color.brandGold)
                .accessibilityHidden(true)
            Text("Tesla Sync is set up").font(.inter(22, .bold, relativeTo: .title2)).foregroundStyle(Color.chInk)
            Text("New Tesla receipts will appear in Rider Data.").font(.inter(15, relativeTo: .body)).foregroundStyle(Color.chMist).multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.chBackground.opacity(0.97))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("onboardingSuccess")
    }

    private func succeed() {
        guard !succeeded else { return }
        if reduceMotion { succeeded = true } else { withAnimation(.snappy) { succeeded = true } }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(reduceMotion ? 1.2 : 1.6))
            session.finishTeslaSyncInvite("complete")
        }
    }
}
