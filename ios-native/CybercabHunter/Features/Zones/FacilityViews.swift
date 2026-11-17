import SwiftUI
import MapKit

// Robotaxi facilities on the Zones map (FacilityStore, the website's
// /data/facilities.json): the preview a tapped marker opens, the details
// screen it pushes, and the full-screen photo viewer.

// MARK: - Small pieces

/// The marker's symbols: a bolt (charging hub), a P (staging ground) or both.
struct FacilityGlyph: View {
    let kind: Facility.Kind
    var size: CGFloat = 11
    var body: some View {
        HStack(spacing: 1) {
            if kind != .staging { Image(systemName: "bolt.fill") }
            if kind != .charging { Image(systemName: "parkingsign") }
        }
        .font(.system(size: size, weight: .bold))
        .foregroundStyle(Color.brandGold)
        .accessibilityHidden(true)
    }
}

/// "⚡ CHARGING HUB" in gold, as the website's type label.
struct FacilityTypeLabel: View {
    let facility: Facility
    let store: FacilityStore
    var body: some View {
        HStack(spacing: 6) {
            FacilityGlyph(kind: facility.type, size: 10)
            Text(store.typeLabel(facility).uppercased()).font(.inter(11, .semibold, relativeTo: .caption)).tracking(1.4)
        }
        .foregroundStyle(Color.brandGold)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(store.typeLabel(facility))
    }
}

/// A coloured dot per operational status (the website's colours).
struct FacilityStatusDot: View {
    let status: String
    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true)
    }
    private var color: Color {
        switch status {
        case "operating": .brandGold
        case "reported": Color(hex: 0xF5A524)
        case "planned": Color(hex: 0x7C8AA5)
        default: Color(hex: 0x5B616B)
        }
    }
}

/// "● Reported activity · Confirmed"
struct FacilityStatusLine: View {
    let facility: Facility
    let store: FacilityStore
    var body: some View {
        HStack(spacing: 6) {
            FacilityStatusDot(status: facility.operational)
            Text(store.operationalLabel(facility))
            Text("·").foregroundStyle(Color(hex: 0x5B616B)).accessibilityHidden(true)
            Text(store.verificationLabel(facility))
        }
        .font(.inter(12.5, relativeTo: .footnote)).foregroundStyle(Color.chMist)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(store.operationalLabel(facility)). Verification: \(store.verificationLabel(facility))")
    }
}

/// No photo yet, or one that couldn't load: never a stand-in picture.
struct FacilityPlaceholder: View {
    let kind: Facility.Kind
    let message: String
    var compact = false
    var body: some View {
        VStack(spacing: compact ? 5 : 8) {
            FacilityGlyph(kind: kind, size: compact ? 15 : 19).opacity(0.75)
            Text(message).font(.inter(compact ? 11.5 : 12.5, relativeTo: .footnote)).foregroundStyle(Color.chFog).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(8)
        .background(
            RadialGradient(colors: [Color.brandGold.opacity(0.07), .clear], center: .top, startRadius: 0, endRadius: 220)
                .background(Color(hex: 0x101113))
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(message)
        .accessibilityIdentifier("facilityPhotoPlaceholder")
    }
}

/// A facility photo from the site: loading, loaded or unavailable. Downloads
/// go through ImagePipeline (URLSession and the app's URLCache), so a photo
/// seen once shows again at once, offline too.
struct FacilityPhoto: View {
    let facility: Facility
    let photo: Facility.Photo?
    var thumb = false
    var contentMode: ContentMode = .fill
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
                    .accessibilityLabel(photo?.alt ?? "")
                    .accessibilityAddTraits(.isImage)
                    .accessibilityIdentifier("facilityPhotoImage")
            } else if photo == nil {
                FacilityPlaceholder(kind: facility.type, message: "No verified photos yet", compact: thumb)
            } else if failed {
                FacilityPlaceholder(kind: facility.type, message: "Photo unavailable", compact: thumb)
            } else {
                Color(hex: 0x101113).overlay(ProgressView().tint(Color.chFog))
                    .accessibilityLabel("Loading photo")
                    .accessibilityIdentifier("facilityPhotoLoading")
            }
        }
        .clipped()
        .task(id: photo?.src) {
            image = nil; failed = false
            guard let photo, let url = thumb ? photo.thumbURL : photo.url else { failed = photo != nil; return }
            let loaded = await ImagePipeline.shared.image(url, maxPixel: Int((thumb ? 480 : 1600) * min(scale, 3) / 3))
            if Task.isCancelled { return }
            image = loaded
            failed = loaded == nil
        }
    }
}

