import SwiftUI

/// Moderation → News (moderation.html #modPanelNews).
struct NewsModerationSection: View {
    let model: NewsModerationModel
    @Environment(SessionStore.self) private var session

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            switch model.state {
            case .idle, .loading:
                PanelSkeleton(height: 160)
            case .failed(let message):
                HStack {
                    Text(message).font(.inter(13)).foregroundStyle(Color.chFog)
                    Button("Try again") { Task { await model.load(api: session.api) } }.font(.inter(13, .semibold))
                }
                .glassCard()
            case .ready:
                Text(model.runLine).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("newsRunLine")
                Button(model.running ? "Running…" : "Run the next ingest step now") { Task { await model.runNow(api: session.api) } }
                    .modifier(OutlineButton(color: Color.chInk))
                    .buttonStyle(.plain)
                    .disabled(model.running)
                    .accessibilityIdentifier("newsRunNow")
                if model.stories.isEmpty { InlineMessage(text: "No stories collected yet.") }
                ForEach(model.stories) { s in row(s) }
                if model.nextCursor != nil {
                    Button(model.loadingMore ? "Loading…" : "Load older") { Task { await model.loadMore(api: session.api) } }
                        .modifier(OutlineButton(color: Color.chMist))
                        .buttonStyle(.plain)
                        .frame(maxWidth: .infinity)
                        .disabled(model.loadingMore)
                        .accessibilityIdentifier("newsLoadOlder")
                }
                lists
            }
        }
        .task { if model.state == .idle { await model.load(api: session.api) } }
    }

    private func row(_ s: NewsModeration.Story) -> some View {
        let busy = model.busy.contains(s.id)
        return VStack(alignment: .leading, spacing: 6) {
            FlowLayout(spacing: 6) {
                Text(s.source).font(.inter(11, .semibold)).foregroundStyle(Color.chInk)
                Text(s.sourceType ?? "").font(.inter(11)).foregroundStyle(Color.chFog)
                Text(NewsModerationModel.when(s.publishedAt)).font(.inter(11)).foregroundStyle(Color.chFog)
                if s.importance == 2 {
                    Text(s.featured ? "Major · featured" : "Major").font(.inter(10.5, .bold)).foregroundStyle(Color(hex: 0x1A1204))
                        .padding(.horizontal, 5).background(Color.brandGold, in: .rect(cornerRadius: 4))
                } else if s.importance == 1 {
                    tag("Notable")
                }
                if (s.sourceCount ?? 1) > 1 { Text("\(s.sourceCount ?? 0) outlets").font(.inter(11)).foregroundStyle(Color.chFog) }
                if let ai = s.aiMajor { tag(ai != 0 ? "AI: major" : "AI: not major") }
                if s.hidden { tag("Hidden", color: Color(hex: 0xF08A84)).accessibilityIdentifier("newsHiddenTag") }
            }
            if let url = URL(string: s.url), s.url.hasPrefix("https://") {
                Link(s.title, destination: url).font(.inter(14, .semibold)).foregroundStyle(Color.chInk).multilineTextAlignment(.leading)
            } else {
                Text(s.title).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
            }
            HStack(spacing: 8) {
                Button(s.hidden ? "Unhide" : "Hide") { Task { await model.act(s, s.hidden ? "unhide" : "hide", api: session.api) } }
                    .modifier(OutlineButton(color: Color.chMist))
                    .accessibilityIdentifier(s.hidden ? "newsUnhide" : "newsHide")
                Button(s.featured ? "Unfeature" : "Feature") { Task { await model.act(s, s.featured ? "unfeature" : "feature", api: session.api) } }
                    .modifier(OutlineButton(color: Color.chMist))
                    .accessibilityIdentifier(s.featured ? "newsUnfeature" : "newsFeature")
            }
            .buttonStyle(.plain)
            .disabled(busy)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.chSurface, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chLine))
        .opacity(s.hidden ? 0.55 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("newsStory")
    }

    private func tag(_ text: String, color: Color = Color.chMist) -> some View {
        Text(text).font(.inter(10.5)).foregroundStyle(color).padding(.horizontal, 5)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(color.opacity(0.35)))
    }

    // MARK: The lists (saved together)

    private var lists: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 14) {
            listEditor("Allowlist", help: "A story is kept when one line matches. \"a + b\" means both words.", text: $model.allow, id: "newsAllow")
            listEditor("Blocklist", help: "A story whose headline has any of these is dropped.", text: $model.block, id: "newsBlock")
            VStack(alignment: .leading, spacing: 6) {
                Text("Blocked publishers").font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                Text("Stories from these outlets are dropped (any capitalization), from the next run. Stories already collected stay; hide them above if needed. \(model.blockedCount)")
                    .font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
                if model.publishers.isEmpty {
                    Text("None blocked.").font(.inter(12)).foregroundStyle(Color.chCaption)
                } else {
                    FlowLayout(spacing: 6) {
                        ForEach(model.publishers, id: \.self) { p in
                            HStack(spacing: 4) {
                                Text(p).font(.inter(12)).foregroundStyle(Color.chMist)
                                Button { model.removePublisher(p) } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).frame(width: 20, height: 20) }
                                    .buttonStyle(.plain).foregroundStyle(Color.chFog)
                                    .accessibilityLabel("Remove \(p)")
                            }
                            .padding(.leading, 9).padding(.trailing, 3).padding(.vertical, 3)
                            .overlay(Capsule().strokeBorder(Color.white.opacity(0.15)))
                        }
                    }
                }
                HStack(spacing: 8) {
                    TextField("Publisher name, e.g. BASENOR", text: $model.publisherInput)
                        .font(.inter(13)).autocorrectionDisabled()
                        .onSubmit { model.addPublisher() }
                        .onChange(of: model.publisherInput) { if model.publisherInput.count > 80 { model.publisherInput = String(model.publisherInput.prefix(80)) } }
                        .padding(.horizontal, 10).frame(minHeight: 38)
                        .background(Color.chBackground, in: .rect(cornerRadius: 9))
                        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.chHair2))
                        .accessibilityIdentifier("newsPublisherInput")
                    Button("Add") { model.addPublisher() }.modifier(OutlineButton(color: Color.chMist)).buttonStyle(.plain)
                        .accessibilityIdentifier("newsPublisherAdd")
                }
            }
            listEditor("Major keywords", help: "One per line. A headline or excerpt with any of these (at the start of a word, any capitalization) adds +1; with 3+ outlets, a number plus a fleet word, or the AI check, 2 makes a story Major. Every stored story is rescored on the next run.", text: $model.majorKeywords, id: "newsMajor")
            listEditor("No thumbnails from these domains", help: "One domain per line (e.g. example.com). Their stories are still listed, with the outlet's initial instead of a picture. Applies to stories collected from now on.", text: $model.thumbBlocklist, id: "newsThumbBlock")
            HStack(spacing: 12) {
                Button(model.saving ? "Saving…" : "Save lists") { Task { await model.save(api: session.api) } }
                    .buttonStyle(GoldButtonStyle(small: true))
                    .disabled(model.saving)
                    .accessibilityIdentifier("newsSaveLists")
                Text(model.configNote).font(.inter(12)).foregroundStyle(Color.chFog).accessibilityIdentifier("newsConfigNote")
            }
        }
        .glassCard()
        .padding(.top, 10)
    }

    private func listEditor(_ title: String, help: String, text: Binding<String>, id: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
            Text(help).font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            TextField("", text: text, axis: .vertical)
                .lineLimit(4...8)
                .font(.system(size: 13, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                .padding(10).background(Color.chBackground, in: .rect(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.chHair2))
                .accessibilityLabel(title)
                .accessibilityIdentifier(id)
        }
    }
}

