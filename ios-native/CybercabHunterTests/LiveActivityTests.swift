import Testing
import Foundation
import SwiftUI
import ActivityKit
@testable import CybercabHunter

// The Cybercab Daily Live Activity: the switch (off by default, persisted,
// never re-enabled by itself), today's figures from the Daily report (24/7:
// no countdown), staleness at the hour or at Central midnight, an activity
// left by an earlier build, reconciling at launch, and each presentation
// rendered. ActivityKit itself is replaced by a fake.

@MainActor
final class FakeActivityBackend: ServiceActivityBackend {
    var isSupported = true
    var isAuthorized = true
    var running: [ServiceActivityAttributes.ContentState] = [] { didSet { if running.isEmpty { runningAttributes = [] } } }
    var runningAttributes: [ServiceActivityAttributes] = []
    var started: [(ServiceActivityAttributes, ServiceActivityAttributes.ContentState, Date)] = []
    var updates: [(ServiceActivityAttributes.ContentState, Date)] = []
    var endAllCalls = 0
    var failStart = false

    func start(_ attributes: ServiceActivityAttributes, _ state: ServiceActivityAttributes.ContentState, staleDate: Date) throws {
        if failStart { throw CancellationError() }
        started.append((attributes, state, staleDate)); running.append(state); runningAttributes.append(attributes)
    }
    func update(_ state: ServiceActivityAttributes.ContentState, staleDate: Date) async {
        updates.append((state, staleDate)); running = [state]; runningAttributes = Array(runningAttributes.prefix(1))
    }
    func endAll() async { endAllCalls += 1; running = [] }
    var stayAwakeCalls = 0
    var dismissEndedCalls = 0
    func stayAwakeBriefly() { stayAwakeCalls += 1 }
    var stopStayingAwakeCalls = 0
    func stopStayingAwake() { stopStayingAwakeCalls += 1 }
    func dismissEnded() async { dismissEndedCalls += 1 }
}

private func central(_ s: String) -> Date {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = CentralTime.zone; f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f.date(from: s)!
}
private func wall(_ d: Date) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = CentralTime.zone; f.dateFormat = "yyyy-MM-dd HH:mm zzz"
    return f.string(from: d)
}
private func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
/// A Daily report as GET /api/daily sends it.
private func report(today: String = "2026-11-12", at: Date, detections: Int?, sightings: Int?, yesterday: Int? = nil) -> DailyReport {
    func n(_ v: Int?) -> Any { v.map { $0 as Any } ?? NSNull() }
    let body: [String: Any] = ["today": today, "generated_at": iso(at),
        "day": ["date": today, "registry": 1, "dmv": 0, "sightings": n(sightings), "cameras": n(detections)],
        "previous": ["date": "2026-11-11", "registry": 0, "dmv": 0, "sightings": 2, "cameras": n(yesterday)]]
    return try! APIClient.makeDecoder().decode(DailyReport.self, from: JSONSerialization.data(withJSONObject: body))
}
private func display(_ s: ServiceActivityAttributes.ContentState, stale: Bool = false) -> ServiceActivityDisplay {
    ServiceActivityDisplay(detections: s.detections, sightings: s.sightings, detectionsYesterday: s.detectionsYesterday,
                           updated: s.updated, city: ServiceActivityAttributes.coverage, stale: stale || s.day.isEmpty)
}

@MainActor
@Suite(.serialized)
struct LiveActivityTests {
    private func make(_ fake: FakeActivityBackend = FakeActivityBackend()) -> (ServiceLiveActivityController, FakeActivityBackend, UserDefaults) {
        let d = UserDefaults(suiteName: "live-\(UUID().uuidString)")!
        return (ServiceLiveActivityController(backend: fake, defaults: d), fake, d)
    }

    // 1, 2: the switch

