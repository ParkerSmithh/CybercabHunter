import Foundation
import Observation

/// Saved Fleet ROI configurations, on this device only (UserDefaults; the
/// website keeps its own in localStorage under the same key and JSON shape).
/// No account, server or sync. Save, rename, duplicate, delete; items are
/// re-checked with `Input.sanitized` whenever they're read.
@MainActor
@Observable
final class FleetROIStore {
    static let key = "cchFleetRoiSaved.v1"

    struct Item: Codable, Identifiable, Equatable, Hashable {
        let id: String
        var name: String
        var input: FleetROI.Input
        var savedAt: String
    }

    private(set) var items: [Item] = []
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        items = Self.read(defaults)
    }

    /// A broken store reads as empty; a broken entry is skipped.
    private static func read(_ d: UserDefaults) -> [Item] {
        guard let data = d.data(forKey: key) ?? d.string(forKey: key)?.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return raw.compactMap { entry in
            guard let o = entry as? [String: Any], let id = o["id"] as? String, let name = o["name"] as? String, let input = o["input"],
                  let inputData = try? JSONSerialization.data(withJSONObject: input),
                  let x = try? JSONDecoder().decode(FleetROI.Input.self, from: inputData) else { return nil }
            return Item(id: id, name: name, input: x.sanitized, savedAt: o["savedAt"] as? String ?? "")
        }
    }

    private func write() {
        if let data = try? JSONEncoder().encode(items) { defaults.set(data, forKey: Self.key) }
    }

    private static func clean(_ name: String) -> String {
        let s = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return s.isEmpty ? "Untitled configuration" : String(s.prefix(60))
    }
    private static func newID() -> String { "cfg-" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + "-" + String(UUID().uuidString.prefix(5)).lowercased() }
    private static func now() -> String { ISO8601DateFormatter().string(from: .now) }

    @discardableResult
    func save(name: String, input: FleetROI.Input) -> Item? {
        let item = Item(id: Self.newID(), name: Self.clean(name), input: input.sanitized, savedAt: Self.now())
        items.insert(item, at: 0)
        write()
        return item
    }

    func rename(_ id: String, to name: String) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].name = Self.clean(name)
        write()
    }

    @discardableResult
    func duplicate(_ id: String) -> Item? {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return nil }
        let copy = Item(id: Self.newID(), name: Self.clean(items[i].name + " copy"), input: items[i].input, savedAt: Self.now())
        items.insert(copy, at: i + 1)
        write()
        return copy
    }

    func delete(_ id: String) {
        items.removeAll { $0.id == id }
        write()
    }

    /// "Nov 13"
    static func savedLabel(_ iso: String) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        return d.map { $0.formatted(.dateTime.month(.abbreviated).day()) } ?? ""
    }
}
