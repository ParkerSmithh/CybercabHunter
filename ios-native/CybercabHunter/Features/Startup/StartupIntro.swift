import SwiftUI
import AVFoundation
import os

/// The opening animation (AppOpeningAnimation.mp4, 1080×1920, 60 fps, 2.35 s,
/// no audio), shown once per cold launch over the app, which loads underneath,
/// then crossfaded away into Home.
///
/// Once per process: the state lives in `shared`, created with the process, so
/// coming back from the background, unlocking, Control Center or changing tabs
/// never replays it (nothing here watches scenePhase except to wait for the
/// first time the app is actually on screen, so a scene connected in the
/// background doesn't play it unseen).
///
/// It steps aside, without a fade, whenever the launch has somewhere to go: a
/// system control, Shortcut, widget, link, notification or shared photo or
/// receipt (`skip()` from AppRouter and RootView). It never plays with Reduce
/// Motion on, in UI tests (unless `-playIntro`), or when the video is missing.
@MainActor
@Observable
final class StartupIntro {
    static let shared = StartupIntro()
    private static let log = Logger(subsystem: "com.cybercabhunter.native", category: "intro")

    enum Phase: Equatable { case waiting, playing, done }
    private(set) var phase: Phase
    /// Why it ended (UI tests read it): off, played, skipped, failed, timedOut.
    private(set) var endReason = "none"
    /// The crossfade into Home.
    static let fade: Duration = .milliseconds(200)
    /// Longest the rider can be held on the intro: the video is 2.35 s.
    static let timeout: Duration = .seconds(5)
    /// How long the video may take to show its first frame before the app goes on without it.
    static let startTimeout: Duration = .seconds(3)

    /// The one player, released when the intro ends.
    private(set) var player: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private var statusTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?

    init(arguments: [String] = ProcessInfo.processInfo.arguments,
         reduceMotion: Bool = UIAccessibility.isReduceMotionEnabled,
         videoURL: URL? = StartupIntro.videoURL()) {
        let url = Self.debugURL(arguments) ?? videoURL
        if Self.shouldPlay(arguments: arguments, reduceMotion: reduceMotion, hasVideo: url != nil), let url {
            phase = .waiting
            let player = AVPlayer(url: url)
            player.isMuted = true                        // the file has no sound; never touch other audio
            player.preventsDisplaySleepDuringVideoPlayback = false
            player.actionAtItemEnd = .pause              // once, holding the last frame for the fade
            self.player = player
        } else {
            phase = .done
            endReason = "off"
        }
        Self.log.notice("intro decided: play=\(self.phase == .waiting, privacy: .public) reduceMotion=\(reduceMotion, privacy: .public) video=\(url?.lastPathComponent ?? "none", privacy: .public)")
    }

    static func videoURL(in bundle: Bundle = .main) -> URL? {
        bundle.url(forResource: "AppOpeningAnimation", withExtension: "mp4")
    }

    /// Whether this launch opens with the animation.
    nonisolated static func shouldPlay(arguments: [String], reduceMotion: Bool, hasVideo: Bool) -> Bool {
        if arguments.contains("-skipIntro") || reduceMotion || !hasVideo { return false }
        // UI tests (-apiBase) start straight in the app unless they ask for the intro.
        if arguments.contains("-apiBase") && !arguments.contains("-playIntro") { return false }
        return true
    }

    /// UI tests: `-introURL missing` plays a file that doesn't exist (the failure path).
    private static func debugURL(_ arguments: [String]) -> URL? {
        #if DEBUG
        guard let i = arguments.firstIndex(of: "-introURL"), i + 1 < arguments.count else { return nil }
        return URL(fileURLWithPath: "/nonexistent/\(arguments[i + 1]).mp4")
        #else
        return nil
        #endif
    }

    var isShowing: Bool { phase != .done }

