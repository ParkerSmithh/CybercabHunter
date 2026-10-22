import Foundation

/// A website page opened in Safari's in-app browser while its native screen
/// isn't built yet (ios-native/PLAN.md lists which, and the phase that replaces it).
struct WebPage: Identifiable, Hashable {
    let title: String
    let path: String
    let systemImage: String
    var id: String { path }
}
