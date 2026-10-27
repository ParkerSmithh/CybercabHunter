import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

// The Cybercab service day, shared by the app's "Live now" card and the
// Dynamic Island / Lock Screen Live Activity (CybercabHunterWidgets), so the
// two can never disagree. Times are wall-clock America/Chicago: 6:00 AM is
// 6:00 AM on daylight-saving change days too. The service day runs past
// midnight (6:00 AM to 1:00 AM): 12:30 AM belongs to the day before's service. "Live" means inside the
// published service hours (what the Live now card has always shown), not a
// count of cars confirmed on the road.

struct ServiceSchedule: Codable, Hashable, Sendable {
    /// Minutes after the service day's midnight, Central; closeMinute is past
    /// 1440 when service runs past midnight (1500 = 1:00 AM the next day).
    var openMinute: Int
    var closeMinute: Int

    static let timeZone = TimeZone(identifier: "America/Chicago")!
    /// 6:00 AM – 1:00 AM, every day (the API's hours when they haven't loaded).
    static let standard = ServiceSchedule(openMinute: 6 * 60, closeMinute: 25 * 60)

    /// A close at or before the open is the next day ("01:00" after "06:00" → 1500).
    init(openMinute: Int, closeMinute: Int) {
        self.openMinute = openMinute
        self.closeMinute = closeMinute <= openMinute ? closeMinute + 1440 : closeMinute
    }

    /// From the API's "HH:MM" strings ("24:00" = midnight at the end of the day,
    /// "01:00" = 1:00 AM the next day).
    init(open: String?, close: String?) {
        self.init(openMinute: open.map(Self.minutes) ?? Self.standard.openMinute,
                  closeMinute: close.map(Self.minutes) ?? Self.standard.closeMinute)
    }

    static func minutes(_ hhmm: String) -> Int {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        return (p.first ?? 0) * 60 + (p.count > 1 ? p[1] : 0)
    }

    struct Status: Equatable, Sendable {
        /// Inside the service hours.
        let live: Bool
        /// The last change (service began, or ended) — the start of the progress bar.
        let since: Date
        /// The next change (service ends, or begins) — what the countdown counts to.
        let until: Date
    }

    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = Self.timeZone
        return c
    }

    /// `minute` past midnight on `day`'s Central date, on the wall clock.
    private func moment(_ minute: Int, on day: Date) -> Date {
        let cal = calendar
        let start = cal.startOfDay(for: day)
        let dayShift = minute / 1440, rest = minute % 1440
        let base = cal.date(byAdding: .day, value: dayShift, to: start)!
        return cal.date(bySettingHour: rest / 60, minute: rest % 60, second: 0, of: base) ?? base
    }

    func status(at now: Date) -> Status {
        let cal = calendar
        let today = cal.startOfDay(for: now)
        let yesterday = cal.date(byAdding: .day, value: -1, to: today)!
        let tomorrow = cal.date(byAdding: .day, value: 1, to: today)!
        // The day before's service, while it runs past midnight.
        let lateOpen = moment(openMinute, on: yesterday), lateClose = moment(closeMinute, on: yesterday)
        if now >= lateOpen && now < lateClose { return Status(live: true, since: lateOpen, until: lateClose) }
        let open = moment(openMinute, on: today), close = moment(closeMinute, on: today)
        if now >= open && now < close { return Status(live: true, since: open, until: close) }
        if now < open { return Status(live: false, since: lateClose, until: open) }
        return Status(live: false, since: close, until: moment(openMinute, on: tomorrow))
    }

    /// "6:00 AM" for a minute of the day (1440 → "12:00 AM", 1500 → "1:00 AM").
    func label(_ minute: Int) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US"); f.timeZone = Self.timeZone; f.dateFormat = "h:mm a"
        return f.string(from: moment(minute % 1440, on: Date(timeIntervalSince1970: 1_767_225_600)))   // any fixed day
    }

    /// "5h 21m" / "42m" until `until` (at least 1 minute), as the Live now card says it.
    static func countdown(from now: Date, to until: Date) -> String {
        let mins = max(1, Int(ceil(until.timeIntervalSince(now) / 60)))
        return mins >= 60 ? "\(mins / 60)h \(mins % 60)m" : "\(mins)m"
    }
}

#if canImport(ActivityKit)
/// The Dynamic Island / Lock Screen Live Activity's data. The status is fixed
/// until the next change (`until`): the system draws the countdown and the
/// progress bar from these dates itself, so nothing runs or polls meanwhile.
struct ServiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var live: Bool
        var since: Date
        var until: Date
    }
    var cityName: String
    var openLabel: String
    var closeLabel: String
}

extension ServiceActivityAttributes.ContentState {
    init(_ s: ServiceSchedule.Status) { self.init(live: s.live, since: s.since, until: s.until) }
}
#endif
