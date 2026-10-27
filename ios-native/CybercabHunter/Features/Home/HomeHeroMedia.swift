import SwiftUI
import AVFoundation

/// The homepage hero's car (index.html #hero, js/hero-video.js):
/// 1. the film plays once, muted (the website's own /videos/cybercab-animation-web);
/// 2. when it ends, the hero switches to scroll-driven frames of the film's
///    first 3 s (images/hero-frames/m, bundled): scrolling down opens the
///    doors, scrolling back up closes them. Frame 0 is the film's opening
///    and closing pose, so the hand-off is seamless.
/// With Reduce Motion nothing moves (the poster stays). In Low Data Mode the
/// film is skipped (the site's Save-Data rule) and the frames are used.
struct HomeHeroMedia: View {
    /// How far Home has scrolled, in points.
    let scroll: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var filmDone = false
    @State private var filmVisible = false

    /// The scroll distance over which the doors open: about the picture's height,
    /// so they are fully open as it leaves the screen.
    static let openDistance: CGFloat = 200

    var body: some View {
        ZStack {
            if reduceMotion {
                Image("HeroCybercab").resizable().scaledToFill()
            } else if filmDone {
                let p = min(1, max(0, scroll / Self.openDistance))
                FrameView(sequence: .hero, position: Double(p) * Double(FrameSequence.hero.count - 1), contentMode: .fill)
                    // A gentle parallax: the car leaves at half speed, so the doors are seen opening.
                    .offset(y: scroll * 0.5)
                    .accessibilityIdentifier("heroFrames")
            } else {
                Image("HeroCybercab").resizable().scaledToFill()
                HeroFilm(url: AppConfig.webURL("/videos/cybercab-animation-web"), visible: $filmVisible) { filmDone = true }
                    .opacity(filmVisible ? 1 : 0)
                    .accessibilityIdentifier("heroFilm")
            }
        }
    }
}

/// The film, muted, once, in an AVPlayerLayer (no controls). Any failure
/// (offline, Low Data Mode, a bad response) ends it at once, as the site's
/// `error` handler does.
private struct HeroFilm: UIViewRepresentable {
    let url: URL
    @Binding var visible: Bool
    let onEnd: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(visible: $visible, onEnd: onEnd) }

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        let asset = AVURLAsset(url: url, options: [AVURLAssetAllowsConstrainedNetworkAccessKey: false])
        let item = AVPlayerItem(asset: asset)
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspectFill
        context.coordinator.observe(player: player, item: item, layer: view.playerLayer)
        player.play()
        return view
    }

    func updateUIView(_ uiView: PlayerView, context: Context) {}

    static func dismantleUIView(_ uiView: PlayerView, coordinator: Coordinator) {
        uiView.playerLayer.player?.pause()
        coordinator.stop()
    }

    final class PlayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    @MainActor
    final class Coordinator {
        private var visible: Binding<Bool>
        private let onEnd: () -> Void
        private var tokens: [NSObjectProtocol] = []
        private var observations: [NSKeyValueObservation] = []
        private var ended = false

        init(visible: Binding<Bool>, onEnd: @escaping () -> Void) { self.visible = visible; self.onEnd = onEnd }

        func observe(player: AVPlayer, item: AVPlayerItem, layer: AVPlayerLayer) {
            let center = NotificationCenter.default
            tokens.append(center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish() }
            })
            tokens.append(center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish() }
            })
            observations.append(item.observe(\.status) { [weak self] item, _ in
                let failed = item.status == .failed
                Task { @MainActor in if failed { self?.finish() } }
            })
            // Shown only once a frame is ready, so the poster never flashes to black.
            observations.append(layer.observe(\.isReadyForDisplay) { [weak self] layer, _ in
                let ready = layer.isReadyForDisplay
                Task { @MainActor in if ready { self?.visible.wrappedValue = true } }
            })
        }

        private func finish() {
            guard !ended else { return }
            ended = true
            stop()
            onEnd()
        }

        func stop() {
            tokens.forEach(NotificationCenter.default.removeObserver)
            tokens = []
            observations = []
        }
    }
}
