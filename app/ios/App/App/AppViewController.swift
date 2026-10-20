import UIKit
import Capacitor

/// The app's one screen: Capacitor's web view showing https://cybercabhunter.com
/// (capacitor.config.json server.url). App-specific native plugins are
/// registered here; this is also where future native features (location,
/// camera, App Intents, widgets, notifications) get wired in.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeSignInPlugin())
    }

    // The site is dark, so the status bar text is light.
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}
