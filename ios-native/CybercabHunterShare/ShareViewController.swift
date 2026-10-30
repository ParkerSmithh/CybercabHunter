import UIKit
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications

// "Cybercab Hunter" in the Share Sheet (Photos and any app sharing images).
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
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        Task { await model.load(providers) }
    }

    private func finish() { extensionContext?.completeRequest(returningItems: nil) }
    private func cancel() { extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
}

@MainActor
@Observable
final class ShareModel {
    enum Stage: Equatable { case loading, ready, saved, failed(String) }
    private(set) var stage: Stage = .loading
    private(set) var preview: UIImage?
    private(set) var count = 0
    private var photo: Data?
    @ObservationIgnored var onNotified: (() -> Void)?

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
                Text("NEW CYBERCAB SIGHTING").font(Look.inter(11, .bold)).tracking(1.4).foregroundStyle(Look.gold)
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
                if model.stage != .saved { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) } }
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
            Text("Getting the photo…").font(Look.inter(14)).foregroundStyle(Look.fog)
        case .ready:
            VStack(alignment: .leading, spacing: 6) {
                Text("Submit it as a sighting").font(Look.inter(18, .bold)).foregroundStyle(.white)
                Text("Continue in Cybercab Hunter to add the city, place and notes, then submit. Nothing is sent until you do.")
                    .font(Look.inter(13.5)).foregroundStyle(Look.fog)
                if model.count > 1 {
                    Text("A sighting has one photo: the first of the \(model.count) you shared is attached. Share the others one at a time.")
                        .font(Look.inter(12.5, .semibold)).foregroundStyle(Look.gold)
                }
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
            Button { model.keep() } label: { label("Continue in Cybercab Hunter") }
                .accessibilityIdentifier("shareContinue")
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
