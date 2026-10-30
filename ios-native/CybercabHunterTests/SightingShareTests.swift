import Testing
import Foundation
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import CybercabHunter

// Take Photo and Share to Cybercab Hunter: the Share extension's inbox (in the
// App Group), the hand-off to the Submit a sighting form, and that shared and
// camera photos go through the form's own photo preparation.

private func image(_ type: UTType, size: CGSize = CGSize(width: 1600, height: 1200), gps: Bool = false) -> Data? {
    let cg = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { ctx in
        UIColor.systemYellow.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
    }.cgImage!
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
    var props: [CFString: Any] = [:]
    if gps { props[kCGImagePropertyGPSDictionary] = [kCGImagePropertyGPSLatitude: 30.2672, kCGImagePropertyGPSLongitude: 97.7431, kCGImagePropertyGPSLongitudeRef: "W", kCGImagePropertyGPSLatitudeRef: "N"] }
    CGImageDestinationAddImage(dest, cg, props as CFDictionary)
    return CGImageDestinationFinalize(dest) ? out as Data : nil
}

private func tempRoot() -> URL {
    let u = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

@MainActor
@Suite(.serialized)
struct SightingShareTests {

    @Test func theInboxKeepsASharedPhotoOnceAndCleansUp() throws {
        let root = tempRoot()
        let jpeg = try #require(image(.jpeg))
        let share = try SightingShareInbox.save(jpeg, skipped: 2, root: root)
        #expect(SightingShareInbox.pending(root: root) == [share] && share.skipped == 2)
        #expect(SightingShareInbox.take(share.id, root: root) == jpeg, "the photo exactly as shared")
        #expect(SightingShareInbox.take(share.id, root: root) == nil && SightingShareInbox.pending(root: root).isEmpty, "taken once: never imported twice")
        // Discarded or abandoned shares go.
        let other = try SightingShareInbox.save(jpeg, root: root)
        SightingShareInbox.discard(other.id, root: root)
        #expect(SightingShareInbox.pending(root: root).isEmpty)
        _ = try SightingShareInbox.save(jpeg, root: root)
        #expect(SightingShareInbox.pending(now: .now.addingTimeInterval(SightingShareInbox.lifetime + 60), root: root).isEmpty, "not attached within three days: deleted")
        let dir = try #require(SightingShareInbox.folder(root: root))
        #expect((try FileManager.default.contentsOfDirectory(atPath: dir.path())).isEmpty, "and its files with it")
        // A share interrupted before its manifest is never offered, and is removed.
        try jpeg.write(to: dir.appending(path: "\(UUID().uuidString).img"))
        #expect(SightingShareInbox.pending(now: .now.addingTimeInterval(120), root: root).isEmpty)
        #expect((try FileManager.default.contentsOfDirectory(atPath: dir.path())).isEmpty)
    }

    @Test func jpegPngAndHeicAreAcceptedAndBadFilesExplained() throws {
        let root = tempRoot()
        for type in [UTType.jpeg, .png, .heic] {
            guard let data = image(type) else { continue }   // a simulator without a HEIC encoder skips HEIC
            #expect(SightingShareInbox.check(data) == nil, "\(type.identifier) is accepted")
        }
        #expect(SightingShareInbox.check(Data("not a photo".utf8)) == .unreadable)
        #expect(throws: SightingShareInbox.Failure.unreadable) { try SightingShareInbox.save(Data("not a photo".utf8), root: root) }
        #expect(SightingShareInbox.check(Data(count: SightingShareInbox.maxBytes + 1)) == .tooLarge, "over the form's 40 MB original limit")
        #expect(SightingShareInbox.pending(root: root).isEmpty, "a refused photo leaves nothing behind")
    }

    @Test func theAppGroupIsAvailableToTheApp() {
        #expect(SightingShareInbox.folder() != nil, "the App Group container the Share extension writes to")
    }

    @Test func aSharedPhotoOpensTheSightingFormOnce() throws {
        for s in SightingShareInbox.pending() { SightingShareInbox.discard(s.id) }
        let r = AppRouter()
        r.openSharedSighting()
        #expect(r.sharedSighting == nil && !r.submitSightingRequested, "nothing shared: nothing opens")
        let share = try SightingShareInbox.save(try #require(image(.png)))
        defer { SightingShareInbox.discard(share.id) }
        r.openSharedSighting()
        #expect(r.sharedSighting == share && r.submitSightingRequested && r.selectedTab == .sightings)
        r.submitSightingRequested = false
        r.openSharedSighting()
        #expect(!r.submitSightingRequested, "already being attached: not offered again")
    }

    @Test func sharedAndCameraPhotosGoThroughTheFormsOwnPreparation() async throws {
        let model = SubmitSightingModel()
        // A large HEIC (or PNG) with GPS, as Photos shares it: the form's JPEG, resized, with no location.
        let shared = try #require(image(.heic, size: CGSize(width: 4032, height: 3024), gps: true) ?? image(.png, size: CGSize(width: 4032, height: 3024)))
        await model.setPhoto(shared)
        let jpeg = try #require(model.photo)
        let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
        #expect(max(props[kCGImagePropertyPixelWidth] as? Int ?? 0, props[kCGImagePropertyPixelHeight] as? Int ?? 0) <= 2560, "the form's 2,560 px limit")
        #expect(props[kCGImagePropertyGPSDictionary] == nil, "no location metadata is uploaded")
        #expect(model.preview != nil && model.photoError == nil)
        // A camera photo arrives as JPEG data: same path, same result.
        let camera = try #require(UIGraphicsImageRenderer(size: CGSize(width: 3024, height: 4032)).image { _ in }.jpegData(compressionQuality: 0.95))
        model.removePhoto()
        await model.setPhoto(camera)
        #expect(model.photo != nil && model.photoError == nil)
        // An unreadable shared file: the form's own message.
        model.removePhoto()
        await model.setPhoto(Data("not a photo".utf8))
        #expect(model.photo == nil && model.photoError == SubmitSightingModel.errors["unsupported_file_type"])
    }

    @Test func theCameraAsksOnlyForTheCamera() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String != nil, "the camera permission explains itself")
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") == nil, "photos only: no microphone")
    }
}
