import UIKit
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications

// "Cybercab Hunter" in the Share Sheet (Photos, Mail, Files and any app
// sharing images, PDFs or text). Two jobs: a photo can become a SIGHTING
// (unchanged), and a Tesla ride receipt (PDF, image, saved email or its text)
// can be IMPORTED. A receipt is kept for the app (ReceiptShareInbox) and
// nothing is uploaded here: the rider reviews it in the app first.
// It keeps the shared photo for the app (SightingShareInbox, in the App Group)
// and nothing else: no upload, no account, no network. The rider continues in
// Cybercab Hunter, where the photo is waiting in the Submit a sighting form.
// A share extension has no supported way to open its app, so it posts a local
// notification ("Finish your Cybercab sighting"): one tap opens the app on the
// form. With notifications off, it says to open the app instead.

final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
        model.onNotified = { [weak self] in self?.finish() }   // the banner takes over: close the sheet
        let host = UIHostingController(rootView: ShareView(model: model, close: { [weak self] in self?.finish() }, cancel: { [weak self] in self?.cancel() }))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let all = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let images = all.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        let receipts = all.filter { p in ShareModel.receiptTypes.contains { p.hasItemConformingToTypeIdentifier($0.identifier) } && !p.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        Task {
            if !receipts.isEmpty { await model.loadReceipt(receipts, total: all.count) }   // a PDF, email or text: only ever a receipt
            else if !images.isEmpty { await model.load(images) }                           // a photo: sighting, or receipt if the rider says so
            else { model.unsupported() }
        }
    }

    private func finish() { extensionContext?.completeRequest(returningItems: nil) }
    private func cancel() { extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
}

@MainActor
@Observable
final class ShareModel {
    enum Stage: Equatable { case loading, ready, saved, receiptSaved, failed(String) }
    /// Receipts arrive as PDFs, saved emails or text (images are offered both ways).
    static let receiptTypes: [UTType] = [.pdf, .emailMessage, .plainText, .utf8PlainText]
    private(set) var stage: Stage = .loading
    private(set) var preview: UIImage?
    private(set) var count = 0
    private var photo: Data?
    @ObservationIgnored var onNotified: (() -> Void)?

    func unsupported() { stage = .failed("Share a Tesla receipt (PDF, email or photo) or a Cybercab photo.") }

    /// A PDF, email or text receipt: kept for the app, which shows what was read
    /// before anything is imported.
    func loadReceipt(_ providers: [NSItemProvider], total: Int) async {
        guard let first = providers.first, let data = await Self.receiptData(first) else { stage = .failed("That receipt couldn't be read. Try the PDF or a screenshot."); return }
        keepReceipt(data, skipped: max(0, total - 1))
    }

    /// The shared photo, as a receipt instead of a sighting.
    func keepAsReceipt() {
        guard let photo else { return }
        keepReceipt(photo, skipped: max(0, count - 1))
    }

    private func keepReceipt(_ data: Data, skipped: Int) {
        do {
            let share = try ReceiptShareInbox.save(data, skipped: skipped)
            stage = .receiptSaved
            Task { if await Self.notifyReceipt(share) { onNotified?() } }
        } catch ReceiptShareInbox.Failure.tooLarge {
            stage = .failed("That file is too large to be a receipt (15 MB at most).")
        } catch ReceiptShareInbox.Failure.unavailable {
            stage = .failed("Cybercab Hunter couldn't keep the receipt. Open the app and import it from Files.")
        } catch {
            stage = .failed("That receipt couldn't be read. Try the PDF or a screenshot.")
        }
    }

