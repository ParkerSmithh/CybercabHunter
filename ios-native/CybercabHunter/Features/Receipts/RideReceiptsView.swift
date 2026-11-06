import SwiftUI

/// Ride Receipts: how receipts reach Cybercab Hunter, import and scan actions,
/// and the rider's recent imports with their outcomes. Everything shown comes
/// from the server (GET /api/rides/sync-status, /api/rides/imports): no status
/// is shown that the server didn't report, and missing fields stay missing.
struct RideReceiptsView: View {
    @Environment(SessionStore.self) private var session
    @State private var forwarding = GmailForwardingModel()
    @State private var imports: [ReceiptImportsPage.Item] = []
    @State private var cursor: String?
    @State private var loadingMore = false
    @State private var loadError: String?
    @State private var refreshing = false
    @State private var importStart: ReceiptImportView.Start?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Ride Receipts").font(.inter(26, .bold)).foregroundStyle(Color.chInk).accessibilityAddTraits(.isHeader)
                    Text("Automatically import your Tesla Robotaxi ride receipts or add them manually.")
                        .font(.inter(14)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityIdentifier("receiptsHeader")
                syncCard
                quickActions
                recent
            }
            .padding(16)
        }
        .appBackground()
        .navigationTitle("Ride Receipts")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await reload() }
        .sheet(item: Binding(get: { importStart.map(StartBox.init) }, set: { if $0 == nil { importStart = nil } })) { box in
            ReceiptImportView(start: box.start).onDisappear { Task { await reloadImports() } }
        }
    }

    private struct StartBox: Identifiable { let start: ReceiptImportView.Start; var id: String { "\(start)" } }

    // MARK: Automatic import (Gmail forwarding)

    private enum SyncState { case loading, connected, pendingConfirm, notSetUp, failed(String), signedOut }
    private var syncState: SyncState {
        switch forwarding.state {
        case .loading: return .loading
        case .signedOut: return .signedOut
        case .failed(let m): return .failed(m)
        case .ready:
            guard let f = forwarding.status else { return .notSetUp }
            if GmailForwardingModel.pending(f) { return .pendingConfirm }
            return GmailForwardingModel.linked(f) ? .connected : .notSetUp
        }
    }

    private var syncCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "envelope.arrow.triangle.branch").font(.system(size: 18, weight: .semibold)).foregroundStyle(Color.brandGold)
                    .frame(width: 38, height: 38).background(Color.brandGold.opacity(0.12), in: .rect(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(syncTitle).font(.inter(16, .bold)).foregroundStyle(Color.chInk).accessibilityIdentifier("receiptSyncTitle")
                    Text(syncDetail).font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                }
            }
            if case .connected = syncState {
                HStack(spacing: 8) {
                    Button { Task { refreshing = true; await reload(); refreshing = false } } label: {
                        Label(refreshing ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise").font(.inter(13.5, .semibold))
                    }
                    .modifier(OutlineButton(color: .brandGold)).disabled(refreshing).accessibilityIdentifier("receiptRefresh")
                    NavigationLink(value: RiderDataRoute.gmail) { Text("Manage").font(.inter(13.5, .semibold)) }
                        .modifier(OutlineButton(color: .chMist)).accessibilityIdentifier("receiptManage")
                }
            } else if case .signedOut = syncState {
                EmptyView()
            } else if case .loading = syncState {
                EmptyView()
            } else {
                NavigationLink(value: RiderDataRoute.gmail) {
                    Text(isPending ? "Finish setup" : "Set up receipt forwarding").font(.inter(14, .semibold))
                }
                .modifier(OutlineButton(color: .brandGold)).accessibilityIdentifier("receiptSetup")
                Text("Cybercab Hunter only sees the Tesla receipts you forward, never the rest of your mailbox or your Gmail password.")
                    .font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("receiptSyncCard")
    }

    private var isPending: Bool { if case .pendingConfirm = syncState { true } else { false } }

    private var syncTitle: String {
        switch syncState {
        case .loading: "Checking receipt sync…"
        case .connected: "Gmail forwarding connected"
        case .pendingConfirm: "Almost set up"
        case .notSetUp: "Import receipts automatically"
        case .failed: "Receipt sync status unavailable"
        case .signedOut: "Sign in to sync receipts"
        }
    }
    private var syncDetail: String {
        switch syncState {
        case .loading: return " "
        case .connected:
            let last = forwarding.status?.lastReceivedAt.flatMap(Format.instant).map { "Last receipt received " + $0.formatted(.relative(presentation: .named)) } ?? "Waiting for the next receipt"
            return "New receipts import as soon as Tesla sends them. \(last)."
        case .pendingConfirm: return "Gmail sent a confirmation. Confirm it to start forwarding."
        case .notSetUp: return "Forward Tesla's receipt emails once in Gmail, and every new ride imports itself."
        case .failed(let m): return m + " You can still import receipts below."
        case .signedOut: return "Your receipts are tied to your Cybercab Hunter account."
        }
    }

    // MARK: Quick actions

    private var quickActions: some View {
        HStack(spacing: 10) {
            action("Import Receipt", "square.and.arrow.down", id: "receiptImportButton") { importStart = .choose }
            action("Scan Receipt", "doc.viewfinder", id: "receiptScanButton") { importStart = ReceiptImportView.canScan ? .scan : .choose }
        }
    }
    private func action(_ title: String, _ icon: String, id: String, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 20, weight: .semibold))
                Text(title).font(.inter(14, .bold))
            }
            .frame(maxWidth: .infinity, minHeight: 76)
            .foregroundStyle(Color(hex: 0x1A1204))
            .background(Color.brandGold, in: .rect(cornerRadius: 14))
        }
        .buttonStyle(.plain).accessibilityIdentifier(id)
    }

    // MARK: Recent imports

    private var recent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT IMPORTS").font(.inter(12, .heavy)).tracking(1).foregroundStyle(Color.brandGold)
            if let loadError, imports.isEmpty {
                InlineMessage(text: loadError, systemImage: "exclamationmark.triangle")
            } else if imports.isEmpty {
                Text("No receipts yet. Forward one, or import or scan one above.").font(.inter(13)).foregroundStyle(Color.chFog)
                    .accessibilityIdentifier("receiptsEmpty")
            } else {
                ForEach(imports) { item in importRow(item) }
                if cursor != nil {
                    Button(loadingMore ? "Loading…" : "Show more") { Task { await loadMore() } }
                        .font(.inter(13.5, .semibold)).disabled(loadingMore).accessibilityIdentifier("receiptsMore")
                }
            }
        }
    }

    private func importRow(_ item: ReceiptImportsPage.Item) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(ReceiptFormat.day(item.ride?.rideDate) ?? item.receivedAt.flatMap(Format.instant).map { $0.formatted(.dateTime.month(.abbreviated).day().year()) } ?? "Receipt")
                    .font(.inter(15, .bold)).foregroundStyle(Color.chInk)
                Spacer()
                Text(item.resultText).font(.inter(11.5, .bold))
                    .foregroundStyle(item.ok ? Color(hex: 0x1A1204) : Color.chMist)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(item.ok ? Color.brandGold : Color.chSurface2, in: .capsule)
            }
            if let ride = item.ride {
                if let pickup = ride.pickup { Text("From \(pickup)").font(.inter(12.5)).foregroundStyle(Color.chMist).lineLimit(1) }
                if let dropoff = ride.dropoff { Text("To \(dropoff)").font(.inter(12.5)).foregroundStyle(Color.chMist).lineLimit(1) }
                HStack(spacing: 10) {
                    if let t = ReceiptFormat.time(ride.pickupTime) { Text(t) }
                    if let f = ReceiptFormat.fare(ride.fareAmountCents, ride.currency) { Text(f) }
                }
                .font(.inter(12)).foregroundStyle(Color.chFog)
            }
            Text(item.sourceText).font(.inter(11.5)).foregroundStyle(Color.chCaption)
            if let advice = item.advice { Text(advice).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(12)
        .background(Color.chSurface, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chLine))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("receiptImportRow")
    }

    // MARK: Loading

    private func reload() async {
        async let f: Void = forwarding.load(api: session.api)
        async let i: Void = reloadImports()
        _ = await (f, i)
    }

    private func reloadImports() async {
        do {
            let page: ReceiptImportsPage = try await session.api.get("/api/rides/imports", authenticated: true, fresh: true)
            imports = page.imports; cursor = page.nextCursor; loadError = nil
        } catch APIError.unauthorized {
            imports = []; loadError = "Sign in to see your receipts."
        } catch {
            loadError = "Couldn't load recent imports. Pull to try again."
        }
    }

    private func loadMore() async {
        guard let cursor, !loadingMore else { return }
        loadingMore = true; defer { loadingMore = false }
        if let page: ReceiptImportsPage = try? await session.api.get("/api/rides/imports", query: [URLQueryItem(name: "cursor", value: cursor)], authenticated: true, fresh: true) {
            imports += page.imports.filter { new in !imports.contains { $0.id == new.id } }
            self.cursor = page.nextCursor
        }
    }
}
