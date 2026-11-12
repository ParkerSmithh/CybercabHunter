import Testing
import Foundation
@testable import CybercabHunter

/// The opening animation's rules (Features/Startup/StartupIntro.swift).
@MainActor
struct StartupIntroTests {
    @Test func playsOnANormalLaunch() {
        #expect(StartupIntro.shouldPlay(arguments: ["CybercabHunter"], reduceMotion: false, hasVideo: true))
    }

    @Test func reduceMotionSkipsIt() {
        #expect(!StartupIntro.shouldPlay(arguments: [], reduceMotion: true, hasVideo: true))
        let intro = StartupIntro(arguments: [], reduceMotion: true, videoURL: URL(fileURLWithPath: "/x.mp4"))
        #expect(intro.phase == .done && intro.player == nil && intro.endReason == "off")
    }

    @Test func noVideoMeansStraightIntoTheApp() {
        let intro = StartupIntro(arguments: [], reduceMotion: false, videoURL: nil)
        #expect(intro.phase == .done && !intro.isShowing)
    }

    @Test func uiTestsSkipItUnlessAsked() {
        #expect(!StartupIntro.shouldPlay(arguments: ["-apiBase", "http://x"], reduceMotion: false, hasVideo: true))
        #expect(StartupIntro.shouldPlay(arguments: ["-apiBase", "http://x", "-playIntro"], reduceMotion: false, hasVideo: true))
        #expect(!StartupIntro.shouldPlay(arguments: ["-skipIntro"], reduceMotion: false, hasVideo: true))
    }

    @Test func theVideoIsBundled() throws {
        let url = try #require(StartupIntro.videoURL(in: Bundle(for: AppBundleMarker.self)) ?? StartupIntro.videoURL())
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int
        #expect(size == 3_455_508, "the exact AppOpeningAnimation.mp4 (CybercabHunter/Resources)")
    }

    @Test func oneIntroPerLaunch() {
        let intro = StartupIntro(arguments: [], reduceMotion: false, videoURL: URL(fileURLWithPath: "/x.mp4"))
        #expect(intro.phase == .waiting && intro.player != nil)
        intro.skip()
        #expect(intro.phase == .done && intro.endReason == "skipped")
        intro.start()   // never again in this process
        intro.layerReady()
        #expect(intro.phase == .done)
        intro.finish(reason: "played")
        #expect(intro.endReason == "skipped", "the first ending stands")
    }
}

private final class AppBundleMarker {}