    static func notifyReceipt(_ share: ReceiptShareInbox.Share) async -> Bool {
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional || status == .ephemeral else { return false }
        let content = UNMutableNotificationContent()
        content.title = "Finish importing your receipt"
        content.body = "Tap to check the ride details in Cybercab Hunter, then import."
        content.sound = .default
        content.userInfo = [ReceiptShareInbox.notificationKey: share.id.uuidString]
        let request = UNNotificationRequest(identifier: ReceiptShareInbox.notificationID(share.id), content: content,
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
        return (try? await center.add(request)) != nil
    }

    /// PDF and email files as their own bytes; text as UTF-8. Loaded in the
    /// background by the provider (a large PDF is never decoded here).
    static func receiptData(_ provider: NSItemProvider) async -> Data? {
        for type in [UTType.pdf, .emailMessage] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            if let d = await load(provider, type) { return d }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let d = await load(provider, .plainText) { return d }
            return await withCheckedContinuation { done in
                _ = provider.loadObject(ofClass: NSString.self) { s, _ in done.resume(returning: (s as? String).map { Data($0.utf8) }) }
            }
        }
        return nil
    }
    private static func load(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in done.resume(returning: data) }
        }
    }

    func load(_ providers: [NSItemProvider]) async {
        count = providers.count
        guard let first = providers.first else { stage = .failed("There's no photo to share."); return }
        guard let data = await Self.data(first) else { stage = .failed("That photo couldn't be read. Try a JPEG, PNG or HEIC photo."); return }
        switch SightingShareInbox.check(data) {
        case .tooLarge?: stage = .failed("That photo is too large. Please choose one under 40 MB.")
        case .unreadable?, .unavailable?: stage = .failed("That photo couldn't be read. Try a JPEG, PNG or HEIC photo.")
        case nil:
            photo = data
            preview = await Task.detached(priority: .userInitiated) { Self.thumbnail(data) }.value
            stage = .ready
        }
    }

    /// Keeps the photo for the app, and offers the one-tap way back to it.
    func keep() {
        guard let photo else { return }
        do {
            let share = try SightingShareInbox.save(photo, skipped: max(0, count - 1))
            stage = .saved
            Task { if await Self.notify(share) { onNotified?() } }
        } catch SightingShareInbox.Failure.unavailable {
            stage = .failed("Cybercab Hunter couldn't keep the photo. Open the app and add it from your library.")
        } catch {
            stage = .failed("That photo couldn't be kept. Try again.")
        }
    }

    /// "Finish your Cybercab sighting": allowed notifications only (asked once,
    /// if Cybercab Hunter never asked). Returns whether it was posted.
    static func notify(_ share: SightingShareInbox.Share) async -> Bool {
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional || status == .ephemeral else { return false }
        let content = UNMutableNotificationContent()
        content.title = "Finish your Cybercab sighting"
        content.body = "Tap to open Cybercab Hunter with your photo attached, add the details and submit."
        content.sound = .default
        content.userInfo = [SightingShareInbox.notificationKey: share.id.uuidString]
        let request = UNNotificationRequest(identifier: SightingShareInbox.notificationID(share.id), content: content,
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
        return (try? await center.add(request)) != nil
    }

    /// The photo's own bytes (JPEG, PNG, HEIC…): the provider loads them in the
    /// background and hands back only the data.
    static func data(_ provider: NSItemProvider) async -> Data? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in done.resume(returning: data) }
        }
    }

    nonisolated static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 900]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

private enum Look {
    static let background = Color(red: 10 / 255, green: 10 / 255, blue: 10 / 255)
    static let gold = Color(red: 250 / 255, green: 224 / 255, blue: 48 / 255)
    static let fog = Color(red: 160 / 255, green: 165 / 255, blue: 173 / 255)
    static let surface = Color.white.opacity(0.05)
    static func inter(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .custom("Inter", size: size).weight(weight) }
}

