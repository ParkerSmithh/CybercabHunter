import SwiftUI

/// Receipt sync (the website's /link-gmail): Tesla's receipt emails reach
/// Cybercab Hunter through a Gmail forwarding filter to the rider's private
/// address. The app never signs in to Gmail, never asks for a password, and
/// never holds a Google token; it shows the address, Gmail's confirmation
/// when it arrives, and whether receipts are reaching the address.
struct GmailForwardingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var phase
    @State private var model = GmailForwardingModel()
    @State private var confirmRotate = false
    @State private var confirmStop = false
    @State private var copied: String?

    static let filters = URL(string: "https://mail.google.com/mail/u/0/#settings/filters")!

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Eyebrow(text: "Rider data · receipt sync")
                Text("LINK GMAIL").displayTitle(30).accessibilityIdentifier("gmailTitle")
                Text("Set this up once in Gmail and every new Tesla receipt forwards itself to your private address. Gmail only has these settings on its website, so do the steps on a computer.")
                    .font(.inter(14)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                switch model.state {
                case .loading: PanelSkeleton(height: 180)
                case .signedOut: InlineMessage(text: "Sign in to set up receipt sync.").accessibilityIdentifier("gmailSignedOut")
                case .failed(let text):
                    VStack(alignment: .leading, spacing: 8) {
                        InlineMessage(text: text, systemImage: "wifi.exclamationmark")
                        Button("Try again") { Task { await model.load(api: session.api) } }.font(.inter(14, .semibold))
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("gmailError")
                case .ready: ready
                }
                Footnote(text: "Treat your forwarding address like a password: anything sent to it is read as your receipts. Only Tesla's receipt emails are used. Stopping sync or getting a new address never removes rides you already have.")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(api: session.api) }
        .refreshable { await model.refresh(api: session.api) }
        // Re-check while the screen is open, faster while Gmail's confirmation may be on its way.
        .task(id: model.state == .ready && phase == .active) {
            guard model.state == .ready, phase == .active else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(model.pollSeconds))
                if Task.isCancelled { break }
                await model.refresh(api: session.api)
            }
        }
    }

    @ViewBuilder private var ready: some View {
        statusCard
        step(1, "Copy your forwarding address") { addressBlock }
        step(2, "Start the filter") {
            Text("In Gmail on the account your Tesla receipts go to, open Settings › See all settings › Filters and Blocked Addresses › Create a new filter. In the From box, type tesla.com, click Create filter, tick Forward it, then click Add forwarding address.")
            Link("Open Gmail filter settings", destination: Self.filters).font(.inter(14, .semibold)).tint(.brandGold)
        }
        step(3, "Add and verify the address") {
            Text("On Gmail's Forwarding tab, click Add a forwarding address, paste your address, then Next and Proceed. Gmail emails a confirmation to your address. It appears here.")
            confirmation
        }
        step(4, "Finish the filter") {
            Text("Back in Filters and Blocked Addresses, create the tesla.com filter again, tick Forward it, choose your verified address, then Create filter.")
            Button(model.saving ? "Saving…" : "Done") { Task { _ = await model.markDone(api: session.api) } }
                .buttonStyle(GoldButtonStyle())
                .disabled(model.saving || !isReady)
                .accessibilityIdentifier("gmailDone")
            Text("No need to wait: take your first ride and setup completes on its own when your receipt arrives.").font(.inter(12)).foregroundStyle(Color.chFog)
        }
        step(nil, "Bring your past rides") {
            Text("Filters only forward new mail. In Gmail, search for from:tesla.com and forward each old receipt to your address, one at a time. Duplicates are caught automatically, so a ride is never counted twice.")
        }
        if let n = model.notice {
            Text(n.text).font(.inter(13, .semibold)).foregroundStyle(n.ok ? Color.chOK : Color(hex: 0xF5B83D))
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder((n.ok ? Color.chOK : Color(hex: 0xF5B83D)).opacity(0.4)))
                .accessibilityIdentifier("gmailNotice")
        }
        if let f = model.status, GmailForwardingModel.syncing(f), isReady {
            Button("Stop sync", role: .destructive) { confirmStop = true }
                .font(.inter(14, .semibold))
                .accessibilityIdentifier("gmailStop")
                .confirmationDialog("Stop receipt sync?", isPresented: $confirmStop, titleVisibility: .visible) {
                    Button("Stop sync", role: .destructive) { Task { await model.rotate(api: session.api, stopping: true) } }
                } message: { Text("Your current forwarding address stops accepting receipts. Rides you already have are kept.") }
        }
    }

    private var isReady: Bool { if case .ready = model.address { return true }; return false }

    private var statusCard: some View {
        let f = model.status
        let (icon, title, text): (String, String, String) = {
            guard let f else { return ("questionmark.circle", "Checking…", "") }
            if GmailForwardingModel.pending(f) { return ("envelope.badge", "Confirm in Gmail", "Gmail's confirmation arrived. Finish step 3.") }
            if GmailForwardingModel.linked(f) { return ("checkmark.seal.fill", "Receipts are arriving", "Last receipt \(Self.when(f.lastReceivedAt)).") }
            if f.setupCompletedAt != nil { return ("clock", "Set up, waiting for a receipt", "Your next Tesla receipt will confirm it works.") }
            return ("envelope", "Not set up yet", "Follow the steps below. This screen checks on its own.")
        }()
        return HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 20, weight: .semibold)).foregroundStyle(f.map(GmailForwardingModel.linked) == true ? Color.chOK : Color.brandGold)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.inter(15, .bold))
                if !text.isEmpty { Text(text).font(.inter(12.5)).foregroundStyle(Color.chFog) }
            }
            Spacer()
        }
        .padding(12)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("gmailStatus")
    }

    @ViewBuilder private var addressBlock: some View {
        switch model.address {
        case .ready(let a):
            Text(a).font(.system(size: 14, design: .monospaced)).foregroundStyle(Color.chInk).textSelection(.enabled)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.chSurface2, in: .rect(cornerRadius: 10))
                .accessibilityIdentifier("gmailAddress")
            HStack(spacing: 10) {
                Button(copied == "address" ? "Copied" : "Copy address") { copy(a, "address") }
                    .buttonStyle(GoldButtonStyle()).accessibilityIdentifier("gmailCopy")
                Button(model.rotating ? "Getting a new address…" : "Get a new address") { confirmRotate = true }
                    .font(.inter(13, .semibold)).tint(.chFog).disabled(model.rotating)
                    .accessibilityIdentifier("gmailRotate")
                    .confirmationDialog("Get a new forwarding address?", isPresented: $confirmRotate, titleVisibility: .visible) {
                        Button("Yes, get a new address", role: .destructive) { Task { await model.rotate(api: session.api) } }
                    } message: { Text("Your current address stops working at once. Rides you already have are kept. Point your Gmail filter at the new one.") }
            }
        case .pending:
            Text("Your forwarding address isn't available yet. Receipt sync is still being set up on our side.").font(.inter(13.5)).foregroundStyle(Color.chMist)
                .accessibilityIdentifier("gmailPending")
        case .revoked:
            Text("Your forwarding address is turned off for this account.").font(.inter(13.5, .semibold)).foregroundStyle(Color(hex: 0xF5B83D))
                .accessibilityIdentifier("gmailRevoked")
        }
    }

    @ViewBuilder private var confirmation: some View {
        if let f = model.status {
            let link = GmailForwardingModel.safeLink(f.confirmationLink)
            if let code = f.confirmationCode, !code.isEmpty {
                HStack {
                    Text(code).font(.system(size: 22, weight: .bold, design: .monospaced)).foregroundStyle(Color.brandGold).textSelection(.enabled)
                        .accessibilityLabel("Confirmation code \(code.map(String.init).joined(separator: " "))")
                        .accessibilityIdentifier("gmailCodeValue")
                    Spacer()
                    Button(copied == "code" ? "Copied" : "Copy code") { copy(code, "code") }.font(.inter(13, .semibold))
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("gmailCode")
            }
            if let link {
                if let who = f.confirmationRequestedBy { Text("Requested by \(who). Only confirm if that is your Gmail.").font(.inter(12.5)).foregroundStyle(Color(hex: 0xF5B83D)) }
                Link("Confirm in Gmail", destination: link).buttonStyle(GoldButtonStyle()).accessibilityIdentifier("gmailConfirmLink")
            }
            if GmailForwardingModel.pending(f) {
                Text("Arrived \(Self.when(f.confirmationCodeReceivedAt).lowercased()). After confirming, leave forwarding for all incoming mail off: the filter forwards only your Tesla receipts.")
                    .font(.inter(12)).foregroundStyle(Color.chFog)
            } else if GmailForwardingModel.linked(f) {
                Text("Nothing to confirm. Receipts are already reaching your address.").font(.inter(12.5)).foregroundStyle(Color.chOK)
            } else {
                Text("Waiting for Gmail's confirmation. This screen checks on its own.").font(.inter(12.5)).foregroundStyle(Color.chFog)
                    .accessibilityIdentifier("gmailWaiting")
            }
        }
    }

    private func step<C: View>(_ n: Int?, _ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if let n {
                    Text("\(n)").font(.inter(13, .heavy)).foregroundStyle(Color(hex: 0x1A1204)).frame(width: 24, height: 24).background(Color.brandGold, in: .circle)
                }
                Text(title).font(.inter(15.5, .bold))
            }
            content().font(.inter(13.5)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
    }

    private func copy(_ text: String, _ what: String) {
        UIPasteboard.general.string = text
        copied = what
        Task { try? await Task.sleep(for: .seconds(1.8)); if copied == what { copied = nil } }
    }

    static func when(_ sql: String?) -> String {
        guard let sql, let d = Format.instant(sql.replacingOccurrences(of: " ", with: "T") + "Z") else { return "Never" }
        let mins = Int((Date.now.timeIntervalSince(d) / 60).rounded())
        if mins < 1 { return "Just now" }
        if mins < 60 { return "\(mins) min ago" }
        if mins < 1440 { return "\(Int((Double(mins) / 60).rounded())) h ago" }
        return d.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
