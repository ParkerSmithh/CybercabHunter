import SwiftUI

// Compact dashboard pieces for Home's lower sections: a heading row whose
// secondary explanation hides behind an ⓘ button, a small Predict switch, and
// a tight metric grid. Same data and controls as before, less vertical space.

/// Title (with an optional city eyebrow and badge), an ⓘ that reveals the
/// section's explanation in place, and an optional trailing link.
struct CompactHeading<Trailing: View>: View {
    var city: String? = nil
    let title: String
    var badge: AnyView? = nil
    var info: String? = nil
    @ViewBuilder var trailing: () -> Trailing
    @State private var showInfo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    if let city { Eyebrow(text: city) }
                    HStack(spacing: 6) {
                        Text(title).displayTitle(16).lineLimit(2).minimumScaleFactor(0.85)
                        if info != nil {
                            Button { withAnimation(.snappy) { showInfo.toggle() } } label: {
                                Image(systemName: showInfo ? "info.circle.fill" : "info.circle")
                                    .font(.system(size: 14, weight: .medium)).foregroundStyle(Color.chFog)
                                    .frame(width: 30, height: 30).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(showInfo ? "Hide details about \(title)" : "About \(title)")
                        }
                    }
                }
                Spacer(minLength: 6)
                if let badge { badge }
                trailing()
            }
            if showInfo, let info {
                Text(info).font(.inter(12, relativeTo: .footnote)).foregroundStyle(Color.chFog)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.04), in: .rect(cornerRadius: 10))
                    .transition(.opacity)
            }
        }
    }
}

extension CompactHeading where Trailing == EmptyView {
    init(city: String? = nil, title: String, badge: AnyView? = nil, info: String? = nil) {
        self.init(city: city, title: title, badge: badge, info: info, trailing: { EmptyView() })
    }
}

/// "Predict": the Actual / Actual + Predictions choice as one small switch pill.
struct PredictToggle: View {
    @Binding var on: Bool
    var body: some View {
        Button { withAnimation(.snappy) { on.toggle() } } label: {
            HStack(spacing: 5) {
                Image(systemName: on ? "chart.line.uptrend.xyaxis.circle.fill" : "chart.line.uptrend.xyaxis.circle")
                Text("Predict")
            }
            .font(.inter(12, .semibold))
            .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
            .padding(.horizontal, 10).frame(height: 30)
            .background(on ? Color.brandGold : Color.clear, in: .capsule)
            .overlay(Capsule().strokeBorder(on ? Color.clear : Color.chHair2))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(on ? "Showing actual and predictions" : "Showing actual only")
        .accessibilityHint("Turns predictions on or off")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("predictToggle")
    }
}

/// A small uppercase group label inside a panel.
struct GroupLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.inter(10.5, .semibold)).tracking(0.6).foregroundStyle(Color.chFog)
    }
}