    @Test func switchIsOffByDefaultAndPersists() async {
        let (c, fake, d) = make()
        #expect(!c.enabled && fake.started.isEmpty, "off until the rider turns it on")
        await c.reconcile(now: central("2026-10-26 12:00:00"))
        #expect(fake.started.isEmpty, "launching never starts it while off")
        await c.setEnabled(true, now: central("2026-10-26 12:00:00"))
        #expect(c.enabled && d.bool(forKey: ServiceLiveActivityController.enabledKey))
        let relaunched = ServiceLiveActivityController(backend: FakeActivityBackend(), defaults: d)
        #expect(relaunched.enabled, "restored on the next launch")
        await c.setEnabled(false)
        #expect(!ServiceLiveActivityController(backend: FakeActivityBackend(), defaults: d).enabled, "off stays off")
    }

    // 3, 4: start from today's Daily figures, end at once

    @Test func enablingStartsWithTodaysFiguresAndDisablingEndsIt() async {
        let (c, fake, _) = make()
        let made = central("2026-11-12 10:41:00")
        c.latest = ServiceActivityAttributes.ContentState(report(at: made, detections: 1234, sightings: 4, yesterday: 1200))
        await c.setEnabled(true, now: central("2026-11-12 10:45:00"))
        #expect(fake.started.count == 1)
        let (attrs, state, stale) = fake.started[0]
        #expect(state.detections == 1234 && state.sightings == 4 && state.detectionsYesterday == 1200 && state.day == "2026-11-12")
        #expect(attrs.cityName == "Austin & Dallas", "the Daily figures cover both cities")
        #expect(wall(stale) == "2026-11-12 11:41 CST", "stale an hour after the figures")
        await c.setEnabled(false)
        #expect(fake.running.isEmpty && fake.endAllCalls == 1 && !c.enabled)
    }

    // Before the first figures arrive it still starts, honestly empty, and
    // fills in when they come.
    @Test func startsBeforeTheFiguresAndFillsInWhenTheyArrive() async {
        let (c, fake, _) = make()
        await c.setEnabled(true, now: central("2026-11-12 08:00:00"))
        #expect(fake.started.count == 1 && fake.started[0].1.detections == nil && display(fake.started[0].1).detectionsText == "—")
        c.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 08:01:00"), detections: 12, sightings: 1))
        await c.reconcile(now: central("2026-11-12 08:01:30"))
        #expect(fake.updates.count == 1 && fake.updates[0].0.detections == 12 && fake.started.count == 1, "updated in place, not a second one")
        // New figures: one update; the same figures again: nothing sent.
        c.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 08:06:00"), detections: 15, sightings: 1))
        await c.reconcile(now: central("2026-11-12 08:06:10"))
        await c.reconcile(now: central("2026-11-12 08:07:00"))
        #expect(fake.updates.count == 2 && fake.updates[1].0.detections == 15)
    }

    // Relaunch: the app reconciles on becoming active, before Home has fetched
    // today's figures. The running activity keeps its figures until new ones
    // arrive, instead of flashing "not updated".
    @Test func relaunchKeepsTheShownFiguresUntilNewOnesArrive() async {
        let fake = FakeActivityBackend()
        let (c, _, d) = make(fake)
        c.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 09:00:00"), detections: 21, sightings: 2))
        await c.setEnabled(true, now: central("2026-11-12 09:00:00"))
        let relaunched = ServiceLiveActivityController(backend: fake, defaults: d)   // a new launch: no figures in memory
        await relaunched.reconcile(now: central("2026-11-12 09:30:00"))
        #expect(fake.updates.isEmpty && fake.started.count == 1 && fake.running.first?.detections == 21, "left as it was")
        relaunched.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 09:30:00"), detections: 25, sightings: 2))
        await relaunched.reconcile(now: central("2026-11-12 09:30:05"))
        #expect(fake.updates.count == 1 && fake.running.first?.detections == 25)
    }

