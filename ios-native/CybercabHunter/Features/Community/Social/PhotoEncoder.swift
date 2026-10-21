import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Prepares a picked photo the way the website's composer does (social.js
/// compress): redrawn at most 2048 px on the long side and re-encoded as JPEG
/// at 0.85 / 0.72 / 0.6 until it fits 5 MB. The new file carries only pixels:
/// no EXIF, GPS or other metadata leaves the phone (the server strips it again).
enum PhotoEncoder {
    static let maxEdge = 2048
    static let maxBytes = 5 * 1024 * 1024
    /// The website refuses originals over 25 MB before compressing.
    static let maxOriginalBytes = 25 * 1024 * 1024

    enum Failure: Error, Equatable { case unreadable, tooLarge }

    static func jpeg(from original: Data) throws -> Data {
        guard original.count <= maxOriginalBytes else { throw Failure.tooLarge }
        guard let source = CGImageSourceCreateWithData(original as CFData, nil) else { throw Failure.unreadable }
        // The thumbnail API applies the EXIF orientation and scales in one decode.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw Failure.unreadable }
        for quality in [0.85, 0.72, 0.6] {
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw Failure.unreadable }
            // No properties besides the quality: nothing from the original's metadata is copied.
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { throw Failure.unreadable }
            if out.length <= maxBytes { return out as Data }
        }
        throw Failure.tooLarge
    }
}
