import Testing
import Foundation
@testable import CybercabHunter

// Phase 7: the website's remaining pages. The Simulation math is checked
// against values computed by the website's own public/js/calc.js (node);
// /api/fleet-eta fixtures are real production answers (read only); the
// Rider data and Receipt sync fixtures are real Worker answers from the
// isolated test Worker (scripts/community-test-server.mjs --fixtures).

private func json(_ o: Any) -> String { String(decoding: try! JSONSerialization.data(withJSONObject: o), as: UTF8.self) }

struct SimulationCalcTests {
    @Test func fleetFinancialsMatchCalcJs() {
        // calc.js fleetFinancials with the page's locked assumptions.
        let a = SimulationCalc.fleetFinancials(fleetSize: 10, electricityRate: 0.12, dailyMiles: 150, lossOn: true)
        #expect(a.grossRevenue == 90_000 && a.teslaCut == 22_500 && abs(a.monthlyEnergyOverhead - 1458) < 1e-6 && abs(a.netOperatingIncome - 66_042) < 1e-6 && a.breakevenMonths == 4.5)
        let b = SimulationCalc.fleetFinancials(fleetSize: 1, electricityRate: 0.4, dailyMiles: 400, lossOn: false)
        #expect(b.grossRevenue == 24_000 && abs(b.monthlyEnergyOverhead - 1200) < 1e-6 && abs(b.netOperatingIncome - 16_800) < 1e-6 && b.breakevenMonths == 1.8)
        let c = SimulationCalc.fleetFinancials(fleetSize: 100, electricityRate: 0.05, dailyMiles: 20, lossOn: true)
        #expect(c.grossRevenue == 120_000 && abs(c.monthlyEnergyOverhead - 810) < 1e-6 && abs(c.netOperatingIncome - 89_190) < 1e-6 && c.breakevenMonths == 33.6)
        let d = SimulationCalc.fleetFinancials(fleetSize: 5, electricityRate: 0.12, dailyMiles: 0, lossOn: true)
        #expect(d.grossRevenue == 0 && d.breakevenMonths == nil, "no income: never breaks even (the site's Infinity)")
        #expect(SimulationCalc.chartMonths(breakeven: nil) == 24 && SimulationCalc.chartMonths(breakeven: 1.8) == 6 && SimulationCalc.chartMonths(breakeven: 33.6) == 44 && SimulationCalc.chartMonths(breakeven: 90) == 60)
    }

    @Test func geometryMatchesCalcJsEtaRange() {
        #expect(SimulationCalc.geometry(fleetSize: 196, tier: "typical", city: "austin") == .ok(low: 3, likely: 5, high: 9, highCapped: false))
        #expect(SimulationCalc.geometry(fleetSize: 196, tier: "busy", city: "austin") == .ok(low: 4, likely: 8, high: 20, highCapped: false), "272 mi² Austin zone (Oct 23, 2026); calc.js gives the same")
        #expect(SimulationCalc.geometry(fleetSize: 30, tier: "quiet", city: "dallas") == .ok(low: 4, likely: 6, high: 9, highCapped: false))
        #expect(SimulationCalc.geometry(fleetSize: 1000, tier: "quiet", city: "austin") == .ok(low: 2, likely: 3, high: 4, highCapped: false))
        #expect(SimulationCalc.geometry(fleetSize: 3, tier: "typical", city: "dallas") == .fewCars)
        #expect(SimulationCalc.geometry(fleetSize: nil, tier: "typical", city: "austin") == .noData)
        #expect(SimulationCalc.geometry(fleetSize: 0, tier: "typical", city: "austin") == .noData)
    }

    @Test func rangesAndLabelsMatchCalcJs() {
        typealias R = SimulationCalc.Range
        #expect(SimulationCalc.dollarRange(R(center: 6.5, lo: 6.4, hi: 6.6)) == "$6–$7")
        #expect(SimulationCalc.dollarRange(R(center: 5, lo: 0.2, hi: 11.01)) == "$1–$12")
        #expect(SimulationCalc.minuteRange(R(center: 4, lo: 3.9, hi: 4.1)) == "3–5 min")
        #expect(SimulationCalc.minuteRange(R(center: 30, lo: 12, hi: 50)) == "12–45+ min")
        #expect(SimulationCalc.dollarRange(nil) == nil && SimulationCalc.minuteRange(nil) == nil, "no model: no number")
        #expect(["12:00 AM", "6:00 AM", "12:30 PM", "12:00 AM"] == [0, 360, 750, 1440].map(SimulationCalc.clockLabel))
    }

