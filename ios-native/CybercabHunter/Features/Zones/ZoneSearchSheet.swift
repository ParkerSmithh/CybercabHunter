import SwiftUI

/// The Zones place search as a bottom sheet (Apple Maps' pattern): a medium
/// sheet over the live map with the search field on top; drag up for more
/// results, down to close. Empty, it offers recent places, the two cities and
/// the city's charging locations; typing (3+ letters) asks GET /api/places/map,
/// which only returns places inside the selected city's service area.
struct ZoneSearchSheet: View {
    let city: WebData.City
    let api: APIClient
    /// A chosen place: the map flies there (and pins it, unless it's a known spot).
    let onPick: (PlaceResults.Place) -> Void
    /// A city row: switch the map to that city.
    let onCity: (String) -> Void
    let pinned: PlaceResults.Place?
    let onClearPin: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [PlaceResults.Place] = []
    @State private var state: SearchState = .idle
    @State private var recents: [PlaceResults.Place] = []
    @Binding var detent: PresentationDetent
    @FocusState private var focused: Bool

    enum SearchState: Equatable { case idle, searching, done, failed(String) }

    var body: some View {
        // A navigation container (bar hidden) so the keyboard can carry its Done button.
        NavigationStack { content.toolbar(.hidden, for: .navigationBar) }
    }

