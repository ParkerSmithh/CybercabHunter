import SwiftUI
import Observation

/// GET /api/dmv-registrations/vins (worker/txdmv.js): today's TxDMV
/// automated-vehicle roster for Tesla Robotaxi, LLC: exactly the source's
/// fields (VIN, make, model, model year), nothing else.
struct DMVRoster: Decodable, Sendable, Equatable {
    struct Vehicle: Decodable, Sendable, Equatable, Identifiable {
        let vin: String
        let make: String?
        let model: String?
        let modelYear: Int?
        var id: String { vin }
    }
    let total: Int
    let limit: Int
    let offset: Int
    let vehicles: [Vehicle]
}

/// The "Every VIN" page (public/dmv.html, js/dmv-vins.js): filter by model,
/// search by VIN, 100 at a time.
@MainActor
@Observable
final class DMVRosterModel {
    enum State: Equatable { case loading, ready, failed }
    static let page = 100

    var model = ""        // "", "cybercab" or "model_y"
    var query = ""
    private(set) var state: State = .loading
    private(set) var vehicles: [DMVRoster.Vehicle] = []
    private(set) var total = 0
    private(set) var loadingMore = false
    private var generation = 0

    /// The site's VIN search: letters and digits only, upper case, up to 17.
    static func cleaned(_ q: String) -> String {
        String(q.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(17))
    }

    private func items(offset: Int) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(Self.page)), URLQueryItem(name: "offset", value: String(offset))]
        if !model.isEmpty { items.append(URLQueryItem(name: "model", value: model)) }
        let q = Self.cleaned(query)
        if !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
        return items
    }

    func reload(api: APIClient) async {
        generation += 1
        let gen = generation
        state = .loading
        do {
            let r: DMVRoster = try await api.get("/api/dmv-registrations/vins", query: items(offset: 0))
            guard gen == generation else { return }
            vehicles = r.vehicles
            total = r.total
            state = .ready
        } catch is CancellationError {
        } catch { if gen == generation { state = .failed } }
    }

    func loadMore(api: APIClient) async {
        guard state == .ready, vehicles.count < total, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let gen = generation
        guard let r: DMVRoster = try? await api.get("/api/dmv-registrations/vins", query: items(offset: vehicles.count)), gen == generation else { return }
        vehicles += r.vehicles
        total = r.total
    }

    var countLine: String {
        switch state {
        case .loading: return ""
        case .failed: return "Couldn't load the roster right now."
        case .ready:
            if total > 0 { return "\(Format.int(vehicles.count)) of \(Format.int(total)) VINs" }
            return Self.cleaned(query).isEmpty ? "No roster snapshot yet." : "No VIN matches that search."
        }
    }
}

struct DMVRosterView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = DMVRosterModel()
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                Eyebrow(text: "Vehicles · Texas DMV")
                Text("EVERY VIN").displayTitle(30).accessibilityIdentifier("dmvTitle")
                Text("Every automated vehicle Tesla Robotaxi, LLC lists with the Texas DMV under its SB 2807 authorization AV8313426653583, from TxDMV's public roster as of the latest daily snapshot.")
                    .font(.inter(14)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    ForEach([("", "All"), ("cybercab", "Cybercab"), ("model_y", "Model Y")], id: \.0) { key, label in
                        PillToggle(title: label, selected: model.model == key, compact: true) { model.model = key; Task { await model.reload(api: session.api) } }
                            .accessibilityIdentifier("dmvModel-\(key.isEmpty ? "all" : key)")
                    }
                }
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Color.chFog)
                    TextField("Search VIN", text: $model.query)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .font(.system(size: 15, design: .monospaced))
                        .accessibilityIdentifier("dmvSearch")
                    if !model.query.isEmpty { Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }.accessibilityLabel("Clear search") }
                }
                .padding(.horizontal, 12).frame(minHeight: 42)
                .background(Color.chSurface, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
                .onChange(of: model.query) {
                    searchTask?.cancel()
                    searchTask = Task { try? await Task.sleep(for: .milliseconds(250)); if !Task.isCancelled { await model.reload(api: session.api) } }
                }
                Text(model.countLine).font(.inter(12.5)).foregroundStyle(Color.chFog).accessibilityIdentifier("dmvCount")
                switch model.state {
                case .loading: PanelSkeleton(height: 200)
                case .failed:
                    Button("Try again") { Task { await model.reload(api: session.api) } }.font(.inter(14, .semibold)).accessibilityIdentifier("dmvRetry")
                case .ready:
                    VStack(spacing: 0) {
                        HStack { Text("VIN"); Spacer(); Text("MODEL").frame(width: 96, alignment: .leading); Text("YEAR").frame(width: 46, alignment: .trailing) }
                            .font(.inter(10.5, .bold)).tracking(0.6).foregroundStyle(Color.chCaption)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                        ForEach(model.vehicles) { v in
                            Divider().overlay(Color.chLine)
                            HStack {
                                Text(v.vin).font(.system(size: 13, design: .monospaced)).foregroundStyle(Color.chInk).lineLimit(1).minimumScaleFactor(0.8).textSelection(.enabled)
                                Spacer(minLength: 6)
                                HStack(spacing: 5) {
                                    Circle().fill(dot(v.model)).frame(width: 7, height: 7)
                                    Text(v.model ?? "—").font(.inter(12.5)).foregroundStyle(Color.chMist).lineLimit(1)
                                }
                                .frame(width: 96, alignment: .leading)
                                Text(v.modelYear.map(String.init) ?? "—").font(.inter(12.5)).monospacedDigit().foregroundStyle(Color.chFog).frame(width: 46, alignment: .trailing)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(v.make ?? "Tesla") \(v.model ?? ""), \(v.modelYear.map(String.init) ?? ""), VIN \(v.vin)")
                            .accessibilityIdentifier("dmvRow")
                        }
                    }
                    .background(Color.chSurface, in: .rect(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
                    if model.vehicles.count < model.total {
                        Button(model.loadingMore ? "Loading…" : "Show more") { Task { await model.loadMore(api: session.api) } }
                            .font(.inter(14, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                            .disabled(model.loadingMore)
                            .accessibilityIdentifier("dmvMore")
                    }
                }
                Footnote(text: "Source: TxDMV Motor Carrier Credentialing System (TxMCCS), Tesla Robotaxi, LLC's automated motor vehicles, polled once a day. TxDMV publishes the VIN, make, model and model year; this page shows those and nothing else. A registration is not proof a car is in service.")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.reload(api: session.api) }
        .refreshable { await model.reload(api: session.api) }
    }

    private func dot(_ m: String?) -> Color {
        let s = (m ?? "").lowercased()
        return s.contains("cybercab") ? .brandGold : s.contains("model y") ? .chModelY : .chFog
    }
}