    @Test func centralTimeSlotsAndServiceHours() {
        let iso = ISO8601DateFormatter()
        func at(_ s: String) -> Date { iso.date(from: s)! }
        // Same four moments as calc.js etaSlot / serviceStatus (America/Chicago).
        #expect(SimulationCalc.slot(at("2026-10-23T23:30:00Z")) == .init(key: "weekday:afternoon", day: "Friday", part: "afternoon"))
        #expect(SimulationCalc.slot(at("2026-10-24T05:10:00Z")) == .init(key: "weekend:overnight", day: "Saturday", part: "overnight"))
        #expect(SimulationCalc.slot(at("2026-10-21T16:00:00Z")).key == "weekday:midday")
        let open = SimulationCalc.serviceStatus(at("2026-10-23T23:30:00Z"))
        #expect(open.open && open.minuteOfDay == 1110 && open.label == "Operating now")
        let closed = SimulationCalc.serviceStatus(at("2026-10-22T10:59:00Z"))
        #expect(!closed.open && closed.minuteOfDay == 359 && closed.label == "Opens 6:00 AM")
        // 6 AM to 1 AM: 12:30 AM is still the day before's service; 1:00 AM is parked.
        #expect(SimulationCalc.serviceStatus(at("2026-10-23T05:30:00Z")).open && !SimulationCalc.serviceStatus(at("2026-10-23T06:00:00Z")).open)
        #expect(SimulationCalc.clockLabel(SimulationCalc.closeMinute) == "1:00 AM" && SimulationCalc.hourPieces.map(\.start) == [360, 0])
        #expect(SimulationCalc.isStale("2026-10-20T00:00:00Z", now: at("2026-10-21T13:00:00Z")) && !SimulationCalc.isStale("2026-10-21T00:00:00Z", now: at("2026-10-21T12:00:00Z")))
        #expect(SimulationCalc.isStale(nil, now: .now), "no timestamp counts as stale")
    }
}

struct FleetEtaDecodingTests {
    @Test func productionAnswersDecodeAndPriceLikeTheSite() throws {
        let austin: FleetEta = try TestFixtures.decode("fleet-eta-austin")
        let dallas: FleetEta = try TestFixtures.decode("fleet-eta-dallas")
        #expect(austin.city == "austin" && dallas.city == "dallas")
        // Dallas: no Cybercab estimate (never Austin's numbers reused); Model Y from published reports.
        #expect(dallas.byVehicle("cybercab")?.use == "none" && dallas.fareModel(for: "cybercab") == nil)
        #expect(dallas.byVehicle("model_y")?.use == "external")
        // Same as calc.js etaFareRange(model, 5 mi, typical) → dollarRange on these fixtures.
        let aRange = SimulationCalc.fareRange(austin.fares.models["external"] ?? nil, miles: 5, tier: "typical", area: nil)
        let dRange = SimulationCalc.fareRange(dallas.fares.models["external"] ?? nil, miles: 5, tier: "typical", area: nil)
        #expect(SimulationCalc.dollarRange(aRange) == "$10–$14" && SimulationCalc.dollarRange(dRange) == "$8–$10")
        #expect(dallas.areaLabel("park_cities") == "Highland Park & University Park", "area keys stay snake_case (they're values)")
        #expect(austin.slotTiers?.count == 10)
    }