    /// The app is on screen for the first time: get ready, and play once the
    /// first frame is actually displayable (`layerReady()`). Starting the clock
    /// earlier, while the launch still holds the main thread, let the video run
    /// unseen and end before its frames reached the screen.
    func start() {
        guard phase == .waiting, let player, let item = player.currentItem else { return }
        phase = .playing
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish(reason: "played") }
        }
        // A file that can't play, or is slow to start, never holds the rider here.
        statusTask = Task { [weak self] in
            let deadline = ContinuousClock.now + Self.startTimeout
            while !Task.isCancelled, ContinuousClock.now < deadline {
                if item.status == .failed { self?.finish(animated: false, reason: "failed"); return }
                try? await Task.sleep(for: .milliseconds(50))
            }
            // Never showed a frame in time (cancelled once playing).
            if !Task.isCancelled { self?.finish(animated: false, reason: "failed") }
        }
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: Self.startTimeout + Self.timeout)
            if !Task.isCancelled { self?.finish(reason: "timedOut") }
        }
    }

    private var started = false
    /// UI tests: `-introHold` keeps the first frame up (never plays), so a test
    /// can look at the intro and see the timeout bring the app back.
    private let holds = ProcessInfo.processInfo.arguments.contains("-introHold")
    /// The video's layer is on screen with its first frame: play, from the start.
    func layerReady() {
        guard phase == .playing, !started, let player else { return }
        started = true
        statusTask?.cancel()
        #if DEBUG
        if holds { return }
        #endif
        player.play()
    }

    /// The video ended (or timed out): crossfade into the app.
    func finish(animated: Bool = true, reason: String) {
        guard phase != .done else { return }
        endReason = reason
        Self.log.notice("intro ended: \(reason, privacy: .public)")
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { phase = .done }
        } else {
            phase = .done
        }
        Task { [weak self] in
            if animated { try? await Task.sleep(for: Self.fade) }
            self?.release()
        }
    }

    /// The launch has a destination (a control, Shortcut, link or notification): go straight to it.
    func skip() { finish(animated: false, reason: "skipped") }

    private func release() {
        statusTask?.cancel(); timeoutTask?.cancel()
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
    }
}

/// Full screen, edge to edge (behind the Dynamic Island and Home indicator):
/// the video fills the display proportionally. Its emblem sits in the middle
/// 63% of the frame, so aspect-fill only trims empty black at the sides. No
/// controls, text or spinner; #050505 until the first frame.
struct StartupIntroView: View {
    @Bindable var intro: StartupIntro
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color(red: 5 / 255, green: 5 / 255, blue: 5 / 255)
            if let player = intro.player { PlayerLayerView(player: player) { intro.layerReady() } }
        }
        .ignoresSafeArea()
        .accessibilityElement()
        .accessibilityLabel("CybercabHunter")
        .accessibilityIdentifier("startupIntro")
        // Modal: while it plays, VoiceOver skips the app loading beneath it
        // (accessibilityHidden on that view doesn't reach the system tab bar).
        .accessibilityAddTraits(.isModal)
        // Plays as soon as it is on screen: the scene is still "inactive" while
        // iOS finishes the launch, and waiting for "active" left seconds of black.
        // A scene connected in the background (no one looking) waits.
        .onChange(of: scenePhase, initial: true) { if scenePhase != .background { intro.start() } }
    }
}

/// An AVPlayerLayer as the view's own layer.
private struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    /// The first frame can be displayed.
    let onReady: () -> Void

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.backgroundColor = .clear
        view.playerLayer.videoGravity = .resizeAspectFill
        view.playerLayer.player = player
        view.readyObservation = view.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { layer, _ in
            guard layer.isReadyForDisplay else { return }
            DispatchQueue.main.async { onReady() }
        }
        return view
    }

    func updateUIView(_ view: PlayerUIView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    static func dismantleUIView(_ view: PlayerUIView, coordinator: ()) {
        view.readyObservation = nil
        view.playerLayer.player = nil
    }

    final class PlayerUIView: UIView {
        var readyObservation: NSKeyValueObservation?
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
