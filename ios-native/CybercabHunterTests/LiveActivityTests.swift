import Testing
import Foundation
import SwiftUI
import ActivityKit
@testable import CybercabHunter

// The service-status Live Activity: the switch (off by default, persisted,
// never re-enabled by itself), the service-day logic shared with the Live now
// card (midnight, daylight saving), reconciling at launch, staleness, and each
// presentation rendered. ActivityKit itself is replaced by a fake.

@MainActor
final class FakeActivityBackend: ServiceActivityBackend {
    var isSupported = true
    var isAuthorized = true
    var running: [ServiceActivityAttributes.ContentState] = []
    var started: [(ServiceActivityAttributes, ServiceActivityAttributes.ContentState, Date)] = []
    var updates: [(ServiceActivityAttributes.ContentState, Date)] = []
    var endAllCalls = 0
    var failStart = false

    func start(_ attributes: ServiceActivityAttributes, _ state: ServiceActivityAttributes.ContentState, staleDate: Date) throws {
        if failStart { throw CancellationError() }
        started.append((attributes, state, staleDate)); running.append(state)
    }
    func update(_ state: ServiceActivityAttributes.ContentState, staleDate: Date) async {
        updates.append((state, staleDate)); running = [state]
    }
    func endAll() async { endAllCalls += 1; running = [] }
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
        #expect(state.live && wall(state.until) == "2026-10-27 00:00 CDT" && stale == state.until, "until midnight; stale from then")
        #expect(attrs.openLabel == "6:00 AM" && attrs.closeLabel == "12:00 AM")
        #expect(ServiceSchedule.countdown(from: now, to: state.until) == "6h 5m", "the Live now card's countdown")
        await c.setEnabled(false)
        #expect(fake.running.isEmpty && fake.endAllCalls == 1 && !c.enabled)
    }

    // 5, 6, 7: active, parked, midnight

    @Test func activeAndParkedStatusAcrossMidnight() {
        let s = ServiceSchedule.standard
        let noon = s.status(at: central("2026-10-26 12:00:00"))
        #expect(noon.live && wall(noon.since) == "2026-10-26 06:00 CDT" && wall(noon.until) == "2026-10-27 00:00 CDT")
        let lastMinute = s.status(at: central("2026-10-26 23:59:30"))
        #expect(lastMinute.live && wall(lastMinute.until) == "2026-10-27 00:00 CDT")
        let pastMidnight = s.status(at: central("2026-10-27 00:00:30"))
        #expect(!pastMidnight.live && wall(pastMidnight.since) == "2026-10-27 00:00 CDT" && wall(pastMidnight.until) == "2026-10-27 06:00 CDT")
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
        // Spring forward (Sun Mar 8, 2026: 2 AM → 3 AM): parked overnight, opens 6:00 AM CDT.
        let spring = s.status(at: central("2026-03-08 04:00:00"))
        #expect(!spring.live && wall(spring.until) == "2026-03-08 06:00 CDT" && wall(spring.since) == "2026-03-08 00:00 CST")
        #expect(spring.until.timeIntervalSince(spring.since) == 5 * 3600, "a 23-hour day: 5 real hours from midnight to 6 AM")
        // Fall back (Sun Nov 1, 2026: 2 AM → 1 AM): opens 6:00 AM CST.
        let fall = s.status(at: central("2026-11-01 04:00:00"))
        #expect(!fall.live && wall(fall.until) == "2026-11-01 06:00 CST")
        #expect(fall.until.timeIntervalSince(fall.since) == 7 * 3600, "a 25-hour day: 7 real hours")
        let fallDay = s.status(at: central("2026-11-01 12:00:00"))
        #expect(fallDay.live && wall(fallDay.until) == "2026-11-02 00:00 CST")
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
        await c.reconcile(now: central("2026-10-27 01:00:00"))
        #expect(fake.updates.count == 1 && !fake.updates[0].0.live && fake.running.count == 1, "updated to parked; the duplicate ended")
        // Nothing changed: no update.
        await c.reconcile(now: central("2026-10-27 02:00:00"))
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
        let stale = ServiceActivityDisplay(live: true, since: central("2026-10-26 06:00:00"), until: central("2026-10-27 00:00:00"), stale: true, openLabel: "6:00 AM", closeLabel: "12:00 AM")
        #expect(stale.headline == "Status needs updating" && stale.badge == "NOT UPDATED", "past its change with no update: says so instead of a wrong 'live'")
        let parked = ServiceActivityDisplay(live: false, since: central("2026-10-27 00:00:00"), until: central("2026-10-27 06:00:00"), stale: false, openLabel: "6:00 AM", closeLabel: "12:00 AM")
        #expect(parked.badge == "PARKED" && parked.countdownLead == "Back on the road in")
    }

    // The 24-hour track: the service window and the stretch the system fills.
    @Test func dayTrackPlacesTheWindowAndTheRun() {
        func display(_ s: ServiceSchedule.Status, stale: Bool = false) -> ServiceActivityDisplay {
            ServiceActivityDisplay(live: s.live, since: s.since, until: s.until, stale: stale, openLabel: "6:00 AM", closeLabel: "12:00 AM")
        }
        let live = display(ServiceSchedule.standard.status(at: central("2026-10-26 19:51:00")))
        #expect(live.serviceSpan == 0.25...1 && live.runSpan == 0.25...1, "6 AM to the right edge (midnight), filled up to now")
        let night = display(ServiceSchedule.standard.status(at: central("2026-10-27 01:00:00")))
        #expect(night.serviceSpan == 0.25...1 && night.runSpan == 0...0.25, "parked: the window stays put; the night fills")
        let stale = display(ServiceSchedule.standard.status(at: central("2026-10-26 19:51:00")), stale: true)
        #expect(stale.runSpan == nil, "stale: nothing claims to move")
        let late = ServiceSchedule(open: "07:30", close: "22:00")
        let wrap = display(late.status(at: central("2026-10-26 22:15:00")))
        #expect(abs(wrap.serviceSpan.lowerBound - 0.3125) < 0.001 && abs(wrap.serviceSpan.upperBound - 1320.0 / 1440) < 0.001)
        #expect(wrap.runSpan == nil, "a night across midnight isn't drawn as one bar")
        #expect(live.headline == "Cybercabs are on the road now" && night.headline == "The fleet is parked for the night", "the website's words")
    }

    // The Home screen's Live now card (with its animated car and road) at each
    // iPhone width, for review: the car sits center-right beside the headline.
    @Test func homeCardRendersAtEachWidth() throws {
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
        let live = ServiceActivityDisplay(live: true, since: central("2026-10-26 06:00:00"), until: .now.addingTimeInterval(3600 * 4 + 540), stale: false, openLabel: "6:00 AM", closeLabel: "12:00 AM")
        let parked = ServiceActivityDisplay(live: false, since: central("2026-10-27 00:00:00"), until: .now.addingTimeInterval(3600 * 5), stale: false, openLabel: "6:00 AM", closeLabel: "12:00 AM")
        let stale = ServiceActivityDisplay(live: true, since: central("2026-10-26 06:00:00"), until: .now.addingTimeInterval(-3600), stale: true, openLabel: "6:00 AM", closeLabel: "12:00 AM")
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
