import Testing
import Foundation
import UIKit
@testable import CybercabHunter

// The mobile receipt import: the Share Sheet hand-off (ReceiptShareInbox), text
// read on the device (ReceiptText), the server's answers decoded and worded
// for riders, and notification settings that survive older saved data.
@MainActor
@Suite(.serialized)
struct ReceiptImportTests {
    private func tempRoot() -> URL {
        let u = FileManager.default.temporaryDirectory.appending(path: "receipt-inbox-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true); return u
    }

    // MARK: Share hand-off

    @Test func aSharedPDFIsKeptReadThenRemoved() throws {
        let root = tempRoot()
        let pdf = TestReceipt.data("pdf")
        let share = try ReceiptShareInbox.save(pdf, root: root)
        #expect(share.kind == .pdf)
        #expect(ReceiptShareInbox.pending(root: root).map(\.id) == [share.id])
        #expect(ReceiptShareInbox.read(share.id, root: root) == pdf, "reading leaves it in place (an interrupted review loses nothing)")
        #expect(ReceiptShareInbox.pending(root: root).count == 1)
        ReceiptShareInbox.discard(share.id, root: root)
        #expect(ReceiptShareInbox.pending(root: root).isEmpty, "imported or discarded: the temporary copy is gone")
        #expect((try? FileManager.default.contentsOfDirectory(atPath: ReceiptShareInbox.folder(root: root)!.path()))?.isEmpty == true)
    }
    @Test func kindsAreJudgedByTheBytesNotTheName() {
        #expect(ReceiptShareInbox.kind(of: TestReceipt.data("pdf")) == .pdf)
        #expect(ReceiptShareInbox.kind(of: TestReceipt.data("image")) == .image)
        #expect(ReceiptShareInbox.kind(of: TestReceipt.data("text")) == .text)
        #expect(ReceiptShareInbox.kind(of: Data([0x00, 0xFF, 0xFE, 0x01, 0x02])) == nil, "binary junk is unsupported")
    }
    @Test func unsupportedEmptyAndTooLargeAreRefused() {
        let root = tempRoot()
        #expect(throws: ReceiptShareInbox.Failure.empty) { try ReceiptShareInbox.save(Data(), root: root) }
        #expect(throws: ReceiptShareInbox.Failure.unsupported) { try ReceiptShareInbox.save(Data([0x00, 0xFF, 0xFE, 0x01]), root: root) }
        var big = Data("%PDF".utf8); big.append(Data(count: ReceiptShareInbox.maxBytes))
        #expect(throws: ReceiptShareInbox.Failure.tooLarge) { try ReceiptShareInbox.save(big, root: root) }
        #expect(ReceiptShareInbox.pending(root: root).isEmpty)
    }
    @Test func oldAndHalfWrittenSharesAreCleanedUp() throws {
        let root = tempRoot()
        let old = try ReceiptShareInbox.save(TestReceipt.data("text"), root: root)
        #expect(ReceiptShareInbox.pending(now: .now.addingTimeInterval(4 * 24 * 3600), root: root).isEmpty, "older than three days: gone")
        #expect(ReceiptShareInbox.read(old.id, root: root) == nil)
        let dir = ReceiptShareInbox.folder(root: root)!
        try Data("x".utf8).write(to: dir.appending(path: "\(UUID().uuidString).bin"))
        #expect(ReceiptShareInbox.pending(now: .now.addingTimeInterval(120), root: root).isEmpty, "a file without its manifest is never offered")
    }

    // MARK: Reading on the device

    @Test func aPDFsTextLayerIsReadExactly() async throws {
        let s = try await ReceiptText.from(TestReceipt.data("pdf"))
        #expect(s.kind == "text" && !s.recognized)
        #expect(s.content.contains("Pick up") && s.content.contains("1:04 pm") && s.content.contains("XJR2195"))
    }
    @Test func aPhotoOfAReceiptIsRecognizedLineByLine() async throws {
        let s = try await ReceiptText.from(TestReceipt.data("image"))
        #expect(s.recognized)
        let lines = s.content.components(separatedBy: "\n")
        let pickup = try #require(lines.firstIndex { $0.lowercased().contains("pick up") })
        let pickupTime = try #require(lines.firstIndex { $0.contains("1:04") })
        let dropoffTime = try #require(lines.firstIndex { $0.contains("1:18") })
        #expect(pickup < pickupTime && pickupTime < dropoffTime, "top to bottom: the pickup time stays before the drop-off time")
    }
    @Test func aSavedEmailIsSentAsAnEmail() throws {
        let eml = "From: robotaxi@tesla.com\r\nSubject: Your Tesla Robotaxi Receipt\r\nDate: Tue, 9 Jun 2026 13:25:00 -0500\r\n\r\n" + TestReceipt.text
        #expect(try ReceiptText.text(Data(eml.utf8)).kind == "eml")
        #expect(try ReceiptText.text(Data(TestReceipt.text.utf8)).kind == "text")
    }
    @Test func blankOrUnreadableInputSaysSo() async {
        await #expect(throws: ReceiptText.Failure.noText) { try await ReceiptText.from(Data("   \n ".utf8)) }
        let blank = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 400)).pngData { _ in UIColor.white.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 400, height: 400)) }
        await #expect(throws: ReceiptText.Failure.noText) { try await ReceiptText.from(blank) }
    }

    // MARK: Server answers, in riders' words

    @Test func previewWordingAndFlags() throws {
        let json = #"{"success":true,"would":"needs_details","reason":"pickup_time_missing","review_status":"needs_review","fields":{"ride_date":"2026-06-09","pickup_time":null,"dropoff_time":"13:18","pickup":"4301 Hanover St, Dallas, TX 75225","dropoff":null,"fare_amount_cents":692,"currency":"USD","distance_miles":2.8,"duration_minutes":14,"license_plate":"XJR2195","service_area":"Dallas","timezone":"America/Chicago"},"uncertain":["pickup_time"]}"#
        let p: ReceiptPreview = try APIClient.makeDecoder().decode(ReceiptPreview.self, from: Data(json.utf8))
        #expect(!p.canImport && p.isUncertain("pickup_time") && p.headline.contains("missing"))
        #expect(ReceiptFormat.time(p.fields.pickupTime) == nil, "a missing pickup time stays missing")
        #expect(ReceiptFormat.time(p.fields.dropoffTime) == "1:18 PM" && ReceiptFormat.fare(692, "USD") == "$6.92" && ReceiptFormat.fare(0, "USD") == "Free")
        #expect(ReceiptFormat.day("2026-06-09") == "Jun 9, 2026")
    }
    @Test func importHistoryAdviceIsActionable() throws {
        let json = #"{"imports":[{"id":"a","received_at":"2026-06-09T18:00:00Z","source":"email","result":"imported","error":null,"ride":{"id":"t1","ride_date":"2026-06-09","pickup_time":"13:04","pickup":"A","dropoff":"B","fare_amount_cents":692,"currency":"USD"}},{"id":"b","received_at":null,"source":"import","result":"needs_details","error":"pickup_time_missing","ride":null},{"id":"c","received_at":null,"source":"import","result":"duplicate","error":null,"ride":null},{"id":"d","received_at":null,"source":"gmail","result":"not_a_receipt","error":"not_recognized_as_tesla_receipt","ride":null}],"next_cursor":null}"#
        let page: ReceiptImportsPage = try APIClient.makeDecoder().decode(ReceiptImportsPage.self, from: Data(json.utf8))
        #expect(page.imports[0].ok && page.imports[0].advice == nil && page.imports[0].sourceText == "Forwarded email")
        #expect(page.imports[1].advice?.contains("pickup time") == true && !page.imports[1].ok)
        #expect(page.imports[2].advice?.contains("counted twice") == true)
        #expect(page.imports[3].advice?.contains("not recognized") == true && page.imports[3].sourceText == "Gmail")
    }
    @Test func importSummaryNeverClaimsAMissingRide() {
        typealias R = ReceiptImportRun.Run
        #expect(ReceiptImportModel.summary(R(processed: 1, added: 1, updated: 0, duplicates: 0, needsReview: 0, rejected: 0, errors: 0)) == "New ride imported.")
        #expect(ReceiptImportModel.summary(R(processed: 1, added: 0, updated: 0, duplicates: 1, needsReview: 0, rejected: 0, errors: 0)).contains("Already imported"))
        #expect(ReceiptImportModel.summary(R(processed: 1, added: 0, updated: 0, duplicates: 0, needsReview: 1, rejected: 0, errors: 0)).contains("no ride was added"))
        #expect(ReceiptImportModel.summary(R(processed: 1, added: 0, updated: 0, duplicates: 0, needsReview: 0, rejected: 0, errors: 1)).contains("didn't finish"))
    }

    // MARK: Notification setting

    @Test func receiptNotificationsAreOffByDefaultAndOldSettingsStillLoad() throws {
        #expect(PushPreferences().rides == false)
        let old = #"{"version":1,"master":false,"timezone":"America/Chicago","quiet":true,"quietStart":1320,"quietEnd":420,"majorDuringQuiet":false,"group":true,"frequency":"standard","news":"off","dmv":"instant","daily":true,"dailyTime":480,"dailyMetrics":["dmv"],"comparison":false,"registry":"off","sightings":"off","cameras":"off","comments":true,"replies":true,"mentions":true,"likes":true,"weekly":false,"weeklyDay":0,"weeklyTime":540,"weeklyMetrics":["dmv"]}"#
        let p = try JSONDecoder().decode(PushPreferences.self, from: Data(old.utf8))
        #expect(p.rides == false && p.master == false && p.quiet == true && p.news == "off", "saved before rides existed: everything else kept")
        var on = p; on.rides = true
        let round = try JSONDecoder().decode(PushPreferences.self, from: JSONEncoder().encode(on))
        #expect(round.rides == true)
    }
}
