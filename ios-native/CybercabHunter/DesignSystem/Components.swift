import SwiftUI

/// A panel's heading row: city eyebrow, uppercase title, optional badge and
/// "See all", over a hairline (`.home-data-heading`).
struct PanelHeading<Trailing: View>: View {
    let city: String?
    let title: String
    var badge: AnyView? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    if let city { Eyebrow(text: city) }
                    Text(title).displayTitle(18)
                    if let badge { badge.padding(.top, 4) }
                }
                Spacer(minLength: 8)
                trailing()
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
        }
    }
}

extension PanelHeading where Trailing == EmptyView {
    init(city: String?, title: String, badge: AnyView? = nil) {
        self.init(city: city, title: title, badge: badge, trailing: { EmptyView() })
    }
}

/// A metric: uppercase label, big number, the note under it (`.home-data-metric`).
/// Never a bare number: the note says what it covers.
struct Metric: View {
    let label: String
    let value: String
    var unit: String? = nil
    var note: String? = nil
    var valueColor: Color = .chInk
    var size: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.inter(10, .semibold, relativeTo: .caption2))
                .tracking(0.4)
                .foregroundStyle(Color.chCaption)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).statNumber(size, color: valueColor).lineLimit(1).minimumScaleFactor(0.6)
                if let unit { Text(unit).font(.inter(11, .medium)).foregroundStyle(Color.chFog) }
            }
            if let note, !note.isEmpty {
                Text(note).font(.inter(10, relativeTo: .caption2)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

/// A grid of metrics, three across like the website on phones.
struct MetricGrid<Content: View>: View {
    var columns = 3
    var rowSpacing: CGFloat = 16
    @ViewBuilder var content: () -> Content
    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: columns), alignment: .leading, spacing: rowSpacing, content: content)
    }
}

/// The small source line under a block ("From approved sightings.").
struct Footnote: View {
    let text: String
    var body: some View {
        Text(text).font(.inter(11, relativeTo: .caption)).foregroundStyle(Color.chCaption).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "About these numbers", collapsed by default, as on the website.
struct AboutNumbers: View {
    let text: String
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("About these numbers").font(.inter(12, .medium))
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).rotationEffect(.degrees(open ? 180 : 0))
                }
                .foregroundStyle(Color.chFog)
            }
            .buttonStyle(.plain)
            if open {
                Text(text).font(.inter(12, relativeTo: .footnote)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
    }
}

/// The gold "See all →" link.
struct SeeAllButton: View {
    var title = "See all"
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) { Text(title); Image(systemName: "arrow.right") }
                .font(.inter(13, .semibold))
                .foregroundStyle(Color.brandGold)
        }
        .buttonStyle(.plain)
    }
}

/// Austin / Dallas: a white pill for the selected city, outlined pills otherwise.
struct CityPicker: View {
    let cities: [ServiceArea]
    @Binding var selection: String
    /// Outlines on the unselected city (off on a glass map control, where one edge is enough).
    var bordered = true
    var body: some View {
        HStack(spacing: 8) {
            ForEach(cities) { city in
                let on = city.key == selection
                Button {
                    withAnimation(.snappy) { selection = city.key }
                } label: {
                    Text(city.name)
                        .font(.inter(14, .semibold))
                        .padding(.horizontal, 18).frame(minHeight: 40)
                        .foregroundStyle(on ? Color.chBackground : Color.chMist)
                        .background(on ? Color.chInk : Color.clear, in: .capsule)
                        .overlay(Capsule().strokeBorder(on || !bordered ? Color.clear : Color.chHair2))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// 90D / 6M / 1Y / All: text buttons with a gold underline on the active one.
struct RangePicker<R: Hashable & Identifiable & CustomStringConvertible>: View {
    let ranges: [R]
    @Binding var selection: R
    var body: some View {
        HStack(spacing: 18) {
            ForEach(ranges) { r in
                let on = r == selection
                Button { withAnimation(.snappy) { selection = r } } label: {
                    VStack(spacing: 5) {
                        Text(r.description).font(.inter(12, .semibold)).foregroundStyle(on ? Color.chInk : Color.chFog)
                        Rectangle().fill(on ? Color.brandGold : .clear).frame(height: 2)
                    }
                    .fixedSize()
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

/// A Texas plate as the website draws it: cream plate, dark letters, wide tracking.
struct LicensePlate: View {
    let plate: String?
    var size: CGFloat = 15
    var body: some View {
        Text(plate ?? "Plate unknown")
            .font(.inter(size, .bold))
            .tracking(size * 0.18)
            .lineLimit(1).minimumScaleFactor(0.7)   // a plate never wraps; it shrinks a little if it must
            .foregroundStyle(Color(hex: 0x141008))
            .padding(.vertical, size * 0.32).padding(.leading, size * 0.5).padding(.trailing, size * 0.32)
            .background(Color(hex: 0xF4EFE3), in: .rect(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color(hex: 0x1A1406, opacity: 0.8), lineWidth: 1.5))
            .accessibilityLabel(plate.map { "Plate \($0)" } ?? "Plate unknown")
    }
}

/// The gold-outlined CYBERCAB pill on approved Cybercabs.
struct CybercabBadge: View {
    var body: some View {
        Text("CYBERCAB")
            .font(.inter(9, .bold)).tracking(1.2)
            .foregroundStyle(Color.brandGold)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Color.brandGold.opacity(0.08), in: .capsule)
            .overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.5)))
    }
}

/// "● LIVE · UPDATED 1M AGO"
struct LiveBadge: View {
    let updated: Date?
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Color.chOK).frame(width: 6, height: 6)
            Text("LIVE" + (updated.map { " · UPDATED \(Format.ago($0).uppercased())" } ?? ""))
                .font(.inter(9, .bold)).tracking(1)
        }
        .foregroundStyle(Color.chOK)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .overlay(Capsule().strokeBorder(Color.chOK.opacity(0.4)))
    }
}

/// A loading placeholder shaped like a panel (the website's pulse skeleton).
struct PanelSkeleton: View {
    var height: CGFloat = 160
    var body: some View {
        RoundedRectangle(cornerRadius: 16).fill(Color.chSurface)
            .frame(height: height)
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.chLine))
            .overlay(ProgressView().tint(Color.chFog))
            .accessibilityLabel("Loading")
    }
}

/// An honest empty or error line inside a panel.
struct InlineMessage: View {
    let text: String
    var systemImage = "info.circle"
    var body: some View {
        Label(text, systemImage: systemImage).font(.inter(13)).foregroundStyle(Color.chFog)
    }
}