    @Test func snakeCaseAreaKeysAreFoundAfterTheDecoderCamelCasesThem() throws {
        // Area keys may arrive as park_cities or (camel-cased by the app's decoder) parkCities: lookup finds either.
        let body = json(["basis": "observed", "n": 12, "a": 2, "b": 1.5, "tiers": ["typical": ["center": 1, "lo": 0.8, "hi": 1.25]], "area_mult": ["park_cities": 1.2]])
        let m = try APIClient.makeDecoder().decode(FleetEta.FareModel.self, from: Data(body.utf8))
        #expect(FleetEta.lookup(m.areaMult, "park_cities") == 1.2)
        #expect(FleetEta.lookup(["parkCities": 1.3], "park_cities") == 1.3 && FleetEta.lookup(["downtown": 1.1], "downtown") == 1.1)
        // (2 + 1.5 × 4) × 1.2 = 9.6 → 7.68…12 → "$7–$12" (calc.js gives the same).
        let r = SimulationCalc.fareRange(m, miles: 4, tier: "typical", area: "park_cities")
        #expect(SimulationCalc.dollarRange(r) == "$7–$12")
        #expect(SimulationCalc.fareRange(m, miles: 4, tier: "busy", area: nil)?.center == 8, "an unknown tier falls back to typical")
        #expect(SimulationCalc.fareRange(m, miles: 0, tier: "typical", area: nil) == nil, "no distance: no fare")
    }
}

@MainActor
struct FareReportTests {
    @Test func bodyMatchesTheWebsiteForm() throws {
        let m = SimulationModel()
        m.report.city = "dallas"; m.report.kind = "completed"; m.report.vehicle = "model_y"
        m.report.pickup = "uptown"; m.report.fare = "12.40"; m.report.miles = " 3.1 "; m.report.duration = "14"; m.report.actualWait = "6"
        let b = m.reportBody()
        #expect(b["city"] as? String == "dallas" && b["vehicle_type"] as? String == "model_y" && b["pickup_area"] as? String == "uptown")
        #expect(b["dropoff_area"] is NSNull && b["quoted_wait_minutes"] is NSNull, "empty fields are null")
        #expect(b["quoted_fare"] as? String == "12.40" && b["distance_miles"] as? String == "3.1", "fare and distance as typed, as the site sends them")
        #expect(b["duration_minutes"] as? Int == 14 && b["actual_wait_minutes"] as? Int == 6 && b["no_cars_available"] as? Bool == false)
        #expect((b["observed_at"] as? String)?.hasSuffix("Z") == true)
    }

    @Test func sendingNeedsASessionAndShowsTheSitesErrors() async {
        let s = StubServer(), api = s.api()
        let m = SimulationModel()
        await m.sendReport(api: api, signedIn: false)
        #expect(m.reportStatus == "Sign in to send a report." && s.requests.isEmpty, "nothing is sent signed out")
        s.responses["POST /api/fare-reports"] = (429, #"{"success":false,"error":"rate_limited"}"#)
        await m.sendReport(api: api, signedIn: true)
        #expect(m.reportStatus == "That is the daily limit of 10 reports. Thank you!")
        s.responses["POST /api/fare-reports"] = (201, #"{"success":true}"#)
        m.report.fare = "9"
        await m.sendReport(api: api, signedIn: true)
        #expect(m.reportStatus.hasPrefix("Thanks!") && m.report.fare.isEmpty)
        #expect(s.requests.last?.0.value(forHTTPHeaderField: "Authorization") == "Bearer s-test")
    }
}

@MainActor
struct NewsModelTests {
    private func story(_ id: String, _ at: String, importance: Int = 0, url: String = "https://example.com/a", thumb: String? = nil, image: String? = nil) -> [String: Any] {
        var s: [String: Any] = ["id": id, "title": "T \(id)", "url": url, "source": "electrek", "source_type": "press", "published_at": at, "importance": importance]
        if let thumb { s["thumb_url"] = thumb }
        if let image { s["image_url"] = image }
        return s
    }

    @Test func storiesKeepOnlySafeLinksAndImages() throws {
        let page = json(["stories": [
            story("a", "2026-10-22T15:00:00Z", importance: 2, thumb: "/news-img/0e0b2f8e-1111-4222-8333-444455556666.webp"),
            story("b", "2026-10-22T14:00:00Z", url: "http://insecure.example/x", image: "http://insecure.example/i.jpg"),
            story("c", "2026-10-21T14:00:00Z", thumb: "/elsewhere.png", image: "https://cdn.example/i.jpg")
        ], "next_cursor": NSNull()])
        let p = try APIClient.makeDecoder().decode(NewsPage.self, from: Data(page.utf8))
        #expect(p.stories[0].isMajor && p.stories[0].thumbnail?.path() == "/news-img/0e0b2f8e-1111-4222-8333-444455556666.webp")
        #expect(p.stories[1].link == nil && p.stories[1].thumbnail == nil, "http is never opened or loaded")
        #expect(p.stories[2].thumbnail?.absoluteString == "https://cdn.example/i.jpg", "an odd thumb path falls back to the feed's https image")
        #expect(p.stories[1].initial == "E", "no image: the outlet's initial")
    }

    @Test func loadsGroupsByAustinDayAndAppendsWithoutDuplicates() async {
        let s = StubServer(), api = s.api()
        s.responses["GET /api/news"] = (200, json(["stories": [story("a", "2026-10-22T15:00:00Z"), story("b", "2026-10-22T04:00:00Z")], "next_cursor": "c1", "disclosure": "Summaries are automatic."]))
        let m = NewsModel()
        await m.reload(api: api)
        #expect(m.state == .ready && m.stories.count == 2 && m.cursor == "c1" && m.disclosure == "Summaries are automatic.")
        // 04:00Z is 11 PM the day before in Austin.
        let now = ISO8601DateFormatter().date(from: "2026-10-22T18:00:00Z")!
        #expect(NewsModel.dayLabel("2026-10-22T15:00:00Z", now: now) == "Today" && NewsModel.dayLabel("2026-10-22T04:00:00Z", now: now) == "Yesterday")
        s.responses["GET /api/news"] = (200, json(["stories": [story("b", "2026-10-22T04:00:00Z"), story("c", "2026-10-20T04:00:00Z")], "next_cursor": NSNull()]))
        await m.loadMore(api: api)
        #expect(m.stories.map(\.id) == ["a", "b", "c"] && m.cursor == nil)
        m.filter = .major; m.query = "dallas"
        s.responses["GET /api/news"] = (500, "{}")
        await m.reload(api: api)
        #expect(m.state == .failed)
        let q = s.requests.last?.0.url?.query() ?? ""
        #expect(q.contains("importance=2") && q.contains("q=dallas") && q.contains("limit=20"))
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil }, "news is public")
    }