    // 5–8: staleness: an hour after the figures, or the next Central midnight
    // (when "today" becomes yesterday), whichever comes first; DST-safe.
    @Test func staleAtTheHourOrAtCentralMidnight() {
        func state(_ at: String) -> ServiceActivityAttributes.ContentState {
            ServiceActivityAttributes.ContentState(report(at: central(at), detections: 1, sightings: 1))
        }
        #expect(wall(state("2026-11-12 10:41:00").staleDate) == "2026-11-12 11:41 CST")
        #expect(wall(state("2026-11-12 23:30:00").staleDate) == "2026-11-13 00:00 CST", "at midnight the figures are yesterday's")
        // Fall back (Sun Nov 1, 2026) and spring forward (Sun Mar 8, 2026): midnight is still midnight.
        #expect(wall(state("2026-10-31 23:20:00").staleDate) == "2026-11-01 00:00 CDT")
        #expect(wall(state("2026-03-07 23:45:00").staleDate) == "2026-03-08 00:00 CST")
        #expect(wall(state("2026-03-08 01:00:00").staleDate) == "2026-03-08 03:00 CDT", "an hour later across the skipped hour")
        #expect(CentralTime.nextMidnight(after: central("2026-11-01 12:00:00")).timeIntervalSince(central("2026-11-01 00:00:00")) == 25 * 3600, "the 25-hour day")
    }

