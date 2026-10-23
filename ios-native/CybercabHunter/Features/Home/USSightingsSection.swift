import SwiftUI

/// "Cybercab sightings across the US" (the website's js/us-sightings-map.js):
/// a fixed picture of the US (Census state outlines, already projected), the
/// states with a reported sighting in gold and each city as a dot sized by its
/// logged sightings; Dots or Heatmap; the cities grouped by state, busiest
/// first; community data, credited. Drawn natively with Canvas from the
/// website's own data (Resources/WebData/us-map.json).
struct USSightingsSection: View {
    enum View2: String, CaseIterable, Identifiable { case dots = "Dots", heat = "Heatmap"; var id: String { rawValue } }
    @State private var mode: View2 = .dots
    @State private var showAll = false
    private let map = WebData.usMap
    private static let paths: [String: Path] = Dictionary(uniqueKeysWithValues: WebData.usMap.states.map { ($0.id, USSightingsSection.parse($0.d)) })

    var body: some View {
        let sighted = Set(map.sighted)
        let byState = Dictionary(grouping: map.cities, by: \.st).mapValues { $0.sorted { ($0.n ?? 0, $1.name) > ($1.n ?? 0, $0.name) } }
        let stateOrder = byState.keys.sorted { (byState[$0]!.count, total(byState[$0]!)) > (byState[$1]!.count, total(byState[$1]!)) }
        VStack(alignment: .leading, spacing: 12) {
            CompactHeading(title: "Cybercab sightings across the US",
                           info: "Every state and city where a Cybercab has been reported. Community-reported sightings, credited below the list; not verified by Cybercab Hunter. Map: US Census state boundaries.")
            // The two totals and the Dots / Heatmap switch on one row.
            HStack(alignment: .bottom, spacing: 18) {
                Metric(label: "States", value: "\(sighted.subtracting(["DC"]).count)", unit: sighted.contains("DC") ? "+ DC" : nil, valueColor: .brandGold, size: 22)
                    .fixedSize()
                Metric(label: "Cities", value: Format.int(map.cities.count), size: 22).fixedSize()
                Spacer(minLength: 0)
                HStack(spacing: 0) {
                    ForEach(View2.allCases) { m in
                        Button(m.rawValue) { withAnimation(.snappy) { mode = m } }.buttonStyle(PillButtonStyle(on: mode == m))
                    }
                }
            }
            Canvas { ctx, size in draw(&ctx, size: size, sighted: sighted) }
                .aspectRatio(975.0 / 610.0, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 190)
                .accessibilityLabel("Map of the US: \(sighted.count) states and \(map.cities.count) cities with reported Cybercab sightings")
            legend
            // The busiest three states; the full list opens in a sheet.
            VStack(spacing: 0) {
                ForEach(Array(stateOrder.prefix(3).enumerated()), id: \.element) { i, st in
                    if i > 0 { Rectangle().fill(Color.chInk.opacity(0.06)).frame(height: 1) }
                    stateRow(st, cities: byState[st]!)
                }
            }
            if stateOrder.count > 3 {
                Button { showAll = true } label: {
                    HStack(spacing: 4) { Text("All \(stateOrder.count) states and \(map.cities.count) cities"); Image(systemName: "chevron.right").font(.caption.weight(.semibold)) }
                        .font(.inter(13, .semibold)).foregroundStyle(Color.brandGold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("usAllStates")
            }
        }
        .dataPanel(padding: 14)
        .sheet(isPresented: $showAll) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(stateOrder.enumerated()), id: \.element) { i, st in
                            if i > 0 { Rectangle().fill(Color.chInk.opacity(0.06)).frame(height: 1) }
                            stateRow(st, cities: byState[st]!, all: true)
                        }
                        sources.padding(.top, 16)
                    }
                    .padding(16)
                }
                .appBackground()
                .navigationTitle("Sightings by state")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showAll = false } } }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    /// A state: name, city count, and its busiest cities (all of them in the sheet).
    private func stateRow(_ st: String, cities: [WebData.USMap.USCity], all: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(map.states.first { $0.id == st }?.name ?? st).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                Spacer()
                Text(Format.plural(cities.count, "city", "cities")).font(.inter(12)).monospacedDigit().foregroundStyle(Color.chFog)
            }
            let shown = all ? cities.count : 3
            let names = cities.prefix(shown).map(\.name).joined(separator: " · ")
            (Text(names).foregroundStyle(Color.chFog) + Text(cities.count > shown ? " +\(cities.count - shown) more" : "").foregroundStyle(Color.brandGold))
                .font(.inter(11.5)).lineLimit(all ? nil : 1)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private func total(_ cities: [WebData.USMap.USCity]) -> Int { cities.reduce(0) { $0 + ($1.n ?? 0) } }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, sighted: Set<String>) {
        let scale = size.width / 975
        ctx.scaleBy(x: scale, y: scale)
        let line = Color.chSmoke
        if mode == .dots {
            for s in map.states {
                guard let path = Self.paths[s.id] else { continue }
                ctx.fill(path, with: .color(sighted.contains(s.id) ? Color.brandGold.opacity(0.22) : Color.chSurface2))
                ctx.stroke(path, with: .color(line), lineWidth: 0.8 / scale)
            }
            for c in map.cities {
                let r = c.n.map { 2.6 + Double($0).squareRoot() * 1.1 } ?? 3.2
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)), with: .color(Color.brandGold.opacity(0.85)))
            }
        } else {
            // Cold to warm: unsighted states coldest, sighted cool, warmer around cities by logged sightings.
            for s in map.states {
                guard let path = Self.paths[s.id] else { continue }
                ctx.fill(path, with: .color(sighted.contains(s.id) ? Color(hex: 0x1D4E89) : Color(hex: 0x111827)))
            }
            var heat = ctx
            heat.blendMode = .plusLighter
            for c in map.cities {
                let r = 14 + Double(c.n ?? 1).squareRoot() * 5
                heat.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                          with: .radialGradient(Gradient(colors: [Color(hex: 0xFF4500).opacity(0.55), Color.brandGold.opacity(0.3), .clear]), center: CGPoint(x: c.x, y: c.y), startRadius: 0, endRadius: r))
            }
            for s in map.states { if let path = Self.paths[s.id] { ctx.stroke(path, with: .color(line), lineWidth: 0.8 / scale) } }
        }
    }

    @ViewBuilder private var legend: some View {
        if mode == .dots {
            HStack(spacing: 10) {
                Label { Text("Sightings reported") } icon: { RoundedRectangle(cornerRadius: 2).fill(Color.brandGold.opacity(0.4)).frame(width: 12, height: 10) }
                Label { Text("None reported") } icon: { RoundedRectangle(cornerRadius: 2).fill(Color.chSurface2).frame(width: 12, height: 10) }
                Label { Text("City (larger: more)") } icon: { Circle().fill(Color.brandGold).frame(width: 8, height: 8) }
            }
            .font(.inter(10)).foregroundStyle(Color.chFog)
        } else {
            HStack(spacing: 6) {
                Text("Colder (none reported)").font(.inter(10)).foregroundStyle(Color.chFog)
                LinearGradient(colors: [Color(hex: 0x111827), Color(hex: 0x1D4E89), Color.brandGold, Color(hex: 0xFF4500)], startPoint: .leading, endPoint: .trailing).frame(height: 6).clipShape(.capsule)
                Text("Warmer (more sightings)").font(.inter(10)).foregroundStyle(Color.chFog)
            }
        }
    }

    private var sources: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Community-reported sightings, credited:").font(.inter(11)).foregroundStyle(Color.chCaption)
            ForEach(map.sources) { src in
                if let url = URL(string: src.url) {
                    Link("\(src.name) — \(src.what) (\(src.date))", destination: url).font(.inter(11)).foregroundStyle(Color.brandGold)
                }
            }
            Text("Not verified by Cybercab Hunter. Map: US Census state boundaries.").font(.inter(10)).foregroundStyle(Color.chCaption)
        }
    }

    /// The site's state outlines use absolute M / L / Z only.
    static func parse(_ d: String) -> Path {
        var path = Path()
        var command: Character = "M"
        var numbers: [Double] = []
        func flush() {
            var i = 0
            while i + 1 < numbers.count {
                let p = CGPoint(x: numbers[i], y: numbers[i + 1])
                if command == "M" && i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                i += 2
            }
            numbers.removeAll()
        }
        var token = ""
        for ch in d {
            if ch == "M" || ch == "L" || ch == "Z" {
                if !token.isEmpty, let v = Double(token) { numbers.append(v) }
                token = ""
                flush()
                if ch == "Z" { path.closeSubpath() }
                command = ch
            } else if ch == "," || ch == " " {
                if !token.isEmpty, let v = Double(token) { numbers.append(v) }
                token = ""
            } else {
                token.append(ch)
            }
        }
        if !token.isEmpty, let v = Double(token) { numbers.append(v) }
        flush()
        return path
    }
}
