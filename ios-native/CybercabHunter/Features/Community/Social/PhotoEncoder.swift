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

    /// The sighting form's limits (js/main.js preparePhoto; worker/sightings.js):
    /// 2560 px, JPEG 0.88, 10 MB on the server, originals up to 40 MB.
    enum Sighting {
        static let maxEdge = 2560
        static let maxBytes = 10 * 1024 * 1024
        static let maxOriginalBytes = 40 * 1024 * 1024
        static let qualities = [0.88, 0.8, 0.7]
    }

    enum Failure: Error, Equatable { case unreadable, tooLarge }

    static func jpeg(from original: Data, maxEdge: Int = maxEdge, qualities: [Double] = [0.85, 0.72, 0.6],
                     maxBytes: Int = maxBytes, maxOriginalBytes: Int = maxOriginalBytes) throws -> Data {
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
        for quality in qualities {
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw Failure.unreadable }
            // No properties besides the quality: nothing from the original's metadata is copied.
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { throw Failure.unreadable }
            if out.length <= maxBytes { return out as Data }
        }
        throw Failure.tooLarge
    }

    /// A sighting photo, prepared exactly as the website's sighting form does.
    static func sightingJPEG(from original: Data) throws -> Data {
        try jpeg(from: original, maxEdge: Sighting.maxEdge, qualities: Sighting.qualities, maxBytes: Sighting.maxBytes, maxOriginalBytes: Sighting.maxOriginalBytes)
    }
}
