import Foundation

// Writes: JSON bodies (likes, saves, comments, reports, notifications) and
// multipart posts with photos. The server checks every write against the
// session (worker/social.js); nothing here decides who may do what.
extension APIClient {
    /// A JSON request (PUT / PATCH / DELETE / POST) with the rider's session.
    func send<T: Decodable & Sendable>(_ path: String, method: String, body: Data? = nil, as type: T.Type = T.self) async throws -> T {
        try await perform(makeRequest(path, method: method, jsonBody: body, authenticated: true))
    }

    /// multipart/form-data upload with the rider's session; `progress` gets 0…1
    /// as the body is sent.
    func upload<T: Decodable & Sendable>(_ path: String, method: String, form: MultipartForm, as type: T.Type = T.self,
                                         progress: (@Sendable (Double) -> Void)? = nil) async throws -> T {
        var request = makeRequest(path, method: method, authenticated: true)
        request.setValue("multipart/form-data; boundary=\(form.boundary)", forHTTPHeaderField: "Content-Type")
        let body = form.encoded()
        return try await perform(request, upload: body, delegate: progress.map(UploadProgress.init))
    }
}

/// A JSON object body from plain values (strings, numbers, booleans, arrays).
enum JSONBody {
    static func make(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    }
}

/// multipart/form-data, as the website's FormData sends it.
struct MultipartForm: Sendable {
    let boundary = "CybercabHunter-\(UUID().uuidString)"
    private var parts: [(name: String, value: Value)] = []

    enum Value: Sendable {
        case text(String)
        case file(Data, filename: String, contentType: String)
    }

    mutating func add(_ name: String, _ value: String) { parts.append((name, .text(value))) }
    mutating func addFile(_ name: String, data: Data, filename: String, contentType: String) {
        parts.append((name, .file(data, filename: filename, contentType: contentType)))
    }

    /// The fields in order (tests read them back).
    var fields: [(String, String)] {
        parts.compactMap { if case .text(let v) = $0.value { return ($0.name, v) } else { return nil } }
    }
    var fileCount: Int { parts.filter { if case .file = $0.value { return true } else { return false } }.count }

    func encoded() -> Data {
        var data = Data()
        for part in parts {
            data.append(Data("--\(boundary)\r\n".utf8))
            switch part.value {
            case .text(let value):
                data.append(Data("Content-Disposition: form-data; name=\"\(part.name)\"\r\n\r\n".utf8))
                data.append(Data(value.utf8))
            case .file(let bytes, let filename, let type):
                data.append(Data("Content-Disposition: form-data; name=\"\(part.name)\"; filename=\"\(filename)\"\r\nContent-Type: \(type)\r\n\r\n".utf8))
                data.append(bytes)
            }
            data.append(Data("\r\n".utf8))
        }
        data.append(Data("--\(boundary)--\r\n".utf8))
        return data
    }
}

/// Reports upload progress for one task.
private final class UploadProgress: NSObject, URLSessionTaskDelegate, Sendable {
    let report: @Sendable (Double) -> Void
    init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