    @Test func agoLabels() {
        let now = ISO8601DateFormatter().date(from: "2026-10-22T18:00:00Z")!
        #expect(NewsModel.ago("2026-10-22T17:59:50Z", now: now) == "just now")
        #expect(NewsModel.ago("2026-10-22T17:15:00Z", now: now) == "45m ago")
        #expect(NewsModel.ago("2026-10-22T13:00:00Z", now: now) == "5h ago")
        #expect(NewsModel.ago(nil, now: now) == "")
    }
}

@MainActor
struct DMVRosterTests {
    @Test func vinSearchIsCleanedLikeTheSite() {
        #expect(DMVRosterModel.cleaned(" 7sa-ygdef 5ta ") == "7SAYGDEF5TA")
        #expect(DMVRosterModel.cleaned("ÄBC123") == "BC123", "letters and digits A–Z 0–9 only")
        #expect(DMVRosterModel.cleaned(String(repeating: "A", count: 30)).count == 17)
    }

    @Test func pagesAndCounts() async {
        let s = StubServer(), api = s.api()
        let row: (String, Bool) -> [String: Any] = { vin, new in ["vin": vin, "model": "Cybercab", "model_year": 2026, "model_class": "cybercab", "decode_status": "verified", "first_detected": "2026-10-22", "last_confirmed": "2026-10-23", "baseline": false, "is_new": new, "listed": true] }
        s.responses["GET /api/dmv/vins"] = (200, json(["total": 3, "limit": 50, "offset": 0, "new_date": "2026-10-22", "years": [2026], "vehicles": [row("7SAYGDEF5TA000000", true), row("7SAYGDEF5TA000001", false)]]))
        let m = DMVRosterModel()
        m.cache = DMVResponseCache()
        m.model = "cybercab"
        m.year = 2026
        await m.reload(api: api)
        #expect(m.countLine == "2 of 3 VINs" && m.vehicles.first?.modelYear == 2026 && m.vehicles.first?.isNew == true && m.years == [2026])
        let q = s.requests.last?.0.url?.query() ?? ""
        #expect(q.contains("model=cybercab") && q.contains("year=2026") && q.contains("sort=first_seen") && q.contains("limit=50") && q.contains("offset=0") && !q.contains("q="))
        s.responses["GET /api/dmv/vins"] = (200, json(["total": NSNull(), "limit": 50, "offset": 2, "vehicles": [row("7SAYGDEF5TA000009", false)]]))
        await m.loadMore(api: api)
        #expect(m.vehicles.count == 3 && m.total == 3 && (s.requests.last?.0.url?.query() ?? "").contains("offset=2"), "later pages carry no total; the first page's is kept")
        m.model = "recent"
        m.sort = .vin
        m.query = "zz"
        s.responses["GET /api/dmv/vins"] = (200, json(["total": 0, "limit": 50, "offset": 0, "vehicles": []]))
        await m.reload(api: api)
        let q2 = s.requests.last?.0.url?.query() ?? ""
        #expect(m.countLine == "No VIN matches that search." && q2.contains("recent=1") && !q2.contains("model=") && q2.contains("sort=vin"))
        m.query = ""
        await m.reload(api: api)
        #expect(m.countLine == "No VINs match.")
        s.responses["GET /api/dmv/vins"] = (503, "{}")
        await m.reload(api: api, force: true)
        #expect(m.state == .failed && m.countLine == "Couldn't load the roster right now.")
    }
}

