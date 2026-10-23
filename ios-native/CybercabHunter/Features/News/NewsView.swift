import SwiftUI

/// News (the website's /news): Top stories, then every headline grouped by day
/// in Austin time, with All / Major only and a search. Each story opens the
/// original publisher's page (Safari's in-app viewer); nothing is rewritten.
struct NewsView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = NewsModel()
    @State private var opening: URL?
    @State private var searchTask: Task<Void, Never>?
    @Namespace private var filterNS
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                header
                filters
                if model.query.isEmpty && model.filter == .all && !model.top.isEmpty { topStories }
                feed
                // The site's closing note (.news-disclosure).
                Text((model.disclosure.map { $0 + " " } ?? "Stories are picked and summarized automatically; follow each link for the original reporting. ") + "Headlines and excerpts belong to their publishers. Times are Austin time (CT).")
                    .font(.inter(11)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 20)
                    .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
                    .padding(.top, 18)
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

    /// The hero: eyebrow, "CYBERCAB NEWS" (NEWS in gold), the "Stories tracked"
    /// cell with the Cybercab (images/CybercabFlipped.png), then the hairline stats bar.
    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("UPDATED EVERY 10 MINUTES").font(.inter(11, .semibold)).tracking(2).foregroundStyle(Color.brandGold)
                (Text("CYBERCAB ") + Text("NEWS").foregroundStyle(Color.brandGold))
                    .font(.inter(36, .bold)).tracking(-1.2).foregroundStyle(Color.chInk)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .accessibilityIdentifier("newsTitle")
            }
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("STORIES TRACKED").font(.inter(11, .semibold)).tracking(2).foregroundStyle(Color.chCaption)
                    Text(model.statStories.map(Format.int) ?? "—").font(.inter(32, .semibold)).monospacedDigit()
                        .foregroundStyle(Color.brandGold).shadow(color: Color.brandGold.opacity(0.45), radius: 10)
                    Text("Last 30 days").font(.inter(12)).foregroundStyle(Color.chCaption)
                }
                Spacer(minLength: 0)
                Image("CommunityCybercab").resizable().scaledToFit().frame(width: 124).accessibilityHidden(true)
            }
            .padding(.leading, 14).padding(.trailing, 4).padding(.vertical, 12)
            .background(Color.chSurface.opacity(0.8), in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.chLine))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("newsHeroCount")
            VStack(alignment: .leading, spacing: 6) {
                (Text("ALL SOURCES").foregroundStyle(Color.brandGold) + Text(" · LIVE").foregroundStyle(Color.chCaption))
                    .font(.inter(11, .semibold)).tracking(2)
                HStack(spacing: 0) {
                    statCell("Stories tracked", model.statStories, first: true)
                    statCell("Major this week", model.statMajorWeek)
                    statCell("Sources", model.statSources)
                }
                .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
                .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("newsStats")
            }
        }
        .padding(.top, 6)
    }

    private func statCell(_ label: String, _ value: Int?, first: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.inter(10.5)).foregroundStyle(Color.chCaption).lineLimit(1).minimumScaleFactor(0.8)
            Text(value.map(Format.int) ?? "—").font(.inter(22, .semibold)).monospacedDigit().foregroundStyle(Color.chInk)
        }
        .padding(.vertical, 12).padding(.leading, first ? 0 : 10).padding(.trailing, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) { if !first { Rectangle().fill(Color.white.opacity(0.07)).frame(width: 1) } }
    }

    /// "TOP STORIES ———— 4 major" and the day headings: a gold rule fading out (.news-section-head).
    static func sectionHead(_ title: String, count: String? = nil) -> some View {
        HStack(spacing: 10) {
            Text(title.uppercased()).font(.inter(15, .bold)).tracking(-0.15).foregroundStyle(Color.chInk)
            LinearGradient(stops: [.init(color: Color.brandGold.opacity(0.65), location: 0), .init(color: Color.chLine, location: 0.28), .init(color: .clear, location: 1)],
                           startPoint: .leading, endPoint: .trailing)
                .frame(height: 1)
            if let count { Text(count).font(.inter(13, .semibold)).monospacedDigit().foregroundStyle(Color.brandGold).shadow(color: Color.brandGold.opacity(0.45), radius: 7) }
        }
        .padding(.top, 12)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var topStories: some View {
        VStack(alignment: .leading, spacing: 8) {
            Self.sectionHead("Top stories", count: "\(model.top.count) major")
            ForEach(model.top) { s in StoryCard(story: s, big: true) { opening = s.link } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("newsTop")
    }

    /// The pill pair in one outlined capsule (gold when on), then the search field.
    private var filters: some View {
        VStack(alignment: .leading, spacing: 8) {
            // One outlined capsule, 3 pt inset; the gold selection fills its segment
            // exactly and slides between the two (.news-pills).
            HStack(spacing: 4) {
                filterPill("All", .all).accessibilityIdentifier("newsFilter-all")
                filterPill("Major only", .major).accessibilityIdentifier("newsFilter-major")
            }
            .padding(3)
            .background(Capsule().strokeBorder(Color.chHair2))
            .fixedSize()
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Color.chCaption)
                TextField("Search headlines", text: Binding(get: { model.query }, set: { model.query = String($0.prefix(80)) }))
                    .autocorrectionDisabled().submitLabel(.search)
                    .accessibilityIdentifier("newsSearch")
                if !model.query.isEmpty { Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }.accessibilityLabel("Clear search") }
            }
            .font(.inter(14))
            .padding(.horizontal, 12).frame(minHeight: 40)
            .background(Color(hex: 0x111214), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
        }
        .padding(.top, 4)
        // The site searches 300 ms after typing stops.
        .onChange(of: model.query) {
            searchTask?.cancel()
            searchTask = Task { try? await Task.sleep(for: .milliseconds(300)); if !Task.isCancelled { await model.reload(api: session.api) } }
        }
    }

    private func filterPill(_ title: String, _ f: NewsModel.Filter) -> some View {
        let on = model.filter == f
        return Button {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { model.filter = f }
            Task { await model.reload(api: session.api) }
        } label: {
            Text(title).font(.inter(12.5, .semibold))
                .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chFog)
                .padding(.horizontal, 14)
                .frame(height: 38)
                .background {
                    if on { Capsule().fill(Color.brandGold).matchedGeometryEffect(id: "newsFilterSelection", in: filterNS) }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    @ViewBuilder private var feed: some View {
        switch model.state {
        case .loading:
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.03)).frame(height: 78)
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chLine))
            }
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
                Self.sectionHead(day.label)
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
                HStack(alignment: .top, spacing: 10) {
                    thumb
                    VStack(alignment: .leading, spacing: 5) {
                        FlowLayout(spacing: 6) {
                            if story.isMajor {
                                Text("MAJOR").font(.inter(9, .heavy)).tracking(0.9).foregroundStyle(Color(hex: 0x1A1204))
                                    .padding(.horizontal, 5).padding(.vertical, 1).background(Color.brandGold, in: .capsule)
                                    .shadow(color: Color.brandGold.opacity(0.45), radius: 7)
                            }
                            Text(story.source).font(.inter(10.5, .semibold)).foregroundStyle(Color.chFog)
                            typeChip
                            Text(NewsModel.ago(story.publishedAt)).font(.inter(10.5)).monospacedDigit().foregroundStyle(Color.chCaption)
                        }
                        Text(story.title).font(.inter(14, .medium)).tracking(-0.3).foregroundStyle(Color.chInk).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        if let e = story.excerpt, !e.isEmpty {
                            Text(e).font(.inter(12)).foregroundStyle(Color.chMist).lineLimit(2).multilineTextAlignment(.leading)
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
                FlowLayout(spacing: 4) { ForEach(tags, id: \.self) { Text($0).font(.inter(10, .medium)).foregroundStyle(Color.chFog).padding(.horizontal, 7).padding(.vertical, 1).overlay(Capsule().strokeBorder(Color.chHair2)) } }
                    .padding(.leading, thumbSize + 10)
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
        .padding(10)
        .background {
            ZStack(alignment: .leading) {
                Color.chSurface.opacity(0.8)
                if story.isMajor {
                    LinearGradient(stops: [.init(color: Color.brandGold.opacity(0.07), location: 0), .init(color: .clear, location: 0.55)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    Rectangle().fill(Color.brandGold).frame(width: 3)
                }
            }
            .clipShape(.rect(cornerRadius: 12))
        }
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(story.isMajor ? Color.brandGold.opacity(0.55) : Color.chLine))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("newsStory")
    }

    private var thumbSize: CGFloat { big ? 72 : 56 }

    /// PRESS / OFFICIAL / SOCIAL, outlined (.news-chip; official green, social blue).
    private var typeChip: some View {
        let t = story.sourceType ?? "press"
        let color: Color = t == "official" ? Color(hex: 0x6EE7B7) : t == "social" ? Color(hex: 0x93C5FD) : .chFog
        return Text((NewsModel.typeLabel[t] ?? "Press").uppercased()).font(.inter(9, .bold)).tracking(0.5).foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(Capsule().strokeBorder(t == "press" ? Color.chHair2 : color.opacity(0.45)))
    }

    @ViewBuilder private var thumb: some View {
        let size: CGFloat = thumbSize
        Group {
            if let url = story.thumbnail {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() } else if phase.error != nil { initial } else { Color.chSurface2 }
                }
            } else { initial }
        }
        .frame(width: size, height: size)
        .clipShape(.rect(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.chLine))
        .accessibilityHidden(true)
    }

    private var initial: some View {
        ZStack {
            LinearGradient(colors: [Color.brandGold.opacity(0.16), Color.brandGold.opacity(0.03)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(story.initial).font(.inter(big ? 26 : 20, .bold)).foregroundStyle(Color.brandGold)
        }
    }
}
