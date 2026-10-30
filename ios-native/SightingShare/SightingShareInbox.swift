import Foundation
import ImageIO

// Photos shared to Cybercab Hunter from the Share Sheet (the
// CybercabHunterShare extension) wait here, in the App Group container the
// app and the extension share, until the app attaches one to its Submit a
// sighting form. Compiled into both. Nothing here is uploaded, and no
// credentials are involved: the form uploads only when the rider submits.
//
// A share is two files in SightingShares/: the photo exactly as shared
// (<id>.img), then <id>.json, written last, which commits it (so a share
// interrupted half-way is never offered). Taking a share deletes both, so it
// is attached once; anything older than `lifetime`, and anything left
// unfinished, is deleted.
enum SightingShareInbox {
    static let appGroup = "group.com.cybercabhunter.native"
    /// Shared photos not attached within three days are deleted.
    static let lifetime: TimeInterval = 3 * 24 * 3600
    /// The form's own limit on an original photo (PhotoEncoder.Sighting.maxOriginalBytes).
    static let maxBytes = 40 * 1024 * 1024
    /// One photo per sighting: further shared photos are counted, not kept.
    static let maxPhotos = 1

    struct Share: Codable, Equatable, Sendable, Identifiable {
        let id: UUID
        let createdAt: Date
        /// Photos shared alongside this one and not kept (one per sighting).
        let skipped: Int
    }

    enum Failure: Error, Equatable { case unavailable, tooLarge, unreadable }

    /// The "Finish your Cybercab sighting" notification for a share (tapping it
    /// opens the app, which attaches the photo); removed once it is attached.
    static func notificationID(_ id: UUID) -> String { "sighting-share-\(id.uuidString)" }
    static let notificationKey = "sightingShare"

    /// The App Group folder, or nil when this build has no App Group (then sharing is off).
    static func folder(root: URL? = nil) -> URL? {
        guard let base = root ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let dir = base.appending(path: "SightingShares", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return dir
    }

    /// Checks a shared photo the way the form will (size, a readable image).
    static func check(_ data: Data) -> Failure? {
        if data.count > maxBytes { return .tooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) != nil else { return .unreadable }
        return nil
    }

    /// The extension's side: keep one photo for the app.
    @discardableResult
    static func save(_ data: Data, skipped: Int = 0, now: Date = .now, root: URL? = nil) throws -> Share {
        if let failure = check(data) { throw failure }
        guard let dir = folder(root: root) else { throw Failure.unavailable }
        let share = Share(id: UUID(), createdAt: now, skipped: skipped)
        try data.write(to: dir.appending(path: "\(share.id.uuidString).img"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try JSONEncoder().encode(share).write(to: dir.appending(path: "\(share.id.uuidString).json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return share
    }

    /// Shares waiting for the app, oldest first (expired ones are cleaned up first).
    static func pending(now: Date = .now, root: URL? = nil) -> [Share] {
        cleanUp(now: now, root: root)
        guard let dir = folder(root: root), let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path()) else { return [] }
        return names.filter { $0.hasSuffix(".json") }
            .compactMap { try? JSONDecoder().decode(Share.self, from: Data(contentsOf: dir.appending(path: $0))) }
            .filter { FileManager.default.fileExists(atPath: dir.appending(path: "\($0.id.uuidString).img").path()) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// The app's side: the photo, removed from the inbox (so it is attached once).
    static func take(_ id: UUID, root: URL? = nil) -> Data? {
        guard let dir = folder(root: root) else { return nil }
        let photo = dir.appending(path: "\(id.uuidString).img")
        let data = try? Data(contentsOf: photo)
        discard(id, root: root)
        return data
    }

    static func discard(_ id: UUID, root: URL? = nil) {
        guard let dir = folder(root: root) else { return }
        try? FileManager.default.removeItem(at: dir.appending(path: "\(id.uuidString).json"))
        try? FileManager.default.removeItem(at: dir.appending(path: "\(id.uuidString).img"))
    }

    /// Deletes expired shares and any half-written files.
    static func cleanUp(now: Date = .now, root: URL? = nil) {
        guard let dir = folder(root: root), let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path()) else { return }
        let fm = FileManager.default
        for name in names {
            let url = dir.appending(path: name)
            let id = (name as NSString).deletingPathExtension
            let manifest = dir.appending(path: "\(id).json"), photo = dir.appending(path: "\(id).img")
            let created = (try? fm.attributesOfItem(atPath: url.path())[.creationDate] as? Date) ?? .distantPast
            let expired = now.timeIntervalSince(created) > lifetime
            // An image without its manifest is an interrupted share; keep it a minute in case it is being written.
            let orphan = name.hasSuffix(".img") && !fm.fileExists(atPath: manifest.path()) && now.timeIntervalSince(created) > 60
            let empty = name.hasSuffix(".json") && !fm.fileExists(atPath: photo.path())
            if expired || orphan || empty || !(name.hasSuffix(".img") || name.hasSuffix(".json")) { try? fm.removeItem(at: url) }
        }
    }
}
