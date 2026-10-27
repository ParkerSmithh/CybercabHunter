import XCTest

/// Also writes a test's screenshots to /tmp/cch-shots/<name>.png on the Mac
/// (simulator runs), so they survive a result bundle that isn't finalized.
extension XCTestCase {
    func saveShot(_ app: XCUIApplication, _ name: String) {
        let dir = URL(fileURLWithPath: "/tmp/cch-shots")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? app.screenshot().pngRepresentation.write(to: dir.appendingPathComponent("\(name).png"))
    }
}