struct ShareView: View {
    let model: ShareModel
    let close: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.stage == .receiptSaved ? "RIDE RECEIPT" : "CYBERCAB HUNTER").font(Look.inter(11, .bold)).tracking(1.4).foregroundStyle(Look.gold)
                preview
                message
                Spacer(minLength: 0)
                action
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Look.background)
            .navigationTitle("Cybercab Hunter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.stage != .saved && model.stage != .receiptSaved { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) } }
            }
        }
        .tint(Look.gold)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private var preview: some View {
        ZStack {
            if let image = model.preview {
                Image(uiImage: image).resizable().scaledToFit()
            } else if model.stage == .loading {
                ProgressView().tint(Look.fog)
            } else {
                Image(systemName: "photo").font(.system(size: 30)).foregroundStyle(Look.fog)
            }
        }
        .frame(maxWidth: .infinity).frame(height: 260)
        .background(Look.surface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Look.gold.opacity(0.35), lineWidth: 1))
        .clipShape(.rect(cornerRadius: 14))
        .accessibilityLabel("Shared photo")
    }

    @ViewBuilder private var message: some View {
        switch model.stage {
        case .loading:
            Text("Getting it ready…").font(Look.inter(14)).foregroundStyle(Look.fog)
        case .ready:
            VStack(alignment: .leading, spacing: 6) {
                Text("A sighting, or a ride receipt?").font(Look.inter(18, .bold)).foregroundStyle(.white)
                Text("A Cybercab photo continues to the sighting form. A screenshot or photo of a Tesla ride receipt goes to Import Receipt. Nothing is sent until you confirm in the app.")
                    .font(Look.inter(13.5)).foregroundStyle(Look.fog)
                if model.count > 1 {
                    Text("A sighting has one photo: the first of the \(model.count) you shared is attached. Share the others one at a time.")
                        .font(Look.inter(12.5, .semibold)).foregroundStyle(Look.gold)
                }
            }
        case .receiptSaved:
            VStack(alignment: .leading, spacing: 6) {
                Label("Receipt ready", systemImage: "checkmark.circle.fill").font(Look.inter(18, .bold)).foregroundStyle(Look.gold)
                Text("Open Cybercab Hunter: Import Receipt opens with this receipt, shows what was read, and imports it when you confirm. If you're signed out, sign in first; the receipt waits for three days.")
                    .font(Look.inter(13.5)).foregroundStyle(Look.fog)
            }
        case .saved:
            VStack(alignment: .leading, spacing: 6) {
                Label("Photo ready", systemImage: "checkmark.circle.fill").font(Look.inter(18, .bold)).foregroundStyle(Look.gold)
                Text("Open Cybercab Hunter: the Submit a sighting form opens with this photo attached. If you're signed out, sign in first; the photo waits for three days.")
                    .font(Look.inter(13.5)).foregroundStyle(Look.fog)
            }
        case .failed(let reason):
            VStack(alignment: .leading, spacing: 6) {
                Label("Can't use this photo", systemImage: "exclamationmark.triangle.fill").font(Look.inter(17, .bold)).foregroundStyle(Color(red: 240 / 255, green: 138 / 255, blue: 132 / 255))
                Text(reason).font(Look.inter(13.5)).foregroundStyle(Look.fog)
            }
        }
    }

    @ViewBuilder private var action: some View {
        switch model.stage {
        case .ready:
            VStack(spacing: 10) {
                Button { model.keep() } label: { label("Add as a sighting") }
                    .accessibilityIdentifier("shareContinue")
                Button { model.keepAsReceipt() } label: {
                    Text("Import as a ride receipt").font(Look.inter(15, .semibold)).foregroundStyle(Look.gold)
                        .frame(maxWidth: .infinity).frame(height: 46)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Look.gold.opacity(0.6)))
                }
                .accessibilityIdentifier("shareAsReceipt")
            }
        case .receiptSaved:
            Button(action: close) { label("Done") }
        case .saved, .failed:
            Button(action: model.stage == .saved ? close : cancel) { label("Done") }
        case .loading:
            EmptyView()
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).font(Look.inter(16, .bold)).foregroundStyle(Color(red: 26 / 255, green: 18 / 255, blue: 4 / 255))
            .frame(maxWidth: .infinity).frame(height: 50)
            .background(Look.gold, in: .rect(cornerRadius: 12))
    }
}