/// Moderation → Gmail Link (moderation.html #modPanelGmail). Aggregate counts only.
struct GmailLinkSection: View {
    let model: GmailLinkModel
    @Environment(SessionStore.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            panel("RIDER GMAIL LINKING", "Linked means setup completed. Actively receiving means at least one forwarded receipt has arrived.") {
                switch model.stats {
                case .loading: ProgressView().frame(maxWidth: .infinity, minHeight: 60)
                case .failed: retry("Couldn't load linking counts.") { await model.loadStats(api: session.api) }
                case .ready(let s):
                    MetricGrid(columns: 3) {
                        Metric(label: "Addresses issued", value: Format.int(s.addressesIssued))
                        Metric(label: "Setup completed", value: Format.int(s.setupCompleted))
                        Metric(label: "Actively receiving", value: Format.int(s.activelyReceiving))
                        Metric(label: "Receiving (7d)", value: Format.int(s.receiving7d))
                        Metric(label: "Linked (30d)", value: Format.int(s.linked30d))
                        Metric(label: "Receipts processed", value: Format.int(s.receiptsProcessed))
                    }
                    .accessibilityIdentifier("gmailStats")
                }
            }
            switch model.detail {
            case .loading: PanelSkeleton(height: 200)
            case .failed: retry("Couldn't load the detail.") { await model.loadDetail(api: session.api) }.glassCard()
            case .ready(let d): detail(d)
            }
        }
        .task { await model.load(api: session.api) }
    }

    @ViewBuilder private func detail(_ d: ForwardingDetail) -> some View {
        let f = d.funnel
        panel("SETUP FUNNEL", "Each step as a share of the active forwarding addresses issued. Confirmation received means Gmail's forwarding-confirmation code or link reached Cybercab Hunter.") {
            VStack(spacing: 12) {
                bar("Addresses issued", f.issued, of: f.issued)
                bar("Confirmation received", f.confirmationReceived, of: f.issued)
                bar("Setup completed", f.setupCompleted, of: f.issued)
                bar("Receiving receipts (ever)", f.receiving, of: f.issued)
                bar("Receiving in the last 7 days", f.receiving7d, of: f.issued)
            }
            .accessibilityIdentifier("gmailFunnel")
            Footnote(text: f.revoked > 0 ? "\(Format.plural(f.revoked, "address", "addresses")) revoked (not counted above)." : "No revoked addresses.")
        }
        let r = d.receipts
        panel("FORWARDED RECEIPTS", "Every forwarded email the receipt pipeline processed, and what it decided.") {
            MetricGrid(columns: 2) {
                Metric(label: "Last 24 hours", value: Format.int(r.last24h))
                Metric(label: "Last 7 days", value: Format.int(r.last7d))
                Metric(label: "Last 30 days", value: Format.int(r.last30d))
                Metric(label: "All time", value: Format.int(r.total))
            }
            .accessibilityIdentifier("gmailReceipts")
            Footnote(text: "Last receipt received: \(GmailLinkModel.when(r.lastReceivedAt)).")
            Text("BY OUTCOME").font(.inter(11, .semibold)).tracking(1).foregroundStyle(Color.chMist).padding(.top, 6)
            VStack(spacing: 10) {
                ForEach(GmailLinkModel.outcomes, id: \.key) { o in bar(o.label, GmailLinkModel.count(r.byStatus, o.key), of: r.total) }
            }
        }
        panel("LAST 14 DAYS", "Forwarded receipts per day (Central time).") {
            let peak = max(1, r.daily.map(\.n).max() ?? 1)
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(r.daily, id: \.date) { day in
                    VStack(spacing: 3) {
                        Spacer(minLength: 0)
                        Text(day.n > 0 ? "\(day.n)" : "").font(.inter(9.5)).foregroundStyle(Color.chFog).monospacedDigit()
                        RoundedRectangle(cornerRadius: 2)
                            .fill(day.n > 0 ? Color.brandGold.opacity(0.8) : Color.white.opacity(0.06))
                            .frame(height: day.n > 0 ? max(6, CGFloat(day.n) / CGFloat(peak) * 90) : 2)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(GmailLinkModel.shortDay(day.date)): \(Format.plural(day.n, "receipt", "receipts"))")
                }
            }
            .frame(height: 112)
            .accessibilityIdentifier("gmailDaily")
            if let first = r.daily.first, let last = r.daily.last {
                HStack { Text(GmailLinkModel.shortDay(first.date)); Spacer(); Text(GmailLinkModel.shortDay(last.date)) }
                    .font(.inter(10)).foregroundStyle(Color.chCaption)
            }
        }
        let g = d.gmailApi
        panel("GMAIL API CONNECTIONS", "Riders who connected Gmail directly (read-only receipt sync), separate from forwarding.") {
            MetricGrid(columns: 2) {
                Metric(label: "Connected", value: Format.int(g.active))
                Metric(label: "Needs reconnecting", value: Format.int(g.error))
                Metric(label: "Disconnected", value: Format.int(g.revoked))
                Metric(label: "History imported", value: Format.int(g.backfillDone), note: "of the connected")
            }
            Footnote(text: "Last successful sync: \(GmailLinkModel.when(g.lastSuccessAt)).")
        }
    }

    private func panel<C: View>(_ title: String, _ help: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).displayTitle(18)
            Text(help).font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            content()
        }
        .glassCard()
    }

    private func bar(_ label: String, _ value: Int, of whole: Int) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.inter(13)).foregroundStyle(Color.chMist)
                Spacer()
                Text(Format.int(value)).font(.inter(13, .semibold)).foregroundStyle(Color.chInk).monospacedDigit()
            }
            HStack(spacing: 10) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.06))
                        Capsule().fill(Color.brandGold.opacity(0.8)).frame(width: whole > 0 ? geo.size.width * min(1, CGFloat(value) / CGFloat(whole)) : 0)
                    }
                }
                .frame(height: 6)
                Text(GmailLinkModel.percent(value, of: whole)).font(.inter(11)).foregroundStyle(Color.chCaption).monospacedDigit().frame(width: 38, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func retry(_ text: String, _ action: @escaping () async -> Void) -> some View {
        HStack {
            Text(text).font(.inter(13)).foregroundStyle(Color.chFog)
            Button("Try again") { Task { await action() } }.font(.inter(13, .semibold))
        }
    }
}
