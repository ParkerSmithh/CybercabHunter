import Foundation

// Receipts shared to Cybercab Hunter from the Share Sheet (a PDF, a photo or
// screenshot of a receipt, or receipt text) wait here, in the App Group the app
// and the share extension share, until the app's Import Receipt screen takes
// one. Compiled into both. Nothing is uploaded from the extension: the rider
// reviews the receipt in the app first, and only then is it imported.
//
// A share is two files in ReceiptShares/: the receipt exactly as shared
// (<id>.bin), then <id>.json (written last, so a half-written share is never
// offered). Taking a share deletes both; anything older than `lifetime`, or
// left unfinished, is deleted.
enum ReceiptShareInbox {
    static let appGroup = SightingShareInbox.appGroup
    static let lifetime: TimeInterval = 3 * 24 * 3600
    /// Large enough for a multi-page PDF receipt, far below the extension's memory limit.
    static let maxBytes = 15 * 1024 * 1024
    static let notificationKey = "receiptShare"
    static func notificationID(_ id: UUID) -> String { "receipt-share-\(id.uuidString)" }

    enum Kind: String, Codable, Sendable { case pdf, image, text }
    struct Share: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let createdAt: Date
        let kind: Kind
        /// Further items shared alongside this one and not kept (one receipt at a time).
        let skipped: Int
    }
    enum Failure: Error, Equatable { case unavailable, tooLarge, unsupported, empty }

    static func folder(root: URL? = nil) -> URL? {
        guard let base = root ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let dir = base.appending(path: "ReceiptShares", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return dir
    }

    /// What a shared item is, from its bytes (never its name): PDF, an image
    /// format iOS can read, or UTF-8 text.
    static func kind(of data: Data) -> Kind? {
        guard !data.isEmpty else { return nil }
        if data.starts(with: Array("%PDF".utf8)) { return .pdf }
        let head = [UInt8](data.prefix(12))
        let isJPEG = head.starts(with: [0xFF, 0xD8, 0xFF])
        let isPNG = head.starts(with: [0x89, 0x50, 0x4E, 0x47])
        let isHEIC = head.count >= 12 && String(bytes: head[4..<8], encoding: .ascii) == "ftyp"
        if isJPEG || isPNG || isHEIC { return .image }
        if let text = String(data: data.prefix(4096), encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .text }
        return nil
    }

    static func check(_ data: Data) -> Failure? {
        if data.isEmpty { return .empty }
        if data.count > maxBytes { return .tooLarge }
        return kind(of: data) == nil ? .unsupported : nil
    }

    @discardableResult
    static func save(_ data: Data, skipped: Int = 0, now: Date = .now, root: URL? = nil) throws -> Share {
        if let failure = check(data) { throw failure }
        guard let dir = folder(root: root) else { throw Failure.unavailable }
        let share = Share(id: UUID(), createdAt: now, kind: kind(of: data)!, skipped: skipped)
        try data.write(to: dir.appending(path: "\(share.id.uuidString).bin"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try JSONEncoder().encode(share).write(to: dir.appending(path: "\(share.id.uuidString).json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return share
    }

    static func pending(now: Date = .now, root: URL? = nil) -> [Share] {
        cleanUp(now: now, root: root)
        guard let dir = folder(root: root), let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path()) else { return [] }
        return names.filter { $0.hasSuffix(".json") }
            .compactMap { try? JSONDecoder().decode(Share.self, from: Data(contentsOf: dir.appending(path: $0))) }
            .filter { FileManager.default.fileExists(atPath: dir.appending(path: "\($0.id.uuidString).bin").path()) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// The app's side, while the rider reviews it: the bytes, left in place.
    static func read(_ id: UUID, root: URL? = nil) -> Data? {
        guard let dir = folder(root: root) else { return nil }
        return try? Data(contentsOf: dir.appending(path: "\(id.uuidString).bin"))
    }

    /// The bytes, removed from the inbox.
    static func take(_ id: UUID, root: URL? = nil) -> Data? {
        guard let dir = folder(root: root) else { return nil }
        let data = try? Data(contentsOf: dir.appending(path: "\(id.uuidString).bin"))
        discard(id, root: root)
        return data
    }

    static func discard(_ id: UUID, root: URL? = nil) {
        guard let dir = folder(root: root) else { return }
        try? FileManager.default.removeItem(at: dir.appending(path: "\(id.uuidString).json"))
        try? FileManager.default.removeItem(at: dir.appending(path: "\(id.uuidString).bin"))
    }

    static func cleanUp(now: Date = .now, root: URL? = nil) {
        guard let dir = folder(root: root), let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path()) else { return }
        let fm = FileManager.default
        for name in names {
            let url = dir.appending(path: name)
            let id = (name as NSString).deletingPathExtension
            let manifest = dir.appending(path: "\(id).json"), file = dir.appending(path: "\(id).bin")
            let created = (try? fm.attributesOfItem(atPath: url.path())[.creationDate] as? Date) ?? .distantPast
            let expired = now.timeIntervalSince(created) > lifetime
            let orphan = name.hasSuffix(".bin") && !fm.fileExists(atPath: manifest.path()) && now.timeIntervalSince(created) > 60
            let empty = name.hasSuffix(".json") && !fm.fileExists(atPath: file.path())
            if expired || orphan || empty || !(name.hasSuffix(".bin") || name.hasSuffix(".json")) { try? fm.removeItem(at: url) }
        }
    }
}
