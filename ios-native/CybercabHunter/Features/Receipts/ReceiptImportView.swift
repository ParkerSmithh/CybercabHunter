import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import VisionKit

/// Import Receipt: Scan Receipt (VisionKit's document camera), Take Photo,
/// Choose from Photos, Choose from Files, or a receipt shared from another app.
/// Every path reads the receipt on the device, shows what the server's parser
/// found (nothing saved), lets the rider correct the text, then imports.
struct ReceiptImportView: View {
    enum Start: Equatable { case choose, scan, share(ReceiptShareInbox.Share) }
    var start: Start = .choose
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = ReceiptImportModel()
    @State private var scanning = false
    @State private var camera = false
    @State private var photos = false
    @State private var files = false
    @State private var photoItem: PhotosPickerItem?
    @State private var editing = false

    static var canScan: Bool { VNDocumentCameraViewController.isSupported }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let note = model.note { InlineMessage(text: note) }
                    switch model.stage {
                    case .choosing: chooser
                    case .reading: progress("Reading the receipt on this iPhone…")
                    case .checking: progress("Checking the receipt…")
                    case .importing: progress("Importing…")
                    case .review(let preview): review(preview)
                    case .done(let message): done(message)
                    case .failed(let message): failed(message)
                    }
                }
                .padding(16)
            }
            .appBackground()
            .navigationTitle("Import Receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.accessibilityIdentifier("receiptImportClose") } }
        }
        .tint(Color.brandGold)
        .sheet(isPresented: $scanning) {
            DocumentScanner { images in Task { await model.load(images: images, api: session.api) } }.ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $camera) {
            SightingCameraCapture { data in Task { await model.load(data: data, api: session.api) } }.ignoresSafeArea()
        }
        .photosPicker(isPresented: $photos, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) {
            guard let item = photoItem else { return }
            photoItem = nil
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) { await model.load(data: data, api: session.api) }
                else { model.reset() }
            }
        }
        .fileImporter(isPresented: $files, allowedContentTypes: [.pdf, .image, .plainText, .emailMessage, .text]) { result in
            guard case .success(let url) = result else { return }
            Task { await loadFile(url) }
        }
        // A shared receipt the rider has seen reviewed (or imported) is done with:
        // closing removes the temporary copy, so it isn't offered again. Closed
        // before a result (signed out, offline, still reading), it is kept.
        .onDisappear {
            switch model.stage {
            case .review, .done: model.discardShare()
            default: break
            }
        }
        .task {
            switch start {
            case .share(let share): await model.load(share: share, api: session.api)
            case .scan: if Self.canScan { scanning = true }
            case .choose: break
            }
        }
    }

    // MARK: Choose a source

    private var chooser: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add a Tesla Robotaxi ride receipt. It's read on this iPhone and checked before anything is saved.")
                .font(.inter(14)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
            source("Scan Receipt", "doc.viewfinder", id: "receiptScan", enabled: Self.canScan,
                   note: Self.canScan ? nil : "Scanning needs a camera.") { scanning = true }
            source("Take Photo", "camera", id: "receiptCamera", enabled: SightingCameraCapture.isAvailable,
                   note: SightingCameraCapture.isAvailable ? nil : "This device has no camera.") {
                Task { if await SightingCameraCapture.requestAccess() == .allowed { camera = true } else { model.reset() } }
            }
            source("Choose from Photos", "photo.on.rectangle", id: "receiptPhotos") { photos = true }
            source("Choose from Files", "folder", id: "receiptFiles", note: "PDF, image, or a saved email") { files = true }
            Footnote(text: "Tip: in Mail, Share a Tesla receipt (or Print it to PDF) and choose Cybercab Hunter. Forwarding imports new receipts automatically.")
        }
    }

    private func source(_ title: String, _ icon: String, id: String, enabled: Bool = true, note: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(enabled ? Color.brandGold : Color.chFog)
                    .frame(width: 38, height: 38).background(Color.brandGold.opacity(0.12), in: .rect(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.inter(15, .bold)).foregroundStyle(enabled ? Color.chInk : Color.chFog)
                    if let note { Text(note).font(.inter(12)).foregroundStyle(Color.chFog) }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.chCaption)
            }
            .padding(12).background(Color.chSurface, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id)
    }

    private func loadFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= ReceiptShareInbox.maxBytes, let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            model.reset(); return
        }
        await model.load(data: data, api: session.api)
    }

    // MARK: Review

    private func review(_ p: ReceiptPreview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(p.headline, systemImage: p.canImport ? "checkmark.seal" : "exclamationmark.triangle")
                .font(.inter(15, .semibold)).foregroundStyle(p.canImport ? Color.brandGold : Color.chMist)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("receiptVerdict")
            VStack(spacing: 0) {
                row("Ride date", ReceiptFormat.day(p.fields.rideDate), flag: p.isUncertain("ride_date"))
                row("Pickup time", ReceiptFormat.time(p.fields.pickupTime), flag: p.isUncertain("pickup_time"), id: "receiptPickupTime")
                row("Drop-off time", ReceiptFormat.time(p.fields.dropoffTime))
                row("Pickup", p.fields.pickup)
                row("Drop-off", p.fields.dropoff)
                row("Fare", ReceiptFormat.fare(p.fields.fareAmountCents, p.fields.currency), flag: p.isUncertain("fare"))
                row("Plate", p.fields.licensePlate, flag: p.isUncertain("license_plate"))
                row("Time zone", p.fields.timezone.flatMap { TimeZone(identifier: $0)?.localizedName(for: .generic, locale: .current) })
            }
            .background(Color.chSurface, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
            if model.recognized {
                Footnote(text: "Read from an image. Check the details: if something is wrong, correct the text below and check again.")
            }
            DisclosureGroup(isExpanded: $editing) {
                TextEditor(text: $model.text).font(.system(size: 13, design: .monospaced)).frame(minHeight: 220)
                    .scrollContentBackground(.hidden).padding(8).background(Color.chSurface2, in: .rect(cornerRadius: 10))
                    .accessibilityIdentifier("receiptTextEditor")
                Button("Check again") { Task { await model.check(api: session.api) } }.modifier(OutlineButton(color: .brandGold))
                    .accessibilityIdentifier("receiptCheckAgain")
            } label: { Text("Correct the receipt text").font(.inter(14, .semibold)).foregroundStyle(Color.chMist) }
            if p.canImport {
                Button { Task { await model.importNow(api: session.api) } } label: {
                    Text(p.would == "new" ? "Import ride" : "Import update").font(.inter(16, .bold)).frame(maxWidth: .infinity).frame(height: 50)
                        .background(Color.brandGold, in: .rect(cornerRadius: 12)).foregroundStyle(Color(hex: 0x1A1204))
                }
                .buttonStyle(.plain).accessibilityIdentifier("receiptImportConfirm")
            }
            Button("Choose a different receipt") { model.reset() }.font(.inter(14)).foregroundStyle(Color.chFog)
        }
    }

    private func row(_ label: String, _ value: String?, flag: Bool = false, id: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.inter(13)).foregroundStyle(Color.chFog)
            Spacer(minLength: 12)
            if flag { Image(systemName: "exclamationmark.circle").foregroundStyle(Color.brandGold).accessibilityLabel("Check this") }
            Text(value ?? "Not on the receipt").font(.inter(14, value == nil ? .regular : .semibold))
                .foregroundStyle(value == nil ? Color.chFog : Color.chInk).multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.chLine).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id ?? "receiptField")
    }

    // MARK: Outcomes

    private func progress(_ text: String) -> some View {
        HStack(spacing: 10) { ProgressView().tint(Color.brandGold); Text(text).font(.inter(14)).foregroundStyle(Color.chMist) }
            .frame(maxWidth: .infinity, minHeight: 120)
    }

    private func done(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "checkmark.circle.fill").font(.inter(17, .bold)).foregroundStyle(Color.brandGold)
                .accessibilityIdentifier("receiptImportDone")
            Button("Import another receipt") { model.reset() }.modifier(OutlineButton(color: .brandGold))
            Button("Done") { dismiss() }.font(.inter(14)).foregroundStyle(Color.chFog)
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle").font(.inter(15, .semibold)).foregroundStyle(Color.chMist)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("receiptImportFailed")
            Button("Try another receipt") { model.reset() }.modifier(OutlineButton(color: .brandGold))
        }
    }
}

/// VisionKit's document camera: edge detection, perspective correction, multi-page.
struct DocumentScanner: UIViewControllerRepresentable {
    let done: ([UIImage]) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let c = VNDocumentCameraViewController(); c.delegate = context.coordinator; return c
    }
    func updateUIViewController(_ c: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    @MainActor
    final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
        let parent: DocumentScanner
        init(_ parent: DocumentScanner) { self.parent = parent }
        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let pages = (0..<min(scan.pageCount, ReceiptText.maxPDFPages)).map { scan.imageOfPage(at: $0) }
            parent.dismiss(); parent.done(pages)
        }
        func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) { parent.dismiss() }
        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError error: Error) { parent.dismiss() }
    }
}
