import Testing
import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreLocation
@testable import CybercabHunter

/// "Location found in photo" (PhotoLocation, SubmitSightingModel): the photo's
/// saved GPS suggests a nearby verified place; it's read on the phone, never
/// uploaded, never applied without the rider confirming, and never replaces a
/// place the rider chose.
@MainActor
struct PhotoLocationTests {
    /// A small JPEG with the given GPS dictionary (nil: none at all).
    private func photo(_ gps: [CFString: Any]?) -> Data {
        let ctx = CGContext(data: nil, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.98, green: 0.88, blue: 0.19, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
        var meta: [CFString: Any] = [kCGImagePropertyExifDictionary: [kCGImagePropertyExifLensModel: "Test lens"]]
        if let gps { meta[kCGImagePropertyGPSDictionary] = gps }
        CGImageDestinationAddImage(dest, ctx.makeImage()!, meta as CFDictionary)
        CGImageDestinationFinalize(dest)
        return out as Data
    }
    /// Congress Ave, Austin (30.2672 N, 97.7431 W), as a phone writes it.
    private func gps(_ lat: Double, _ latRef: String, _ lng: Double, _ lngRef: String, error: Double? = nil) -> [CFString: Any] {
        var d: [CFString: Any] = [kCGImagePropertyGPSLatitude: lat, kCGImagePropertyGPSLatitudeRef: latRef,
                                  kCGImagePropertyGPSLongitude: lng, kCGImagePropertyGPSLongitudeRef: lngRef]
        if let error { d[kCGImagePropertyGPSHPositioningError] = error }
        return d
    }
    private let areas = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]

    // GPS present

    @Test func readsTheSavedLocationWithItsHemispheres() throws {
        let austin = try #require(PhotoLocation.read(from: photo(gps(30.2672, "N", 97.7431, "W", error: 12))))
        #expect(abs(austin.latitude - 30.2672) < 1e-6 && abs(austin.longitude + 97.7431) < 1e-6, "W is negative")
        #expect(austin.accuracy == 12 && austin.fix.horizontalAccuracy == 12)
        #expect(austin.area(in: areas)?.key == "austin")
        let sydney = try #require(PhotoLocation.read(from: photo(gps(33.8688, "S", 151.2093, "E"))))
        #expect(sydney.latitude < 0 && sydney.longitude > 0, "S is negative, E positive")
        #expect(sydney.accuracy == nil && sydney.fix.horizontalAccuracy == PhotoLocation.assumedAccuracy, "no recorded error: a typical phone fix")
        #expect(sydney.area(in: areas) == nil, "outside Austin and Dallas")
        let dallas = try #require(PhotoLocation.read(from: photo(gps(32.7876, "N", 96.7994, "W"))))
        #expect(dallas.area(in: areas)?.key == "dallas")
    }

    // GPS missing

    @Test func noLocationMeansNoSuggestion() {
        #expect(PhotoLocation.read(from: photo(nil)) == nil)
        #expect(PhotoLocation.read(from: Data("not an image".utf8)) == nil)
        #expect(PhotoLocation.read(from: photo([kCGImagePropertyGPSLatitude: 30.2672, kCGImagePropertyGPSLatitudeRef: "N"])) == nil, "latitude without longitude")
    }

    // Invalid coordinates

    @Test func invalidCoordinatesAreIgnored() {
        #expect(PhotoLocation.from(gps: gps(95, "N", 97.7, "W")) == nil, "latitude past 90")
        #expect(PhotoLocation.from(gps: gps(30.2, "N", 190, "W")) == nil, "longitude past 180")
        #expect(PhotoLocation.from(gps: gps(0, "N", 0, "E")) == nil, "0,0 is a placeholder")
        #expect(PhotoLocation.from(gps: gps(30.2, "X", 97.7, "W")) == nil, "an unknown hemisphere")
        #expect(PhotoLocation.from(gps: gps(.nan, "N", 97.7, "W")) == nil)
        #expect(PhotoLocation.from(gps: gps(30.2, "N", 97.7, "W", error: -5))?.accuracy == nil, "a negative error isn't an accuracy")
    }

    // Multiple photos