@MainActor
struct DMVTrackerTests {
    static let event: [String: Any] = ["date": "2026-10-22", "processed_at": "2026-10-22T11:31:00Z", "previous_date": "2026-10-21", "status": "ok", "added": 55, "returned": 0, "missing": 0, "net": 55, "total": 858, "added_by_model": ["cybercab": 2, "model_y": 53, "other_tesla": 0, "unknown": 0]]
    static let overview: [String: Any] = [
        "source": ["name": "TxDMV", "company": "Tesla Robotaxi, LLC", "authorization": "AV1", "law": "SB 2807", "url": "https://txmccs.txdmv.gov", "fields": ["VIN"], "schedule": "Daily", "decoder": ["name": "NHTSA vPIC", "url": "https://vpic.nhtsa.dot.gov"]],
        "latest": ["date": "2026-10-23", "polled_at": "2026-10-23T11:30:00Z"],
        "totals": ["cybercab": 351, "model_y": 507, "other_tesla": 0, "unknown": 0, "total": 858],
        "latest_update": event, "previous_snapshot": ["date": "2026-10-22", "total": 858, "net": 0],
        "freshness": ["status": "current", "last_success": "2026-10-23T11:30:00Z"],
        "milestones": [["metric": "total_listed", "threshold": 800, "date": "2026-10-17", "value": 803, "label": "800 vehicles on the roster"]],
        "insights": [["key": "latest_update", "text": "55 new VINs detected on Oct 22."]],
        "tracking_since": "2026-10-09", "recent_updates": [event], "update_count": 3]

    @Test func overviewAndGrowthDecode() async {
        let s = StubServer(), api = s.api()
        s.responses["GET /api/dmv/overview"] = (200, json(Self.overview))
        s.responses["GET /api/dmv/growth"] = (200, json(["range": "all", "enough_history": true, "points": [
            ["date": "2026-10-09", "total": 739, "cybercab": 319, "model_y": 420, "baseline": true, "added": NSNull()],
            ["date": "2026-10-22", "total": 858, "cybercab": 351, "model_y": 507, "baseline": false, "added": ["cybercab": 2, "model_y": 53, "other_tesla": 0, "unknown": 0]]]]))
        let m = DMVTrackerModel()
        m.cache = DMVResponseCache()
        await m.reload(api: api)
        #expect(m.state == .ready)
        #expect(m.overview?.totals?.cybercab == 351 && m.overview?.latestUpdate?.added == 55 && m.overview?.recentUpdates?.count == 1)
        #expect(m.additions.count == 1, "the baseline is never counted as new")
        #expect(DMVText.breakdown(m.overview?.latestUpdate?.addedByModel) == "2 Cybercab · 53 Model Y")
        // Back on the screen within 5 minutes: no new requests. Pull-to-refresh: fetched again.
        let before = s.requests.count
        await m.reload(api: api)
        #expect(s.requests.count == before, "cached for 5 minutes (no polling, no refetch on reappear)")
        await m.reload(api: api, force: true)
        #expect(s.requests.count == before + 2, "pull-to-refresh fetches the overview and the chart")
        s.responses["GET /api/dmv/overview"] = (503, "{}")
        let fresh = DMVTrackerModel()
        fresh.cache = DMVResponseCache()
        await fresh.reload(api: api)
        #expect(fresh.state == .failed)
    }