// MARK: - The sheet: preview, then details

struct FacilitySheet: View {
    let facility: Facility
    @State private var store = FacilityStore.shared
    @State private var path: [String] = []
    @State private var detent: PresentationDetent = .medium
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack(path: $path) {
            FacilityPreview(facility: facility, store: store) {
                // Expand first, then push: done together, the sheet keeps its height.
                withAnimation(reduceMotion ? nil : .snappy) { detent = .large }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(reduceMotion ? 50 : 280))
                    if path.isEmpty { path.append(facility.id) }
                }
            }
            .navigationDestination(for: String.self) { id in
                FacilityDetailView(facility: store.facility(id) ?? facility, store: store)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.chBackground)
    }
}

/// The compact preview a tapped marker opens.
struct FacilityPreview: View {
    let facility: Facility
    let store: FacilityStore
    let viewDetails: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Button(action: viewDetails) {
                    FacilityPhoto(facility: facility, photo: facility.photos.first, thumb: true)
                        .frame(height: 150).frame(maxWidth: .infinity)
                        .clipShape(.rect(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the facility's details")
                FacilityTypeLabel(facility: facility, store: store).padding(.top, 2)
                Text(facility.name).font(.inter(20, .bold, relativeTo: .title3)).foregroundStyle(Color.chInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("facilityPreviewName")
                Text(facility.address).font(.inter(13.5, relativeTo: .subheadline)).foregroundStyle(Color.chMist)
                FacilityStatusLine(facility: facility, store: store)
                Button(action: viewDetails) {
                    Text("View Details").font(.inter(15, .bold, relativeTo: .body)).frame(maxWidth: .infinity).frame(minHeight: 48)
                        .foregroundStyle(Color(hex: 0x1A1204))
                        .background(Color.brandGold, in: .rect(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
                .accessibilityIdentifier("facilityViewDetails")
            }
            .padding(20)
        }
        .appBackground()
        .accessibilityIdentifier("facilityPreview")
    }
}

/// Everything about one facility: gallery, details, status, sources and actions.
struct FacilityDetailView: View {
    let facility: Facility
    let store: FacilityStore
    @State private var index = 0
    @State private var viewerOpen = false
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    gallery
                    VStack(alignment: .leading, spacing: 6) {
                        FacilityTypeLabel(facility: facility, store: store)
                        Text(facility.name).font(.inter(23, .bold, relativeTo: .title2)).foregroundStyle(Color.chInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("facilityDetailName")
                        Text(facility.address).font(.inter(14, relativeTo: .subheadline)).foregroundStyle(Color.chMist)
                        if let note = facility.locationNote {
                            Text(note).font(.inter(12.5, relativeTo: .footnote)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    facts
                    Text(facility.description).font(.inter(14.5, relativeTo: .body)).foregroundStyle(Color(hex: 0xD3D7DD))
                        .fixedSize(horizontal: false, vertical: true)
                    points("Charging", facility.charging, kind: .charging)
                    points("Staging", facility.staging, kind: .staging)
                    actions(proxy)
                    sources.id("facilitySources")
                }
                .padding(20)
            }
        }
        .appBackground()
        .navigationTitle("Facility")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.chBackground, for: .navigationBar)
        .fullScreenCover(isPresented: $viewerOpen) {
            FacilityPhotoViewer(facility: facility, index: $index)
        }
        .sensoryFeedback(.selection, trigger: index)
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
    }

    // Swipeable photos, a counter, thumbnails; tap for full screen.
    @ViewBuilder private var gallery: some View {
        if facility.photos.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                FacilityPhoto(facility: facility, photo: nil).frame(height: 200).clipShape(.rect(cornerRadius: 14))
                Text("Photos are added once they're verified and cleared for reuse.").font(.inter(12, relativeTo: .caption)).foregroundStyle(Color.chFog)
            }
        } else {
            let photo = facility.photos[min(index, facility.photos.count - 1)]
            VStack(alignment: .leading, spacing: 8) {
                TabView(selection: $index) {
                    ForEach(Array(facility.photos.enumerated()), id: \.offset) { i, p in
                        Button { viewerOpen = true } label: {
                            FacilityPhoto(facility: facility, photo: p).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the photo full screen")
                        .tag(i)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .frame(height: 250)
                .clipShape(.rect(cornerRadius: 14))
                .overlay(alignment: .bottomTrailing) {
                    Text("\(index + 1) / \(facility.photos.count)")
                        .font(.inter(11.5, .semibold, relativeTo: .caption)).monospacedDigit()
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.chBackground.opacity(0.75), in: .capsule)
                        .foregroundStyle(Color.chInk)
                        .padding(10)
                        .accessibilityLabel("Photo \(index + 1) of \(facility.photos.count)")
                        .accessibilityIdentifier("facilityPhotoCounter")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("facilityGallery")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: index = min(index + 1, facility.photos.count - 1)
                    case .decrement: index = max(index - 1, 0)
                    @unknown default: break
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(photo.caption).font(.inter(13, relativeTo: .footnote)).foregroundStyle(Color.chMist)
                    Text("Photo: \(photo.credit)\(photo.license.map { " · \($0)" } ?? "")").font(.inter(11.5, relativeTo: .caption)).foregroundStyle(Color.chFog)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                if facility.photos.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(facility.photos.enumerated()), id: \.offset) { i, p in
                                Button {
                                    if reduceMotion { index = i } else { withAnimation(.snappy) { index = i } }
                                } label: {
                                    FacilityPhoto(facility: facility, photo: p, thumb: true)
                                        .frame(width: 64, height: 48)
                                        .clipShape(.rect(cornerRadius: 8))
                                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(i == index ? Color.brandGold : Color.chLine, lineWidth: i == index ? 1.5 : 1))
                                        .opacity(i == index ? 1 : 0.6)
                                        .frame(minWidth: 64, minHeight: 48)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Photo \(i + 1) of \(facility.photos.count): \(p.caption)")
                                .accessibilityAddTraits(i == index ? .isSelected : [])
                                .accessibilityIdentifier("facilityThumb-\(i)")
                            }
                        }
                    }
                }
            }
        }
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 12) {
            fact("Status") {
                HStack(spacing: 6) { FacilityStatusDot(status: facility.operational); Text(store.operationalLabel(facility)) }
            }
            fact("Verification") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.verificationLabel(facility))
                    let help = store.verificationHelp(facility)
                    if !help.isEmpty { Text(help).font(.inter(11.5, relativeTo: .caption)).foregroundStyle(Color.chFog) }
                }
            }
            fact("Last verified") { Text(Facility.day(facility.lastVerified)) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("facilityFacts")
    }

    private func fact<V: View>(_ label: String, @ViewBuilder value: () -> V) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                Text(label.uppercased()).font(.inter(10.5, .semibold, relativeTo: .caption2)).tracking(1.4).foregroundStyle(Color.chFog).frame(width: 110, alignment: .leading)
                value().font(.inter(14, .semibold, relativeTo: .subheadline)).foregroundStyle(Color.chInk)
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(label.uppercased()).font(.inter(10.5, .semibold, relativeTo: .caption2)).tracking(1.4).foregroundStyle(Color.chFog)
                value().font(.inter(14, .semibold, relativeTo: .subheadline)).foregroundStyle(Color.chInk)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func points(_ title: String, _ items: [String], kind: Facility.Kind) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title.uppercased()).font(.inter(11, .semibold, relativeTo: .caption)).tracking(1.6).foregroundStyle(Color.chFog)
                    .accessibilityAddTraits(.isHeader)
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        FacilityGlyph(kind: kind, size: 10)
                        Text(item).font(.inter(14, relativeTo: .body)).foregroundStyle(Color(hex: 0xD3D7DD)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("facility\(title)")
        }
    }

    private func actions(_ proxy: ScrollViewProxy) -> some View {
        // Four actions, always laid out (not lazy), two per row.
        Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            GridRow {
                actionButton("Open in Maps", "map.fill", gold: true, id: "facilityOpenMaps") { openInMaps() }
                ShareLink(item: facility.webURL, subject: Text(facility.name), message: Text("\(facility.name), \(facility.address)")) {
                    actionLabel("Share", "square.and.arrow.up", gold: false)
                }
                .accessibilityIdentifier("facilityShare")
            }
            GridRow {
                actionButton(copied ? "Copied" : "Copy Address", copied ? "checkmark" : "doc.on.doc", gold: false, id: "facilityCopyAddress") {
                    UIPasteboard.general.string = facility.address
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                }
                actionButton("Sources", "doc.text", gold: false, id: "facilityViewSources") {
                    if reduceMotion { proxy.scrollTo("facilitySources", anchor: .top) } else { withAnimation(.snappy) { proxy.scrollTo("facilitySources", anchor: .top) } }
                }
            }
        }
    }

    private func actionButton(_ title: String, _ icon: String, gold: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { actionLabel(title, icon, gold: gold) }
            .buttonStyle(.plain)
            .accessibilityIdentifier(id)
    }

    private func actionLabel(_ title: String, _ icon: String, gold: Bool) -> some View {
        Label(title, systemImage: icon)
            .font(.inter(13.5, .semibold, relativeTo: .subheadline))
            .lineLimit(2).minimumScaleFactor(0.85)
            .frame(maxWidth: .infinity, minHeight: 46)
            .padding(.horizontal, 8)
            .foregroundStyle(gold ? Color(hex: 0x1A1204) : Color.chInk)
            .background(gold ? Color.brandGold : Color.white.opacity(0.04), in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(gold ? Color.clear : Color.white.opacity(0.1)))
    }

    private var sources: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SOURCES").font(.inter(11, .semibold, relativeTo: .caption)).tracking(1.6).foregroundStyle(Color.chFog)
                .accessibilityAddTraits(.isHeader)
            ForEach(facility.sources) { s in
                if let link = s.link {
                    Link(destination: link) {
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.title).font(.inter(14, .semibold, relativeTo: .subheadline)).foregroundStyle(Color.chInk).multilineTextAlignment(.leading)
                                Text(s.publisher + (s.date.map { " · " + Facility.day($0) } ?? "")).font(.inter(12, relativeTo: .caption)).foregroundStyle(Color.chFog)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.brandGold).accessibilityHidden(true)
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .accessibilityHint("Opens in Safari")
                    .accessibilityIdentifier("facilitySource")
                }
            }
        }
        .padding(.top, 4)
    }

    /// Apple Maps, with driving directions to the facility's own spot.
    private func openInMaps() {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: facility.coordinate))
        item.name = facility.name
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}

