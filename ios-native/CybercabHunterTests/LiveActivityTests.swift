import Testing
import Foundation
import SwiftUI
import ActivityKit
@testable import CybercabHunter

// The service-status Live Activity: the switch (off by default, persisted,
// never re-enabled by itself), the service-day logic shared with the Live now
// card (past midnight, daylight saving), reconciling at launch, staleness, and each
// presentation rendered. ActivityKit itself is replaced by a fake.

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
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = ServiceSchedule.timeZone; f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f.date(from: s)!
}
private func wall(_ d: Date) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = ServiceSchedule.timeZone; f.dateFormat = "yyyy-MM-dd HH:mm zzz"
    return f.string(from: d)
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

    // 3, 4: start and end

    @Test func enablingStartsWithTheCardsStatusAndDisablingEndsIt() async {
        let (c, fake, _) = make()
        let now = central("2026-10-26 17:55:00")
        await c.setEnabled(true, now: now)
        #expect(fake.started.count == 1)
        let (attrs, state, stale) = fake.started[0]
        #expect(state.live && wall(state.until) == "2026-10-27 02:00 CDT" && stale == state.until, "until 2 AM; stale from then")
        #expect(attrs.openLabel == "6:00 AM" && attrs.closeLabel == "2:00 AM")
        #expect(ServiceSchedule.countdown(from: now, to: state.until) == "8h 5m", "the Live now card's countdown")
        await c.setEnabled(false)
        #expect(fake.running.isEmpty && fake.endAllCalls == 1 && !c.enabled)
    }

    // 5, 6, 7: active, parked, past midnight (6 AM to 2 AM)

    @Test func activeAndParkedStatusAcrossMidnight() {
        let s = ServiceSchedule.standard
        #expect(s == ServiceSchedule(open: "06:00", close: "02:00"), "the API's 6 AM to 2 AM")
        #expect(s.label(s.openMinute) == "6:00 AM" && s.label(s.closeMinute) == "2:00 AM")
        let noon = s.status(at: central("2026-10-26 12:00:00"))
        #expect(noon.live && wall(noon.since) == "2026-10-26 06:00 CDT" && wall(noon.until) == "2026-10-27 02:00 CDT")
        let pastMidnight = s.status(at: central("2026-10-27 00:30:00"))
        #expect(pastMidnight.live && wall(pastMidnight.since) == "2026-10-26 06:00 CDT" && wall(pastMidnight.until) == "2026-10-27 02:00 CDT", "12:30 AM is the day before's service")
        let lastMinute = s.status(at: central("2026-10-27 01:59:30"))
        #expect(lastMinute.live && ServiceSchedule.countdown(from: central("2026-10-27 01:59:30"), to: lastMinute.until) == "1m")
        let parked = s.status(at: central("2026-10-27 02:00:00"))
        #expect(!parked.live && wall(parked.since) == "2026-10-27 02:00 CDT" && wall(parked.until) == "2026-10-27 06:00 CDT", "parks at 2:00 AM")
        let midnightClose = ServiceSchedule(open: "06:00", close: "24:00")
        #expect(!midnightClose.status(at: central("2026-10-27 00:30:00")).live, "an older server's 24:00 still closes at midnight")
        let early = s.status(at: central("2026-10-27 05:59:00"))
        #expect(!early.live && ServiceSchedule.countdown(from: central("2026-10-27 05:59:00"), to: early.until) == "1m")
        let open = s.status(at: central("2026-10-27 06:00:00"))
        #expect(open.live, "6:00:00 AM is open")
        let hours = ServiceSchedule(open: "07:30", close: "22:00")
        #expect(!hours.status(at: central("2026-10-26 22:15:00")).live && wall(hours.status(at: central("2026-10-26 22:15:00")).until) == "2026-10-27 07:30 CDT", "the API's hours, when they differ")
    }

    // 8: daylight saving

    @Test func daylightSavingKeepsWallClockTimes() {
        let s = ServiceSchedule.standard
        // Spring forward (Sun Mar 8, 2026: 2 AM → 3 AM): 2 AM doesn't exist, so service
        // ends when it would have, 3:00 AM CDT; parked until 6:00 AM CDT.
        let spring = s.status(at: central("2026-03-08 04:00:00"))
        #expect(!spring.live && wall(spring.until) == "2026-03-08 06:00 CDT" && wall(spring.since) == "2026-03-08 03:00 CDT")
        #expect(spring.until.timeIntervalSince(spring.since) == 3 * 3600, "a 23-hour day: 3 real hours parked")
        let springLate = s.status(at: central("2026-03-08 01:30:00"))
        #expect(springLate.live && wall(springLate.until) == "2026-03-08 03:00 CDT", "1:30 AM CST still runs, to 3:00 AM CDT")
        // Fall back (Sun Nov 1, 2026: 2 AM → 1 AM): runs through both 1 AMs, parked from 2:00 AM CST.
        let fall = s.status(at: central("2026-11-01 04:00:00"))
        #expect(!fall.live && wall(fall.since) == "2026-11-01 02:00 CST" && wall(fall.until) == "2026-11-01 06:00 CST")
        #expect(fall.until.timeIntervalSince(fall.since) == 4 * 3600, "4 real hours parked")
        let fallDay = s.status(at: central("2026-11-01 12:00:00"))
        #expect(fallDay.live && wall(fallDay.until) == "2026-11-02 02:00 CST")
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

    // 15, 16: restart reconciliation, expiry and staleness

    @Test func launchReconcilesWhatIsRunning() async {
        let (c, fake, _) = make()
        await c.setEnabled(true, now: central("2026-10-26 12:00:00"))
        // Next morning: the old state (and a duplicate) still around.
        let old = fake.running[0]
        fake.running = [old, old]
        await c.reconcile(now: central("2026-10-27 03:00:00"))
        #expect(fake.updates.count == 1 && !fake.updates[0].0.live && fake.running.count == 1, "updated to parked; the duplicate ended")
        // Nothing changed: no update.
        await c.reconcile(now: central("2026-10-27 04:00:00"))
        #expect(fake.updates.count == 1, "same state, not re-sent")
        // iOS ended it (about 8 hours): the next launch starts a fresh one while the switch is on.
        fake.running = []
        await c.reconcile(now: central("2026-10-27 09:00:00"))
        #expect(fake.started.count == 2 && fake.started[1].1.live)
        // Switched off: a launch finds one left over and ends it, and never re-enables.
        await c.setEnabled(false)
        fake.running = [old]
        await c.reconcile()
        #expect(fake.running.isEmpty && !c.enabled && fake.started.count == 2)
    }

    @Test func expiryAndStalenessAreShownNotHidden() async {
        let fake = FakeActivityBackend(); fake.failStart = true
        let (c, _, _) = make(fake)
        await c.setEnabled(true)
        #expect(c.problem == .couldNotStart)
        let stale = ServiceActivityDisplay(live: true, since: central("2026-10-26 06:00:00"), until: central("2026-10-27 00:00:00"), stale: true, openLabel: "6:00 AM", closeLabel: "2:00 AM")
        #expect(stale.headline == "Status needs updating" && stale.badge == "NOT UPDATED", "past its change with no update: says so instead of a wrong 'live'")
        let parked = ServiceActivityDisplay(live: false, since: central("2026-10-27 00:00:00"), until: central("2026-10-27 06:00:00"), stale: false, openLabel: "6:00 AM", closeLabel: "2:00 AM")
        #expect(parked.badge == "PARKED" && parked.countdownLead == "Back on the road in")
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

    // New hours: an activity started with the old ones (its details can't be
    // updated) is replaced by one with the new hours, once.
    @Test func newHoursReplaceAnActivityShowingTheOldOnes() async {
        let (c, fake, _) = make()
        c.schedule = ServiceSchedule(open: "06:00", close: "24:00")
        await c.setEnabled(true, now: central("2026-10-26 12:00:00"))
        #expect(fake.started.count == 1 && fake.started[0].0.closeLabel == "12:00 AM")
        c.schedule = .standard
        await c.reconcile(now: central("2026-10-26 12:05:00"))
        #expect(fake.endAllCalls == 1 && fake.started.count == 2 && fake.started[1].0.closeLabel == "2:00 AM" && fake.running.count == 1, "ended and started again with 6:00 AM – 2:00 AM")
        await c.reconcile(now: central("2026-10-26 12:10:00"))
        #expect(fake.started.count == 2 && fake.endAllCalls == 1, "the same hours: left alone")
    }

    // The 24-hour track: the service window (two pieces past midnight) and the stretches the system fills.
    @Test func dayTrackPlacesTheWindowAndTheRun() {
        func display(_ s: ServiceSchedule.Status, stale: Bool = false) -> ServiceActivityDisplay {
            ServiceActivityDisplay(live: s.live, since: s.since, until: s.until, stale: stale, openLabel: "6:00 AM", closeLabel: "2:00 AM")
        }
        func near(_ a: ClosedRange<CGFloat>, _ b: ClosedRange<CGFloat>) -> Bool { abs(a.lowerBound - b.lowerBound) < 0.001 && abs(a.upperBound - b.upperBound) < 0.001 }
        let oneAM: CGFloat = 120.0 / 1440   // 2 AM on the track
        let live = display(ServiceSchedule.standard.status(at: central("2026-10-26 19:51:00")))
        #expect(live.servicePieces.count == 2 && near(live.servicePieces[0], 0.25...1) && near(live.servicePieces[1], 0...oneAM), "6 AM to the right edge, then 12 AM to 2 AM")
        #expect(live.runs.count == 2 && near(live.runs[0].span, 0.25...1) && near(live.runs[1].span, 0...oneAM))
        #expect(wall(live.runs[0].time.upperBound) == "2026-10-27 00:00 CDT" && live.runs[1].time.lowerBound == live.runs[0].time.upperBound && wall(live.runs[1].time.upperBound) == "2026-10-27 02:00 CDT", "each piece fills in its own time, split at midnight")
        let late = display(ServiceSchedule.standard.status(at: central("2026-10-27 00:30:00")))
        #expect(late.live && late.runs.count == 2, "12:30 AM: live, the first piece full, the second filling")
        let night = display(ServiceSchedule.standard.status(at: central("2026-10-27 03:00:00")))
        #expect(night.servicePieces.count == 2 && night.runs.count == 1 && near(night.runs[0].span, oneAM...0.25), "parked: the window stays put; the night (2 AM to 6 AM) fills")
        let stale = display(ServiceSchedule.standard.status(at: central("2026-10-26 19:51:00")), stale: true)
        #expect(stale.runs.isEmpty, "stale: nothing claims to move")
        let midnightClose = display(ServiceSchedule(open: "06:00", close: "24:00").status(at: central("2026-10-26 12:00:00")))
        #expect(midnightClose.servicePieces.count == 1 && midnightClose.runs.count == 1 && near(midnightClose.runs[0].span, 0.25...1), "an older server's 6 AM to 12 AM: one piece")
        let custom = display(ServiceSchedule(open: "07:30", close: "22:00").status(at: central("2026-10-26 22:15:00")))
        #expect(custom.servicePieces.count == 1 && near(custom.servicePieces[0], 0.3125...(1320.0 / 1440)))
        #expect(custom.runs.isEmpty, "a night across midnight isn't drawn as one bar")
        #expect(live.headline == "Cybercabs are on the road now" && night.headline == "The fleet is parked for the night", "the website's words")
    }

    // The Home screen's Live now card (with its animated car and road) at each
    // iPhone width, for review: the car sits center-right beside the headline.
    @Test func homeCardRendersAtEachWidth() throws {
        try? FileManager.default.createDirectory(atPath: "/tmp/cch-shots", withIntermediateDirectories: true)
        for (name, w) in [("se", 343.0), ("16", 361.0), ("max", 408.0)] {
            let card = ServiceStatusCard(hours: nil).frame(width: w).padding(16)
                .background(Color(red: 8 / 255, green: 9 / 255, blue: 10 / 255)).environment(\.colorScheme, .dark)
            let r = ImageRenderer(content: card); r.scale = 3
            let image = try #require(r.uiImage, "the card renders at \(name)")
            #expect(image.size.height > 200)
            try image.pngData()?.write(to: URL(fileURLWithPath: "/tmp/cch-shots/home-live-card-\(name).png"))
        }
    }

    // 9–12: every presentation renders, live, parked and stale, at each iPhone
    // width, in light and dark, inside the Dynamic Island's limits.
    @Test func presentationsRender() throws {
        try? FileManager.default.createDirectory(atPath: "/tmp/cch-shots", withIntermediateDirectories: true)
        #expect(UIImage(named: "CybercabLive") != nil, "the Cybercab image is in the bundle")
        let live = ServiceActivityDisplay(live: true, since: central("2026-10-26 06:00:00"), until: .now.addingTimeInterval(3600 * 4 + 540), stale: false, openLabel: "6:00 AM", closeLabel: "2:00 AM")
        let parked = ServiceActivityDisplay(live: false, since: central("2026-10-27 02:00:00"), until: .now.addingTimeInterval(3600 * 4), stale: false, openLabel: "6:00 AM", closeLabel: "2:00 AM")
        let stale = ServiceActivityDisplay(live: true, since: central("2026-10-26 06:00:00"), until: .now.addingTimeInterval(-3600), stale: true, openLabel: "6:00 AM", closeLabel: "2:00 AM")
        // Lock Screen and expanded widths: iPhone SE / 16 / 16 Pro Max.
        let widths: [(name: String, lock: CGFloat, island: CGFloat)] = [("se", 359, 355), ("16", 377, 371), ("max", 424, 408)]
        for (name, d) in [("live", live), ("parked", parked), ("stale", stale)] {
            for scheme in [ColorScheme.dark, .light] {
                let rows = VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 30) {
                        HStack { ServiceCompactLeading(d: d); Spacer(); ServiceCompactTrailing(d: d) }
                            .padding(.horizontal, 12).frame(width: 250, height: 37).background(.black, in: Capsule())
                        ServiceMinimal(d: d).frame(width: 37, height: 37).background(.black, in: Circle())
                    }
                    ForEach(widths, id: \.name) { w in
                        VStack(spacing: 6) {
                            HStack(alignment: .center) { ServiceExpandedLeading(d: d); Spacer() }.frame(height: 24)
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
            // The expanded island is at most 160 pt tall: the top row plus the bottom region must fit.
            for w in widths {
                let bottom = ImageRenderer(content: ServiceExpandedBottom(d: d).frame(width: w.island - 24).fixedSize(horizontal: false, vertical: true))
                let h = try #require(bottom.uiImage).size.height
                #expect(h + 24 + 12 <= 160, "expanded \(name) at \(w.name): \(h) pt")
                let lock = ImageRenderer(content: ServiceLockScreen(d: d).frame(width: w.lock).fixedSize(horizontal: false, vertical: true))
                let lh = try #require(lock.uiImage).size.height
                #expect(lh <= 160, "Lock Screen \(name) at \(w.name): \(lh) pt (iOS truncates past 160)")
            }
        }
    }
}
