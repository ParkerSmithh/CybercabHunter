import SwiftUI

/// The CybercabHunter lockup, as on the website's header (css/brand-type.css)
/// and the reference artwork (CyberCabHunter Gold Emblem Logo.png): the gold
/// diamond emblem (BrandMark, from CybercabLogoNew.png) and the wordmark
/// CYBERCABHUNTER — "CYBERCAB" white, "HUNTER" gold, Inter black, one line,
/// never wrapped or stacked. Proportions follow the reference: the emblem is
/// ~2.9x the letters' cap height (Inter's cap height is 0.727em, so the font
/// size is 0.47x the emblem) and the gap ~0.25 cap height.
struct BrandLockup: View {
    var emblem: CGFloat = 40
    /// Grows a little with Dynamic Type, within what the bar can hold.
    @ScaledMetric(relativeTo: .headline) private var scale: CGFloat = 1

    var body: some View {
        let e = emblem * min(scale, 1.15)
        HStack(spacing: e * 0.085) {
            Image("BrandMark")
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: e, height: e)
            Self.wordmark(size: e * 0.47, uppercase: true)
                .lineLimit(1)
                .minimumScaleFactor(0.7)   // narrow screens shrink the word, never wrap it
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("CybercabHunter")
    }

    /// "Cybercab" + "Hunter" as one Text (one baseline, no space between).
    /// `uppercase`: the logo form (CYBERCABHUNTER, black weight); otherwise the
    /// name as it reads in a sentence ("Sign in to CybercabHunter").
    static func wordmark(size: CGFloat, uppercase: Bool = false) -> Text {
        let a = uppercase ? "CYBERCAB" : "Cybercab", b = uppercase ? "HUNTER" : "Hunter"
        return (Text(a).foregroundStyle(Color.white) + Text(b).foregroundStyle(Color.brandGold))
            .font(.custom("Inter", fixedSize: size).weight(uppercase ? .black : .heavy))
            .tracking(uppercase ? -0.012 * size : -0.035 * size)
    }
}

/// The lockup in a screen's top bar, centred (the bar's principal place):
/// Home, the Zones map and Replay share it, so the brand is identical on each.
/// On iOS 26+ it sits on the bar itself, not in a glass capsule (which clipped
/// it). VoiceOver reads "CybercabHunter", a header.
struct BrandToolbarItem: ToolbarContent {
    /// For UI tests: homeBrand, zonesBrand, replayBrand.
    var identifier = "homeBrand"

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            item.sharedBackgroundVisibility(.hidden)
        } else {
            item
        }
    }

    private var item: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            BrandLockup()
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(identifier)
        }
    }
}

#Preview {
    BrandLockup().padding().background(Color.chBackground)
}