    @Test func classesAndFreshnessText() {
        #expect(DMVClass("model_y") == .modelY && DMVClass(nil) == .unknown && DMVClass("conflict") == .unknown)
        #expect(DMVText.freshness("current").label == "Current" && !DMVText.freshness("current").warn)
        #expect(DMVText.freshness("import_failed").warn && DMVText.freshness("source_unavailable").label == "Source unavailable")
        #expect(DMVText.decodeStatus("conflict").contains("unknown"))
    }

    @Test func historyFiltersAndVinDetail() async throws {
        let s = StubServer(), api = s.api()
        s.responses["GET /api/dmv/activity"] = (200, json(["total": 1, "limit": 20, "offset": 0, "baseline": ["date": "2026-10-09", "total": 739], "events": [Self.event]]))
        let h = DMVHistoryModel()
        h.cache = DMVResponseCache()
        h.kind = "additions"; h.model = "cybercab"
        await h.reload(api: api)
        let q = s.requests.last?.0.url?.query() ?? ""
        #expect(h.events.count == 1 && h.baseline?.total == 739 && q.contains("kind=additions") && q.contains("model=cybercab"))
        s.responses["GET /api/dmv/vins/7SAYGDEF5TA000000"] = (200, json(["vin": "7SAYGDEF5TA000000", "source": ["make": "Tesla", "model": "Model Y", "model_year": 2026],
            "decode": ["model_class": "model_y", "status": "verified", "plant": "FREMONT, CALIFORNIA", "check_digit_ok": true],
            "tracking": ["first_detected": "2026-10-09", "last_confirmed": "2026-10-23", "in_baseline": true, "listed": true, "latest_snapshot": "2026-10-23", "history": []],
            "registry": ["id": 42, "plate": "ABC1234", "approved_sightings": 3]]))
        let v: DMVVinDetail = try await api.get("/api/dmv/vins/7SAYGDEF5TA000000")
        #expect(v.registry?.id == "42" && v.decode?.checkDigitOk == true && v.tracking.inBaseline)
    }
}

@MainActor
struct RiderDataTests {
    private func stub() -> StubServer {
        let s = StubServer()
        s.responses = [
            "GET /api/profile": (200, CommunityStub.fixture("my-rider-data")),
            "GET /api/trips": (200, CommunityStub.fixture("my-trips")),
            "GET /api/me": (200, #"{"authenticated":true,"user":{"id":"alice"},"tesla":{"connected":false}}"#),
            "GET /api/moderation/access": (200, #"{"moderator":false}"#)
        ]
        return s
    }

    @Test func theRidersOwnDataWithDashesForMissingValues() async throws {
        let s = stub(), api = s.api()
        let m = RiderDataModel()
        await m.load(api: api)
        #expect(m.state == .ready)
        let d = try #require(m.data)
        #expect(d.rideSummary?.tripCount == 2 && RiderDataModel.miles(d.rideSummary?.totalDistance) == "5.6 mi")
        #expect(RiderDataModel.duration(d.rideSummary?.totalDurationMinutes) == "—", "no duration on the receipts: a dash, never 0")
        #expect(RiderDataModel.money(d.spending.first?.totalCents, "USD") == "$13.84")
        #expect(RiderDataModel.spendingNote(d) == "Fares recorded for 2 of 2 rides. Tesla receipts show only “$”, so US dollars are assumed.")
        #expect(RiderDataModel.summaryNote(d) == "Duration recorded for 0 of 2. Time on board uses only those.")
        #expect(m.rides?.trips.count == 2 && RiderDataModel.fare(m.rides!.trips[0]) == "$6.92")
        #expect(!m.isModerator && !m.teslaLinked)
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == "Bearer s-test" })
    }