    // An activity started by the earlier build (the service countdown) decodes
    // as "not updated" and is replaced, not left showing a countdown.
    @Test func anActivityFromTheOldBuildIsReplaced() async throws {
        let old = #"{"live":true,"since":783064800,"until":783147600}"#
        let state = try JSONDecoder().decode(ServiceActivityAttributes.ContentState.self, from: Data(old.utf8))
        #expect(state.day.isEmpty && state.detections == nil && display(state).stale && display(state).badge == "NOT UPDATED")
        let attrs = try JSONDecoder().decode(ServiceActivityAttributes.self, from: Data(#"{"cityName":"Austin","openLabel":"5:00 AM","closeLabel":"2:00 AM"}"#.utf8))
        #expect(attrs.cityName == "Austin")
        let (c, fake, _) = make()
        await c.setEnabled(true, now: central("2026-11-12 09:00:00"))
        fake.running = [state]; fake.runningAttributes = [attrs]
        c.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 09:00:00"), detections: 7, sightings: 0))
        await c.reconcile(now: central("2026-11-12 09:01:00"))
        #expect(fake.endAllCalls == 1 && fake.started.last?.0.cityName == "Austin & Dallas" && fake.started.last?.1.detections == 7 && fake.running.count == 1)
    }

    // 15, 16: restart reconciliation

    @Test func launchReconcilesWhatIsRunning() async {
        let (c, fake, _) = make()
        c.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 12:00:00"), detections: 5, sightings: 1))
        await c.setEnabled(true, now: central("2026-11-12 12:00:00"))
        // A duplicate still around: ended; the figures are sent once.
        let old = fake.running[0]
        fake.running = [old, old]
        c.latest = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 13:00:00"), detections: 9, sightings: 2))
        await c.reconcile(now: central("2026-11-12 13:00:05"))
        #expect(fake.updates.count == 1 && fake.updates[0].0.detections == 9 && fake.running.count == 1, "updated; the duplicate ended")
        // iOS ended it (about 8 hours): the next launch starts a fresh one while the switch is on.
        fake.running = []
        await c.reconcile(now: central("2026-11-12 21:00:00"))
        #expect(fake.started.count == 2)
        // Switched off: a launch finds one left over and ends it, and never re-enables.
        await c.setEnabled(false)
        fake.running = [old]
        await c.reconcile()
        #expect(fake.running.isEmpty && !c.enabled && fake.started.count == 2)
    }

    @Test func failuresAndStalenessAreShownNotHidden() async {
        let fake = FakeActivityBackend(); fake.failStart = true
        let (c, _, _) = make(fake)
        await c.setEnabled(true)
        #expect(c.problem == .couldNotStart)
        let s = ServiceActivityAttributes.ContentState(report(at: central("2026-11-12 10:00:00"), detections: 40, sightings: 3, yesterday: 52))
        let live = display(s), stale = display(s, stale: true)
        #expect(live.badge == "LIVE · 24/7" && live.detectionsText == "40" && live.sightingsText == "3" && live.versusYesterday == "−12 vs yesterday")
        #expect(live.updatedText == "Updated 10:00 AM CT" && live.city == "Austin & Dallas" && live.headline == "Cybercab Daily")
        #expect(stale.badge == "NOT UPDATED" && stale.detectionsText == "—" && stale.versusYesterday == nil, "past its time: says so instead of an old count")
        let big = display(ServiceActivityAttributes.ContentState(report(at: .now, detections: 12_345, sightings: 0, yesterday: 12_345)))
        #expect(big.detectionsText == "12,345" && big.versusYesterday == "Same as yesterday")
    }

    // The Home screen's Cybercab Daily card (with its animated car and road,
    // the four figures and the Live Activity switch) at each iPhone width.
    @Test func homeCardRendersAtEachWidth() throws {
        try? FileManager.default.createDirectory(atPath: "/tmp/cch-shots", withIntermediateDirectories: true)
        let r0 = report(at: .now, detections: 1234, sightings: 4, yesterday: 1200)
        for (name, w) in [("se", 343.0), ("16", 361.0), ("max", 408.0)] {
            let card = CybercabDailyCard(report: r0, error: nil).frame(width: w).padding(16)
                .background(Color(red: 8 / 255, green: 9 / 255, blue: 10 / 255)).environment(\.colorScheme, .dark)
            let r = ImageRenderer(content: card); r.scale = 3
            let image = try #require(r.uiImage, "the card renders at \(name)")
            #expect(image.size.height > 200)
            try image.pngData()?.write(to: URL(fileURLWithPath: "/tmp/cch-shots/home-daily-card-\(name).png"))
        }
    }

    // 13, 14: unsupported devices and Live Activities turned off

    @Test func unsupportedDeviceKeepsTheSwitchOffAndSaysWhy() async {
        let fake = FakeActivityBackend(); fake.isSupported = false
        let (c, _, d) = make(fake)
        #expect(!c.isSupported && c.problem == .unsupported)
        await c.setEnabled(true)
        #expect(!c.enabled && fake.started.isEmpty && !d.bool(forKey: ServiceLiveActivityController.enabledKey))
    }

    @Test func liveActivitiesOffInSettingsIsExplainedNotFaked() async {
        let fake = FakeActivityBackend(); fake.isAuthorized = false
        let (c, _, _) = make(fake)
        await c.setEnabled(true)
        #expect(!c.enabled && c.problem == .notAuthorized && fake.started.isEmpty, "stays off, with the reason")
        #expect(c.problem?.message.contains("Settings") == true)
        // Allowed, turned on, then switched off in Settings later: kept on, reported, nothing claimed.
        fake.isAuthorized = true
        await c.setEnabled(true)
        fake.isAuthorized = false
        await c.reconcile()
        #expect(c.enabled && c.problem == .notAuthorized && !c.isShowing)
    }

    // Leaving the app keeps it running (an ended activity leaves the Dynamic
    // Island at once): only closing the app ends it.
    @Test func leavingTheAppKeepsItInTheDynamicIsland() async {
        let (c, fake, _) = make()
        await c.setEnabled(true, now: central("2026-10-27 20:00:00"))
        c.appDidLeave()
        #expect(fake.running.count == 1 && fake.endAllCalls == 0, "still running: it shows in the Dynamic Island")
        #expect(fake.stayAwakeCalls == 1, "awake briefly so a swipe-away is noticed")
        await c.reconcile(now: central("2026-10-27 20:20:00"))
        #expect(fake.started.count == 1 && fake.running.count == 1, "back in the app: the same one, not a second")
        #expect(fake.stopStayingAwakeCalls >= 1, "back in the app: the closing window is released, so the next leave gets a full one")
        await c.setEnabled(false)
        c.appDidLeave()
        #expect(fake.stayAwakeCalls == 1, "switched off: nothing to keep")
    }

    // 9–12: every presentation renders, live, with large numbers and stale, at each iPhone
    // width, in light and dark, inside the Dynamic Island's limits.
    @Test func presentationsRender() throws {
        try? FileManager.default.createDirectory(atPath: "/tmp/cch-shots", withIntermediateDirectories: true)
        #expect(UIImage(named: "CybercabLive") != nil, "the Cybercab image is in the bundle")
        let live = display(ServiceActivityAttributes.ContentState(report(at: .now, detections: 1234, sightings: 4, yesterday: 1200)))
        let big = display(ServiceActivityAttributes.ContentState(report(at: .now, detections: 123_456, sightings: 9_876, yesterday: 99_999)))
        let stale = display(ServiceActivityAttributes.ContentState(report(at: .now.addingTimeInterval(-7200), detections: 40, sightings: 3)), stale: true)
        // Lock Screen and expanded widths: iPhone SE / 16 / 16 Pro Max.
        let widths: [(name: String, lock: CGFloat, island: CGFloat)] = [("se", 359, 355), ("16", 377, 371), ("max", 424, 408)]
        for (name, d) in [("live", live), ("big-numbers", big), ("stale", stale)] {
            for scheme in [ColorScheme.dark, .light] {
                let rows = VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 30) {
                        HStack { ServiceCompactLeading(d: d); Spacer(); ServiceCompactTrailing(d: d) }
                            .padding(.horizontal, 12).frame(width: 250, height: 37).background(.black, in: Capsule())
                        ServiceMinimal(d: d).frame(width: 37, height: 37).background(.black, in: Circle())
                    }
                    ForEach(widths, id: \.name) { w in
                        VStack(spacing: 6) {
                            HStack(alignment: .center) { ServiceExpandedLeading(d: d); Spacer(); ServiceExpandedTrailing(d: d) }.frame(height: 38)
                            ServiceExpandedBottom(d: d)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 12).frame(width: w.island).background(.black, in: .rect(cornerRadius: 44))
                    }
                    ForEach(widths, id: \.name) { w in
                        ServiceLockScreen(d: d).frame(width: w.lock)
                            .background(ServiceActivityPalette.background).containerShape(.rect(cornerRadius: 22)).clipShape(.rect(cornerRadius: 22))
                    }
                }
                let sheet = rows.padding(20).background(scheme == .dark ? Color(white: 0.2) : Color(white: 0.86)).environment(\.colorScheme, scheme)
                let r = ImageRenderer(content: sheet); r.scale = 3
                let image = try #require(r.uiImage, "\(name) renders")
                #expect(image.size.width > 300 && image.size.height > 300)
                try image.pngData()?.write(to: URL(fileURLWithPath: "/tmp/cch-shots/live-activity-\(name)-\(scheme == .dark ? "dark" : "light").png"))
            }
            // The expanded island is at most 160 pt in all, and iOS gives the
            // bottom region only what the top band (the leading/trailing regions,
            // level with the camera, about 44 pt) and its bottom margin (about
            // 16 pt) leave: about 100 pt. (An earlier check allowed 124 pt and
            // passed while the real iPhone cut off the last line.)
            for w in widths {
                let bottom = ImageRenderer(content: ServiceExpandedBottom(d: d).frame(width: w.island - 24).fixedSize(horizontal: false, vertical: true))
                let h = try #require(bottom.uiImage).size.height
                #expect(h <= ServiceExpandedBottom.budget, "expanded \(name) at \(w.name): \(h) pt")
                let car = ImageRenderer(content: ServiceExpandedTrailing(d: d).fixedSize())
                #expect(try #require(car.uiImage).size.height <= 40, "the car fits the top band beside LIVE · 24/7")
                let lock = ImageRenderer(content: ServiceLockScreen(d: d).frame(width: w.lock).fixedSize(horizontal: false, vertical: true))
                let lh = try #require(lock.uiImage).size.height
                #expect(lh <= 160, "Lock Screen \(name) at \(w.name): \(lh) pt (iOS truncates past 160)")
            }
        }
    }
}
