import SwiftUI
import ImageIO

/// A numbered still sequence bundled from the website (Resources/Frames):
/// the Simulation page's door swing (public/images/cybercab-doors/m, 108
/// frames) and the Home hero's door opening (public/images/hero-frames/m,
/// 73 frames). The compressed files stay in memory (a few MB); a frame is
/// decoded when it is first drawn and kept in a small cache, so a sequence
/// never holds every decoded frame at once.
@MainActor
final class FrameSequence {
    static let doors = FrameSequence(prefix: "door-", digits: 3, ext: "webp", count: 108)
    static let hero = FrameSequence(prefix: "hero-", digits: 2, ext: "jpg", count: 73)

    let count: Int
    private let data: [Data?]
    private var cache: [Int: CGImage] = [:]
    private var order: [Int] = []
    private let capacity = 16

    private init(prefix: String, digits: Int, ext: String, count: Int) {
        self.count = count
        data = (0..<count).map { i in
            let name = prefix + String(format: "%0\(digits)d", i)
            return Bundle.main.url(forResource: name, withExtension: ext).flatMap { try? Data(contentsOf: $0) }
        }
    }

    /// Whether the bundle has every frame (a missing one falls back to its neighbour, as on the site).
    var isComplete: Bool { data.allSatisfy { $0 != nil } }

    /// Frame `i` (clamped), or the nearest frame that decodes.
    func image(_ i: Int) -> CGImage? {
        let i = min(max(i, 0), count - 1)
        if let hit = cache[i] { return hit }
        for d in 0..<count {
            for j in [i - d, i + d] where j >= 0 && j < count {
                if let img = decode(j) { remember(i, img); return img }
            }
        }
        return nil
    }

    private func decode(_ i: Int) -> CGImage? {
        guard let d = data[i], let src = CGImageSourceCreateWithData(d as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    private func remember(_ i: Int, _ img: CGImage) {
        cache[i] = img
        order.removeAll { $0 == i }
        order.append(i)
        if order.count > capacity { cache[order.removeFirst()] = nil }
    }

    /// Decodes a run of frames ahead of time (before an animation starts).
    func warm(_ range: Range<Int>) { for i in range.clamped(to: 0..<count) { _ = image(i) } }
}

/// One position in a sequence, crossfading between the two nearest frames by
/// the exact position (js/cybercab-doors.js and js/hero-video.js do the same
/// on a canvas), so motion stays continuous at 60 or 120 Hz.
struct FrameView: View {
    let sequence: FrameSequence
    /// 0 … count − 1, fractional.
    let position: Double
    var contentMode: ContentMode = .fit

    var body: some View {
        let a = Int(position.rounded(.down)), mix = position - Double(a)
        ZStack {
            if let first = sequence.image(a) { Image(decorative: first, scale: 1).resizable().aspectRatio(contentMode: contentMode) }
            if mix > 0.001, a + 1 < sequence.count, let next = sequence.image(a + 1) {
                Image(decorative: next, scale: 1).resizable().aspectRatio(contentMode: contentMode).opacity(mix)
            }
        }
    }
}

/// The interactive Cybercab of Fleet ROI and Fleet ETA (js/cybercab-doors.js):
/// tap the car or "Open doors" and the butterfly doors swing up over 1.5 s
/// (ease-in-out cubic); again and they close; a tap mid-swing reverses from
/// where the doors are. With Reduce Motion the doors jump open or closed.
/// The frames' studio is the page colour (#08090A), so the car sits on the
/// background with no box.
struct CybercabDoorsView: View {
    var width: CGFloat = 170
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open = false
    /// 0 = closed … 1 = open, linear in time.
    @State private var t: Double = 0
    @State private var from: Double = 0
    @State private var started: Date?

    static let duration: Double = 1.5
    private let frames = FrameSequence.doors

    var body: some View {
        VStack(spacing: 10) {
            TimelineView(.animation(paused: started == nil)) { context in
                FrameView(sequence: frames, position: Self.ease(progress(at: context.date)) * Double(frames.count - 1))
                    .onChange(of: context.date) { _, now in settle(at: now) }
            }
            .aspectRatio(800.0 / 446.0, contentMode: .fit)
            .frame(width: width)
            .contentShape(Rectangle())
            .onTapGesture { toggle() }
            .accessibilityElement()
            .accessibilityLabel("Cybercab")
            .accessibilityHint(open ? "Closes the Cybercab's doors" : "Opens the Cybercab's doors")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { toggle() }
            .accessibilityIdentifier("cybercabDoors")

            Button(action: toggle) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.up").font(.system(size: 11, weight: .bold)).rotationEffect(.degrees(open ? 180 : 0))
                    Text(open ? "Close doors" : "Open doors")
                }
                .font(.inter(12, .semibold)).tracking(0.2)
                .foregroundStyle(Color.brandGold)
                .padding(.horizontal, 14).frame(minHeight: 36)
                .overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.35)))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .accessibilityLabel(open ? "Close the Cybercab's doors" : "Open the Cybercab's doors")
            .accessibilityIdentifier("cybercabDoorsButton")
        }
    }

    private func progress(at now: Date) -> Double {
        guard let started else { return t }
        let moved = now.timeIntervalSince(started) / Self.duration
        return open ? min(1, from + moved) : max(0, from - moved)
    }

    private func settle(at now: Date) {
        let p = progress(at: now)
        if p == (open ? 1 : 0) { t = p; started = nil }
    }

    private func toggle() {
        let now = Date()
        let current = progress(at: now)
        open.toggle()
        if reduceMotion {
            t = open ? 1 : 0; started = nil
        } else {
            from = current; t = current; started = now
        }
    }

    /// easeInOutCubic, as js/cybercab-doors.js.
    static func ease(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
}
