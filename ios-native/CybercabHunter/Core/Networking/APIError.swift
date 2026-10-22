import Foundation

/// What can go wrong talking to the Worker, in terms the UI can act on.
enum APIError: Error, Equatable, LocalizedError {
    /// 401: no session, or it expired. The app signs the rider out.
    case unauthorized
    /// Any other non-2xx. `code` is the Worker's `{ "error": "…" }` when it sent one.
    case http(status: Int, code: String?)
    /// The response wasn't the JSON the model expects.
    case decoding(String)
    /// No response (offline, timeout, TLS…).
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Your session has ended. Sign in again."
        case .http(let status, let code): return code.map { "The server said \($0) (\(status))." } ?? "The server had a problem (\(status))."
        case .decoding: return "The server sent something unexpected."
        case .transport: return "Couldn't reach Cybercab Hunter. Check your connection."
        }
    }
}