    @Test func signedOutIsNotAnError() async {
        let s = stub(), api = s.api()
        s.responses["GET /api/profile"] = (401, #"{"authenticated":false}"#)
        let m = RiderDataModel()
        await m.load(api: api)
        #expect(m.state == .signedOut)
        s.responses["GET /api/profile"] = (500, "{}")
        await m.load(api: api)
        #expect(m.state == .failed("The server had a problem (code 500). You're still signed in, and your data is safe. Try again in a moment."))
    }

    @Test func removingARideAsksTheServerAndTreats404AsDone() async {
        let s = stub(), api = s.api()
        let m = RiderDataModel()
        await m.load(api: api)
        s.responses["DELETE /api/trips/trip-1"] = (200, #"{"success":true,"deleted":1}"#)
        m.pendingDelete = "trip-1"
        await m.remove("trip-1", api: api)
        #expect(m.actionError == nil && m.pendingDelete == nil)
        #expect(s.requests.contains { $0.0.httpMethod == "DELETE" && $0.0.url?.path() == "/api/trips/trip-1" })
        s.responses["DELETE /api/trips/trip-1"] = (404, #"{"success":false,"error":"not_found"}"#)
        await m.remove("trip-1", api: api)
        #expect(m.actionError == "That ride was already removed.")
        s.responses["DELETE /api/trips/trip-1"] = (500, "{}")
        await m.remove("trip-1", api: api)
        #expect(m.actionError == "Couldn't remove the ride. Nothing was changed. Try again in a moment.")
    }

    @Test func monthsAreTheLastTwelveWithNotes() throws {
        let d: RiderData = try TestFixtures.decode("my-rider-data")
        let now = ISO8601DateFormatter().date(from: "2026-10-22T18:00:00Z")!
        let months = RiderDataModel.months(d, now: now)
        #expect(months.count == 12 && months.last?.key == "2026-10" && months.first?.key == "2025-11")
        #expect(months.first { $0.key == "2026-06" }?.rides == 2)
        #expect(RiderDataModel.monthlyNote(d, now: now) == "")
        let later = ISO8601DateFormatter().date(from: "2027-08-01T18:00:00Z")!
        #expect(RiderDataModel.monthlyNote(d, now: later) == "2 rides from before this window are not shown here.")
    }
}

@MainActor
struct GmailForwardingTests {
    private func f(code: String? = nil, link: String? = nil, received: String? = nil, setup: String? = nil) -> SyncStatus.Forwarding {
        .init(setupCompletedAt: setup, confirmationCode: code, confirmationLink: link, confirmationRequestedBy: nil, confirmationCodeReceivedAt: nil, lastReceivedAt: received)
    }

    @Test func linkedFollowsTheCurrentAddressNotHistory() {
        #expect(!GmailForwardingModel.linked(f()))
        #expect(GmailForwardingModel.linked(f(received: "2026-10-22 10:00:00")))
        #expect(!GmailForwardingModel.linked(f(code: "123", received: "2026-10-22 10:00:00")), "a waiting confirmation means not linked yet")
        #expect(GmailForwardingModel.syncing(f(setup: "2026-10-20 10:00:00")) && !GmailForwardingModel.linked(f(setup: "2026-10-20 10:00:00")))
    }

    @Test func onlyGoogleMailSettingsLinksAreOpened() {
        #expect(GmailForwardingModel.safeLink("https://mail-settings.google.com/mail/vf-abc") != nil)
        #expect(GmailForwardingModel.safeLink("https://mail.google.com/mail/vf-abc") != nil)
        #expect(GmailForwardingModel.safeLink("http://mail.google.com/x") == nil)
        #expect(GmailForwardingModel.safeLink("https://mail.google.com.evil.example/x") == nil)
        #expect(GmailForwardingModel.safeLink("javascript:alert(1)") == nil && GmailForwardingModel.safeLink(nil) == nil)
        #expect(GmailForwardingModel.pending(f(link: "https://evil.example/confirm")) == false, "an unsafe link is never treated as a confirmation")
    }

    @Test func loadsTheAddressAndConfirmationFromTheWorker() async throws {
        let s = StubServer(), api = s.api()
        s.responses = ["GET /api/receipt-ingestion/address": (200, CommunityStub.fixture("my-receipt-address")),
                       "GET /api/rides/sync-status": (200, CommunityStub.fixture("my-sync-status"))]
        let m = GmailForwardingModel()
        await m.load(api: api)
        #expect(m.state == .ready)
        guard case .ready(let a) = m.address else { Issue.record("no address"); return }
        #expect(a.hasPrefix("u_") && a.hasSuffix("@receipts.cch-test.invalid"))
        #expect(m.status?.confirmationCode == "482915734" && !m.linked && m.pollSeconds == 20)
        // Not configured on the server: never shown as a working address.
        s.responses["GET /api/receipt-ingestion/address"] = (200, #"{"success":true,"local_part":"u_x","domain_configured":false}"#)
        await m.load(api: api)
        #expect(m.address == .pending)
        s.responses["GET /api/receipt-ingestion/address"] = (409, #"{"success":false,"error":"address_revoked"}"#)
        await m.load(api: api)
        #expect(m.address == .revoked && m.state == .ready)
        s.responses["GET /api/rides/sync-status"] = (401, #"{"authenticated":false}"#)
        await m.load(api: api)
        #expect(m.state == .signedOut)
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == "Bearer s-test" })
    }

    @Test func rotatingAndStoppingKeepRidesAndSayWhatChanged() async {
        let s = StubServer(), api = s.api()
        s.responses = ["POST /api/receipt-ingestion/address/rotate": (200, #"{"success":true,"address":"u_new@receipts.cch-test.invalid","domain_configured":true}"#),
                       "GET /api/rides/sync-status": (200, CommunityStub.fixture("my-sync-status"))]
        let m = GmailForwardingModel()
        await m.rotate(api: api)
        #expect(m.address == .ready("u_new@receipts.cch-test.invalid") && m.notice?.ok == true && m.notice?.text.hasPrefix("New address ready.") == true)
        await m.rotate(api: api, stopping: true)
        #expect(m.notice?.text.hasPrefix("Sync stopped.") == true && m.notice?.text.contains("Existing rides are saved") == true)
        s.responses["POST /api/receipt-ingestion/address/rotate"] = (500, "{}")
        await m.rotate(api: api)
        #expect(m.notice?.ok == false && m.notice?.text == "Couldn't get a new address. Your current one still works. Try again in a moment.")
        #expect(!s.requests.contains { $0.0.url?.path().contains("gmail") == true }, "no Gmail OAuth endpoint is ever called")
    }

    @Test func doneRecordsOnlyThatSetupWasFinished() async {
        let s = StubServer(), api = s.api()
        s.responses = ["POST /api/receipt-ingestion/setup/complete": (200, #"{"success":true}"#),
                       "GET /api/rides/sync-status": (200, CommunityStub.fixture("my-sync-status"))]
        let m = GmailForwardingModel()
        let first = await m.markDone(api: api)
        #expect(first && m.notice == nil)
        s.responses["POST /api/receipt-ingestion/setup/complete"] = (409, #"{"success":false,"error":"domain_not_configured"}"#)
        let second = await m.markDone(api: api)
        #expect(!second && m.notice?.text == "Couldn't save your setup. Please try again.")
    }
}

@MainActor
struct TeslaLinkTests {
    @Test func linkingUsesAOneTimeTokenNeverTheSession() async throws {
        let s = StubServer(), api = s.api()
        s.responses["POST /oauth/tesla/link"] = (200, #"{"link_token":"abc123","expires_in":120}"#)
        let t = TeslaLinkModel()
        let url = try #require(await t.startURL(api: api))
        #expect(url.path() == "/oauth/tesla/start" && url.query() == "link=abc123")
        #expect(!url.absoluteString.contains("s-test"), "the long-lived session never goes in a URL")
        s.responses["POST /oauth/tesla/link"] = (401, #"{"authenticated":false}"#)
        let refused = await t.startURL(api: api)
        #expect(refused == nil && t.message == "Could not start Tesla linking. Please try again.", "never a plain start link for a signed-in rider")
    }

    @Test func unlinkReportsFailure() async {
        let s = StubServer(), api = s.api()
        let t = TeslaLinkModel()
        s.responses["POST /api/tesla/disconnect"] = (200, #"{"success":true,"connected":false}"#)
        let ok = await t.unlink(api: api)
        #expect(ok && t.message == nil)
        s.responses["POST /api/tesla/disconnect"] = (500, "{}")
        let failed = await t.unlink(api: api)
        #expect(!failed && t.message != nil)
    }
}
