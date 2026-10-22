import SwiftUI

/// News (the website's /news): Top stories, then every headline grouped by day
/// in Austin time, with All / Major only and a search. Each story opens the
/// original publisher's page (Safari's in-app viewer); nothing is rewritten.
struct NewsView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = NewsModel()
    @State private var opening: URL?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                header
                if model.query.isEmpty && model.filter == .all && !model.top.isEmpty { topStories }
                filters
                feed
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .task {
            async let a: Void = model.reload(api: session.api)
            async let b: Void = model.loadTop(api: session.api)
            async let c: Void = model.loadStats(api: session.api)
            _ = await (a, b, c)
        }
        .refreshable {
            async let a: Void = model.reload(api: session.api)
            async let b: Void = model.loadTop(api: session.api)
            _ = await (a, b)
        }
        .fullScreenCover(item: Binding(get: { opening.map(IdentifiedURL.init) }, set: { opening = $0?.url })) { SafariView(url: $0.url).ignoresSafeArea() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "Updated every 10 minutes")
            Text("CYBERCAB NEWS").displayTitle(30).accessibilityIdentifier("newsTitle")
            Text("Every Tesla Cybercab and robotaxi headline, tracked automatically.").font(.inter(14)).foregroundStyle(Color.chMist)
            MetricGrid(columns: 3) {
                Metric(label: "Stories tracked", value: model.statStories.map(Format.int) ?? "—", note: "Last 30 days", size: 20)
                Metric(label: "Major this week", value: model.statMajorWeek.map(Format.int) ?? "—", size: 20)
                Metric(label: "Sources", value: model.statSources.map(Format.int) ?? "—", size: 20)
            }
            .dataPanel()
            .accessibilityIdentifier("newsStats")
            if let d = model.disclosure { Footnote(text: d) }
        }
    }

    private var topStories: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text("TOP STORIES").font(.inter(12, .heavy)).tracking(1).foregroundStyle(Color.brandGold); Spacer(); Text("\(model.top.count) major").font(.inter(12)).foregroundStyle(Color.chFog) }
            ForEach(model.top) { s in StoryCard(story: s, big: true) { opening = s.link } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("newsTop")
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                PillToggle(title: "All", selected: model.filter == .all, compact: true) { model.filter = .all; Task { await model.reload(api: session.api) } }
                    .accessibilityIdentifier("newsFilter-all")
                PillToggle(title: "Major only", selected: model.filter == .major, compact: true) { model.filter = .major; Task { await model.reload(api: session.api) } }
                    .accessibilityIdentifier("newsFilter-major")
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.chFog)
                TextField("Search headlines", text: Binding(get: { model.query }, set: { model.query = String($0.prefix(80)) }))
                    .autocorrectionDisabled().submitLabel(.search)
                    .accessibilityIdentifier("newsSearch")
                if !model.query.isEmpty { Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }.accessibilityLabel("Clear search") }
            }
            .font(.inter(15))
            .padding(.horizontal, 12).frame(minHeight: 42)
            .background(Color.chSurface, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
        }
        // The site searches 300 ms after typing stops.
        .onChange(of: model.query) {
            searchTask?.cancel()
            searchTask = Task { try? await Task.sleep(for: .milliseconds(300)); if !Task.isCancelled { await model.reload(api: session.api) } }
        }
    }

    @ViewBuilder private var feed: some View {
        switch model.state {
        case .loading:
            ForEach(0..<3, id: \.self) { _ in RoundedRectangle(cornerRadius: 14).fill(Color.chSurface).frame(height: 96) }
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                InlineMessage(text: "We couldn't load the news right now. Try again in a moment.", systemImage: "wifi.exclamationmark")
                Button("Try again") { Task { await model.reload(api: session.api) } }.font(.inter(14, .semibold))
            }
            .accessibilityIdentifier("newsError")
        case .ready:
            if model.stories.isEmpty {
                InlineMessage(text: "No stories match.").accessibilityIdentifier("newsEmpty")
            }
            ForEach(model.days, id: \.label) { day in
                Text(day.label.uppercased()).font(.inter(12, .heavy)).tracking(1).foregroundStyle(Color.chMist).padding(.top, 6)
                ForEach(day.stories) { s in StoryCard(story: s, big: false) { opening = s.link } }
            }
            if model.cursor != nil {
                Button(model.loadingMore ? "Loading…" : "Show older stories") { Task { await model.loadMore(api: session.api) } }
                    .font(.inter(14, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                    .disabled(model.loadingMore)
                    .accessibilityIdentifier("newsMore")
            }
        }
    }
}

