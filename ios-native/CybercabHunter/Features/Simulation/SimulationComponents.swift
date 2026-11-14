import SwiftUI

// The website's Simulation building blocks (simulation.html, mobile layout):
// the header with the interactive Cybercab, the tinted model cards with the
// car in the corner (images/dmv-cybercab.webp, dmv-model-y.webp), the icon
// section labels (.rhw-label) and the glowing result tiles.

/// Both views open with the same compact header: text on the left, the
/// Cybercab on the right at 32% of the width (110–140 pt, .sim-hero-car),
/// with its "Open doors" button under it.
struct SimHero<Extra: View>: View {
    let eyebrow: String
    let title: String
    let titleID: String
    let text: String
    @ViewBuilder var extra: Extra
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // The car sits beside the text; at accessibility text sizes it moves
        // below, so the text and its controls get the full width.
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: eyebrow)
                Text(title).displayTitle(24).accessibilityIdentifier(titleID)
                Text(text).font(.inter(13)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                extra
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CybercabDoorsView(width: Self.carWidth)
                .frame(maxWidth: typeSize.isAccessibilitySize ? .infinity : nil)
        }
        .padding(.bottom, 2)
    }

    /// clamp(110px, 32vw, 140px)
    static var carWidth: CGFloat {
        let w = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width ?? 393
        return min(140, max(110, w * 0.32))
    }
}

extension SimHero where Extra == EmptyView {
    init(eyebrow: String, title: String, titleID: String, text: String) {
        self.init(eyebrow: eyebrow, title: title, titleID: titleID, text: text) { EmptyView() }
    }
}

/// A gold eyebrow over a section title ("SIMULATOR · FLEET BUILDER" over "OWN OR OPERATE").
struct SimSectionHead: View {
    let eyebrow: String
    let title: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(eyebrow.uppercased()).font(.inter(11, .semibold)).tracking(1.8).foregroundStyle(Color.brandGold)
            Text(title.uppercased()).font(.inter(21, .bold)).tracking(-0.4).foregroundStyle(Color.chInk)
        }
    }
}

/// A model card: a coloured border, a 135° wash of the colour fading out,
/// and the car's picture in the top-right corner (.dmv-card). The picture sits
/// wholly inside the card at the card's inset (never cropped); the heading
/// beside it leaves room for it (`TintCard.headingInset`).
struct TintCard<Content: View>: View {
    var color: Color = .brandGold
    /// "CybercabRender" (dmv-cybercab.webp) or "ModelYRender" (dmv-model-y.webp); nil for none.
    var car: String? = nil
    var carWidth: CGFloat = TintCard.carWidth
    var strength: Double = 1
    @ViewBuilder var content: Content

    /// One size for every model picture on the Simulation page.
    static var carWidth: CGFloat { 128 }
    /// The space a heading leaves on its right for the picture.
    static var headingInset: CGFloat { carWidth + 8 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .topTrailing) {
                if let car {
                    Image(car).resizable().aspectRatio(contentMode: .fit).frame(width: carWidth)
                        .shadow(color: .black.opacity(0.45), radius: 8, y: 6)
                        .padding(.top, 14).padding(.trailing, 12)
                        .accessibilityHidden(true)
                }
            }
            .background {
                ZStack {
                    Color.chSurface
                    LinearGradient(stops: [.init(color: color.opacity(0.11 * strength), location: 0), .init(color: .clear, location: 0.62)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                }
                .clipShape(.rect(cornerRadius: 16))
            }
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(color.opacity(0.35)))
    }
}

/// An icon label: a coloured line icon, then grey uppercase text (.rhw-label).
struct IconLabel: View {
    let icon: String
    let text: String
    var color: Color = .brandGold
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 13, weight: .medium)).foregroundStyle(color).frame(width: 16)
            Text(text.uppercased()).font(.inter(11.5, .semibold)).tracking(1.6).foregroundStyle(Color.chFog)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The pinned segmented control under a Simulation view's header (Fleet ROI:
/// Overview | Settings | Timeline; Fleet ETA: Estimates | Fleet | Method).
/// Full-width opaque band so it reads cleanly over the content scrolling under it.
struct SegmentBar<Tab: Hashable & Identifiable, Below: View>: View {
    let label: String
    let tabs: [Tab]
    let title: (Tab) -> String
    @Binding var selection: Tab
    let id: String
    @ViewBuilder var below: Below

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(label, selection: $selection) {
                ForEach(tabs) { Text(title($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier(id)
            below
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 16)
        .background(Color.chBackground)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1) }
        .padding(.horizontal, -16)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// Marks where the segment bar sits, and reports when the page has scrolled
/// past it (the bar is then pinned), so a segment change can bring its top
/// into view.
struct SegmentAnchor: View {
    static let id = "simSegmentTop"
    @Binding var pinned: Bool
    var body: some View {
        Color.clear.frame(height: 0)
            .id(Self.id)
            .onGeometryChange(for: Bool.self) { $0.frame(in: .scrollView).minY < -1 } action: { pinned = $0 }
            .accessibilityHidden(true)
    }
}