    private var content: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 10)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if query.trimmingCharacters(in: .whitespaces).count >= 3 { resultsSection } else { suggestions }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.immediately)
        }
        .task(id: query) { await search() }
        .onAppear { recents = RecentPlaces.load(city.key) }
        .onDisappear { focused = false }
        // Typing needs room above the keyboard: the sheet rises to full height.
        .onChange(of: focused) { _, on in if on { withAnimation(.snappy) { detent = .large } } }
        .onChange(of: detent) { _, d in if d != .large { focused = false } }
        .background(Color.clear)
    }

    // MARK: Field

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 17, weight: .medium)).foregroundStyle(Color.chFog)
            TextField("Search \(city.name) places", text: $query)
                .font(.inter(17))
                .foregroundStyle(Color.chInk)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($focused)
                .onSubmit { focused = false }
                .accessibilityIdentifier("zoneSearchField")
            if !query.isEmpty {
                Button { query = ""; results = []; state = .idle } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 17)).foregroundStyle(Color.chFog)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, 14).padding(.trailing, 6)
        .frame(height: 48)
        .background(Color.white.opacity(0.08), in: .capsule)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focused = false }.fontWeight(.semibold).accessibilityIdentifier("zoneSearchDone")
            }
        }
    }

    // MARK: Empty: recents, cities, charging

    @ViewBuilder private var suggestions: some View {
        if let pinned {
            section("On the map") {
                row(icon: "mappin.circle.fill", tint: .brandGold, title: pinned.label, subtitle: "Pinned place") { onPick(pinned); close() }
                row(icon: "xmark.circle", tint: .chFog, title: "Remove pin", subtitle: nil) { onClearPin(); close() }
                    .accessibilityIdentifier("zoneRemovePin")
            }
        }
        if !recents.isEmpty {
            section("Recents", action: ("Clear", { RecentPlaces.clear(city.key); recents = [] })) {
                ForEach(recents) { p in
                    row(icon: "clock.fill", tint: .chFog, title: p.label, subtitle: city.name) { choose(p) }
                        .accessibilityIdentifier("zoneRecent")
                }
            }
        }
        section("Service areas") {
            ForEach(WebData.zones.cities) { c in
                row(icon: "map.fill", tint: .brandGold, title: c.name, subtitle: c.key == city.key ? "Current city · whole service zone" : "Switch the map to \(c.name)") {
                    onCity(c.key); close()
                }
                .accessibilityIdentifier("zoneCity-\(c.key)")
            }
        }
        if !city.charging.isEmpty {
            section("Charging locations") {
                ForEach(city.charging) { c in
                    row(icon: "bolt.fill", tint: .brandGold, title: c.name, subtitle: c.note) {
                        onPick(PlaceResults.Place(id: "spot:\(c.name)", label: c.name, lat: c.lat, lng: c.lng)); close()
                    }
                }
            }
        }
        Text("Search finds streets, addresses and landmarks inside the \(city.name) service area. Type at least 3 letters.")
            .font(.inter(12)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Results

    @ViewBuilder private var resultsSection: some View {
        switch state {
        case .idle, .searching:
            HStack(spacing: 10) { ProgressView().tint(Color.chFog); Text("Searching \(city.name)…").font(.inter(14)).foregroundStyle(Color.chFog) }
                .padding(.top, 8)
        case .failed(let message):
            InlineMessage(text: message, systemImage: "wifi.exclamationmark")
        case .done where results.isEmpty:
            VStack(alignment: .leading, spacing: 6) {
                Text("No places found").font(.inter(16, .semibold)).foregroundStyle(Color.chInk)
                Text("Search only covers the \(city.name) service area. Try a street, an address or a landmark there.")
                    .font(.inter(13)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 8)
            .accessibilityIdentifier("zoneSearchEmpty")
        case .done:
            section("Places in \(city.name)") {
                ForEach(results) { p in
                    let parts = p.label.split(separator: ",", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                    row(icon: "mappin.circle.fill", tint: Color(hex: 0xF08A84), title: parts.first ?? p.label, subtitle: parts.count > 1 ? parts[1] : nil) { choose(p) }
                        .accessibilityIdentifier("zonePlaceSuggestion")
                }
            }
        }
    }

    // MARK: Pieces

    private func section<C: View>(_ title: String, action: (String, () -> Void)? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.inter(15, .bold)).foregroundStyle(Color.chInk)
                Spacer()
                if let action { Button(action.0, action: action.1).font(.inter(14, .medium)).tint(.brandGold) }
            }
            VStack(spacing: 0) { content() }
                .background(Color.white.opacity(0.06), in: .rect(cornerRadius: 14))
        }
    }

    private func row(icon: String, tint: Color, title: String, subtitle: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(tint)
                    .frame(width: 34, height: 34).background(Color.white.opacity(0.08), in: .circle)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.inter(15, .medium)).foregroundStyle(Color.chInk).lineLimit(1)
                    if let subtitle { Text(subtitle).font(.inter(12.5)).foregroundStyle(Color.chFog).lineLimit(1) }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ p: PlaceResults.Place) {
        RecentPlaces.add(p, city: city.key)
        onPick(p)
        close()
    }

    private func close() {
        focused = false
        dismiss()
    }

    /// The existing search: 3+ letters, 250 ms after typing stops, the selected city only.
    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3 else { results = []; state = .idle; return }
        state = .searching
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        var items = [URLQueryItem(name: "v", value: "2"), URLQueryItem(name: "q", value: String(q.prefix(100)))]
        if city.key != "austin" { items.append(URLQueryItem(name: "area", value: city.key)) }
        do {
            let r: PlaceResults = try await api.get("/api/places/map", query: items)
            guard !Task.isCancelled else { return }
            results = Array(r.places.prefix(8)); state = .done
        } catch is CancellationError {
        } catch APIError.http(429, _) {
            state = .failed("Too many searches. Try again in a minute.")
        } catch {
            state = .failed("Search isn't available right now.")
        }
    }
}

/// Recently chosen places, on this iPhone only (UserDefaults), per city: the
/// place's name and coordinates, nothing else. At most 6.
enum RecentPlaces {
    private struct Stored: Codable { let id: String; let label: String; let lat: Double; let lng: Double }
    private static func key(_ city: String) -> String { "zoneRecentPlaces.\(city)" }

    static func load(_ city: String) -> [PlaceResults.Place] {
        guard let data = UserDefaults.standard.data(forKey: key(city)),
              let list = try? JSONDecoder().decode([Stored].self, from: data) else { return [] }
        return list.map { PlaceResults.Place(id: $0.id, label: $0.label, lat: $0.lat, lng: $0.lng) }
    }

    static func add(_ p: PlaceResults.Place, city: String) {
        var list = load(city).filter { $0.id != p.id }
        list.insert(p, at: 0)
        let stored = list.prefix(6).map { Stored(id: $0.id, label: $0.label, lat: $0.lat, lng: $0.lng) }
        UserDefaults.standard.set(try? JSONEncoder().encode(Array(stored)), forKey: key(city))
    }

    static func clear(_ city: String) { UserDefaults.standard.removeObject(forKey: key(city)) }
}