private struct IdentifiedURL: Identifiable { let url: URL; var id: String { url.absoluteString } }

/// One story: thumbnail (or the outlet's initial), Major badge, outlet, type,
/// time, headline, the feed's own excerpt, tags, and the other outlets.
struct StoryCard: View {
    let story: NewsPage.Story
    let big: Bool
    let open: () -> Void
    @State private var showAlso = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: open) {
                HStack(alignment: .top, spacing: 12) {
                    thumb
                    VStack(alignment: .leading, spacing: 5) {
                        FlowLayout(spacing: 6) {
                            if story.isMajor {
                                Text("MAJOR").font(.inter(9.5, .heavy)).foregroundStyle(Color(hex: 0x1A1204)).padding(.horizontal, 5).padding(.vertical, 1).background(Color.brandGold, in: .rect(cornerRadius: 4))
                            }
                            Text(story.source).font(.inter(11.5, .semibold)).foregroundStyle(Color.chInk)
                            Text(NewsModel.typeLabel[story.sourceType ?? "press"] ?? "Press").font(.inter(10.5)).foregroundStyle(Color.chFog)
                            Text(NewsModel.ago(story.publishedAt)).font(.inter(10.5)).foregroundStyle(Color.chCaption)
                        }
                        Text(story.title).font(.inter(big ? 16.5 : 15, .bold)).foregroundStyle(Color.chInk).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        if let e = story.excerpt, !e.isEmpty {
                            Text(e).font(.inter(12.5)).foregroundStyle(Color.chFog).lineLimit(big ? 4 : 3).multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(story.link == nil)
            .accessibilityHint(story.link == nil ? "This story's link isn't available." : "Opens \(story.source) in Safari.")
            if let tags = story.tags, !tags.isEmpty {
                FlowLayout(spacing: 6) { ForEach(tags, id: \.self) { Text($0).font(.inter(10.5)).foregroundStyle(Color.chMist).padding(.horizontal, 7).padding(.vertical, 2).background(Color.white.opacity(0.06), in: .capsule) } }
            }
            if !story.outlets.isEmpty {
                DisclosureGroup("Also covered by \(Format.plural(story.outlets.count, "outlet", "outlets"))", isExpanded: $showAlso) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(story.outlets.enumerated()), id: \.offset) { _, o in
                            if let url = URL(string: o.url) {
                                Link(destination: url) {
                                    HStack { Text(o.source).font(.inter(13, .semibold)); Text(NewsModel.typeLabel[o.sourceType ?? "press"] ?? "Press").font(.inter(11)).foregroundStyle(Color.chFog); Spacer(); Text(NewsModel.ago(o.publishedAt)).font(.inter(11)).foregroundStyle(Color.chCaption) }
                                }
                            }
                        }
                    }
                    .padding(.top, 4)
                }
                .font(.inter(12.5, .semibold)).tint(.brandGold)
            }
        }
        .padding(12)
        .background(story.isMajor ? Color.brandGold.opacity(0.06) : Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(story.isMajor ? Color.brandGold.opacity(0.35) : Color.chLine))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("newsStory")
    }

    @ViewBuilder private var thumb: some View {
        let size: CGFloat = big ? 84 : 64
        Group {
            if let url = story.thumbnail {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() } else if phase.error != nil { initial } else { Color.chSurface2 }
                }
            } else { initial }
        }
        .frame(width: size, height: size)
        .clipShape(.rect(cornerRadius: 10))
        .accessibilityHidden(true)
    }

    private var initial: some View {
        ZStack { Color.chSurface2; Text(story.initial).font(.inter(24, .bold)).foregroundStyle(Color.brandGold) }
    }
}
