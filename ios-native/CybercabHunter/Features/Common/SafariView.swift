import SwiftUI
import SafariServices

/// A website page in Safari's in-app browser: the honest fallback for screens
/// that are not native yet (it shares the rider's Safari sign-in, not the app's).
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = UIColor(Color.brandGold)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
