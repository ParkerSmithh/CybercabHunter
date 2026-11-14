import SwiftUI

// The website's Simulation building blocks (simulation.html, mobile layout):
// the header with the interactive Cybercab, the tinted model cards with the
// car in the corner (images/dmv-cybercab.webp, dmv-model-y.webp), the icon
// section labels (.rhw-label) and the glowing result tiles.

/// Both views open with the same header: text on the left, the Cybercab on
/// the right at 40% of the width (120–170 pt, .sim-hero-car), with its
/// "Open doors" button under it.
struct SimHero<Extra: View>: View {
    let eyebrow: String
    let title: String
    let titleID: String
    let text: String
    @ViewBuilder var extra: Extra

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: eyebrow)
                Text(title).displayTitle(28).accessibilityIdentifier(titleID)
                Text(text).font(.inter(14)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                extra
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CybercabDoorsView(width: Self.carWidth)
        }
        .padding(.bottom, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1).offset(y: 10) }
    }

    /// clamp(120px, 40vw, 170px)
    static var carWidth: CGFloat {
        let w = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width ?? 393
        return min(170, max(120, w * 0.4))
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
