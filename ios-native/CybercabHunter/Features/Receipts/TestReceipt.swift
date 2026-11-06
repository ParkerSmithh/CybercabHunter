#if DEBUG
import UIKit

/// A sanitized Tesla Robotaxi receipt (made-up plate, places and rider) as
/// text, a PDF with a text layer, or an image, for `-seedSharedReceipt` and the
/// unit tests. Debug builds only.
enum TestReceipt {
    static let lines = [
        "Tesla", "Trip Summary for June 9, 2026", "2.8 mi · 14 min · XJR2195", "$6.92", "Total",
        "Pick up", "4301 Hanover St, Dallas, TX 75225", "1:04 pm",
        "NorthPark Center, 8687 N Central Expy, Dallas, TX 75225", "1:18 pm",
        "Payment", "Trip Fare $6.92"
    ]
    static var text: String { lines.joined(separator: "\n\n") }

    static func data(_ kind: String) -> Data {
        switch kind {
        case "pdf":
            return UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { ctx in
                ctx.beginPage(); draw(in: CGSize(width: 612, height: 792))
            }
        case "image":
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            return UIGraphicsImageRenderer(size: CGSize(width: 1100, height: 1500), format: format).pngData { _ in
                UIColor.white.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 1100, height: 1500)); draw(in: CGSize(width: 1100, height: 1500), size: 34)
            }
        default:
            return Data(text.utf8)
        }
    }

    private static func draw(in size: CGSize, size font: CGFloat = 14) {
        let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: font), .foregroundColor: UIColor.black]
        var y: CGFloat = font * 2
        for line in lines { (line as NSString).draw(at: CGPoint(x: font * 2, y: y), withAttributes: attrs); y += font * 2.2 }
    }
}
#endif
