import SwiftUI
import UIKit
import AVFoundation

/// "Take Photo" in the sighting form: Apple's camera (UIImagePickerController,
/// photos only, so no microphone), with its own Retake / Use Photo step. The
/// photo is handed to the form as JPEG data and goes through the same
/// preparation as a library photo (SubmitSightingModel.setPhoto); it is not
/// saved to the photo library, so no Photos permission is needed.
struct SightingCameraCapture: UIViewControllerRepresentable {
    let done: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    /// Whether this device has a camera (the Simulator has none).
    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    enum Access { case allowed, denied }

    /// Camera permission: asked once (the first Take Photo), then remembered by iOS.
    static func requestAccess() async -> Access {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .allowed
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
        default: return .denied
        }
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = ["public.image"]
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: SightingCameraCapture
        init(_ parent: SightingCameraCapture) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            // Full quality here; the form resizes and compresses it like any photo.
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.95) { parent.done(data) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()   // the form is exactly as it was
        }
    }
}
