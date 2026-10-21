import UIKit

/// Light haptics for meaningful moments (sign-in, refresh done), never for scrolling.
@MainActor
enum Haptics {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