// MARK: - Full screen

/// Swipe between photos, pinch or double-tap to zoom, the caption and credit below.
struct FacilityPhotoViewer: View {
    let facility: Facility
    @Binding var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(facility.photos.enumerated()), id: \.offset) { i, p in
                    VStack(spacing: 10) {
                        ZoomablePhoto(facility: facility, photo: p)
                        VStack(spacing: 2) {
                            Text(p.caption).font(.inter(13.5, relativeTo: .footnote)).foregroundStyle(Color.chMist)
                            Text("Photo: \(p.credit) · \(i + 1) / \(facility.photos.count)").font(.inter(12, relativeTo: .caption)).foregroundStyle(Color.chFog)
                        }
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 20).padding(.bottom, 20)
                        .accessibilityElement(children: .combine)
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: facility.photos.count > 1 ? .always : .never))
            .accessibilityIdentifier("facilityViewer")
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(Color.chInk)
                    .frame(width: 44, height: 44).background(Color.white.opacity(0.12), in: .circle)
            }
            .padding(16)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("facilityViewerClose")
        }
        .sensoryFeedback(.selection, trigger: index)
    }
}

private struct ZoomablePhoto: View {
    let facility: Facility
    let photo: Facility.Photo
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        FacilityPhoto(facility: facility, photo: photo, contentMode: .fit)
            .scaleEffect(scale)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .gesture(MagnifyGesture()
                .onChanged { scale = min(4, max(1, base * $0.magnification)) }
                .onEnded { _ in base = scale })
            .onTapGesture(count: 2) {
                let next: CGFloat = scale > 1 ? 1 : 2.5
                if reduceMotion { scale = next } else { withAnimation(.snappy) { scale = next } }
                base = next
            }
            .accessibilityLabel(photo.alt)
            .accessibilityAddTraits(.isImage)
    }
}
