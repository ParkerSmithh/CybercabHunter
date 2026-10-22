import Foundation
@testable import CybercabHunter

/// Saved real responses (Fixtures/), decoded with the app's decoder.
enum TestFixtures {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle(for: Token.self).url(forResource: name, withExtension: "json") else { throw CocoaError(.fileNoSuchFile) }
        return try Data(contentsOf: url)
    }
    static func decode<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        try APIClient.makeDecoder().decode(T.self, from: data(name))
    }
    /// The repository root on the Mac running the simulator tests.
    static let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private final class Token {}
}
