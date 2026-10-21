import Foundation

/// Where the current session token comes from (the Keychain in the app, a
/// fixed value in tests). Read on every request, so sign-in and sign-out take
/// effect immediately.
protocol TokenProvider: Sendable {
    func currentToken() -> String?
}

/// The Worker API over URLSession. Value type, safe to use from any task;
/// every call is `async` and cancelled with the task that made it.
struct APIClient: Sendable {
    let baseURL: URL
    let session: URLSession
    let tokens: any TokenProvider

    init(baseURL: URL = AppConfig.siteURL, session: URLSession = .shared, tokens: any TokenProvider) {
        self.baseURL = baseURL
        self.session = session
        self.tokens = tokens
    }

    /// The Worker's JSON is snake_case; models are camelCase. Not Foundation's
    /// .convertFromSnakeCase: it turns "last_24h" into "last24H" (it
    /// capitalizes the letter after a digit), which would silently drop every
    /// "_24h" / "_30d" / "_7d" field. Here only a segment's first letter is
    /// raised: "last_24h" → "last24h", "rides_30d" → "rides30d".
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .custom { path in
            let raw = path.last!.stringValue
            return AnyKey(camelCase(raw))
        }
        return decoder
    }

    static func camelCase(_ snake: String) -> String {
        let parts = snake.split(separator: "_", omittingEmptySubsequences: true)
        guard let first = parts.first else { return snake }
        return parts.dropFirst().reduce(String(first)) { $0 + $1.prefix(1).uppercased() + $1.dropFirst() }
    }

    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    /// Builds a request. `authenticated` adds `Authorization: Bearer <session>`
    /// when signed in (public endpoints are called without it).
    func makeRequest(_ path: String, method: String = "GET", query: [URLQueryItem] = [], jsonBody: Data? = nil, authenticated: Bool = false) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path.hasPrefix("/") ? path : "/" + path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let jsonBody {
            request.httpBody = jsonBody
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated, let token = tokens.currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self, authenticated: Bool = false) async throws -> T {
        try await perform(makeRequest(path, query: query, authenticated: authenticated))
    }

    func post<T: Decodable & Sendable>(_ path: String, json: [String: String], as type: T.Type = T.self, authenticated: Bool = false) async throws -> T {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await perform(makeRequest(path, method: "POST", jsonBody: body, authenticated: authenticated))
    }

    func perform<T: Decodable & Sendable>(_ request: URLRequest, upload body: Data? = nil, delegate: (any URLSessionTaskDelegate)? = nil) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            if let body {
                (data, response) = try await session.upload(for: request, from: body, delegate: delegate)
            } else {
                (data, response) = try await session.data(for: request)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 { throw APIError.unauthorized }
            let code = (try? Self.makeDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError.http(status: status, code: code)
        }
        do {
            return try Self.makeDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private struct ErrorBody: Decodable { let error: String? }
}