    @Test func severalPhotosUseTheFirstLocationAndLetTheRiderChoose() async throws {
        let noGPS = photo(nil), first = photo(gps(30.2672, "N", 97.7431, "W")), second = photo(gps(30.4000, "N", 97.7000, "W"))
        #expect(PhotoLocation.first(in: [noGPS, first, second]) == PhotoLocation.read(from: first), "the first photo that has one")
        #expect(PhotoLocation.first(in: [noGPS]) == nil)

        let m = SubmitSightingModel()
        await m.setPhoto(noGPS)
        #expect(m.photo != nil && m.photoSuggestion == nil, "no location: the manual flow as before")
        await m.setPhoto(first)
        #expect(m.photoSuggestion == PhotoLocation.read(from: first) && !m.photosDisagree)
        await m.setPhoto(photo(gps(30.2675, "N", 97.7433, "W")))   // the same corner, a few meters off
        #expect(m.photoLocations.count == 1, "one place, not two")
        await m.setPhoto(second)
        #expect(m.photosDisagree && m.photoSuggestion == PhotoLocation.read(from: first), "different places: still the first, and the rider is asked")
        m.chosenPhotoLocation = 1
        #expect(m.photoSuggestion == PhotoLocation.read(from: second), "the rider's choice")
        m.dismissPhotoLocation()
        #expect(m.photoSuggestion == nil, "rejected")
        m.removePhoto()
        #expect(m.photoLocations.isEmpty, "no photo, nothing to suggest")
    }

    // A place the rider chose is never replaced by a photo's location

    @Test func aChosenPlaceIsNeverOverwritten() async {
        let m = SubmitSightingModel()
        m.cityName = "Austin"
        let chosen = PlaceSearch.Place(id: "N:123", label: "Congress Ave, Austin", city: "Austin")
        m.pick(chosen, query: "Congress")
        await m.setPhoto(photo(gps(30.4000, "N", 97.7000, "W")))
        #expect(m.place == chosen && m.locationText == chosen.label, "the photo only suggests")
        #expect(m.photoSuggestion != nil, "the suggestion is still offered to review")
        m.dismissPhotoLocation()
        #expect(m.place == chosen)
    }

    // Privacy: the upload carries no location, and the form no coordinates

    @Test func theLocationNeverLeavesThePhone() async throws {
        let m = SubmitSightingModel()
        await m.setPhoto(photo(gps(30.2672, "N", 97.7431, "W", error: 12)))
        #expect(m.photoSuggestion != nil, "read on the phone")
        let uploaded = try #require(m.photo)
        let props = CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(uploaded as CFData, nil)!, 0, nil) as? [CFString: Any] ?? [:]
        #expect(props[kCGImagePropertyGPSDictionary] == nil, "the uploaded photo has no GPS")
        #expect((props[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifLensModel] == nil, "nor other camera details")
        let form = m.form()
        #expect(!form.fields.map(\.0).contains { ["latitude", "longitude", "lat", "lng", "gps", "location_lat", "location_lng"].contains($0) }, "no coordinate fields")
        #expect(!form.fields.map(\.1).contains { $0.contains("30.267") || $0.contains("97.743") }, "no coordinates in any field")
        #expect(form.fields.first { $0.0 == "location_id" } == nil, "nothing becomes a location until the rider confirms a place")
    }

    // A photo's location isn't held to the live-GPS recency rule, but still to accuracy.

    @Test func photoFixesSkipTheRecencyRuleOnly() async {
        let stale = CLLocation(coordinate: .init(latitude: 30.2672, longitude: -97.7431), altitude: 0, horizontalAccuracy: 20, verticalAccuracy: -1, timestamp: .now.addingTimeInterval(-86_400))
        let live = SightingLocationModel(resolver: NoPlacesResolver())
        live.begin(area: areas[0])
        await live.lookup(stale, area: areas[0], api: StubServer().api(), fromPhoto: false)
        #expect(live.failure == .locationAccuracy, "an old live reading is refused")
        let fromPhoto = SightingLocationModel(resolver: NoPlacesResolver())
        fromPhoto.begin(area: areas[0])
        await fromPhoto.lookup(stale, area: areas[0], api: StubServer().api(), fromPhoto: true)
        #expect(fromPhoto.failure != .locationAccuracy && fromPhoto.diagnostics.locationAccepted, "a photo's saved location is accepted")
        let vague = CLLocation(coordinate: .init(latitude: 30.2672, longitude: -97.7431), altitude: 0, horizontalAccuracy: 2000, verticalAccuracy: -1, timestamp: .now)
        let photoVague = SightingLocationModel(resolver: NoPlacesResolver())
        photoVague.begin(area: areas[0])
        await photoVague.lookup(vague, area: areas[0], api: StubServer().api(), fromPhoto: true)
        #expect(photoVague.failure == .locationAccuracy, "an imprecise photo location still isn't used")
    }
}

/// Apple Maps stand-in: no nearby places or streets.
private final class NoPlacesResolver: SightingPlaceResolver, @unchecked Sendable {
    func places(near location: CLLocation, radius: CLLocationDistance) async throws -> [SightingPlaceHint] { [] }
    func street(near location: CLLocation) async throws -> String? { nil }
    func cancel() {}
}
