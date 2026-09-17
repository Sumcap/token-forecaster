import Foundation

enum DaemonError: Error, LocalizedError {
    case noRuntimeFile
    case badRuntimeFile
    case connectionFailed(String)
    case httpStatus(Int)
    case decodeFailed(String)

    var errorDescription: String? {
        switch self {
        case .noRuntimeFile:        return "Daemon not running"
        case .badRuntimeFile:       return "Runtime file unreadable"
        case .connectionFailed:     return "Daemon not running"
        case .httpStatus(let code): return "Daemon error (HTTP \(code))"
        case .decodeFailed:         return "Unexpected daemon response"
        }
    }
}

/// Thin HTTP client for the loopback daemon. Every call is async and runs off
/// the main thread; callers hop back to the main actor to touch UI.
final class DaemonClient: @unchecked Sendable {

    static let runtimeURL: URL = {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
        return base
            .appendingPathComponent("TokenForecaster", isDirectory: true)
            .appendingPathComponent("runtime.json", isDirectory: false)
    }()

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 8
        config.waitsForConnectivity = false
        // Loopback only; never route through a proxy.
        config.connectionProxyDictionary = [:]
        self.session = URLSession(configuration: config)
    }

    // MARK: - Runtime discovery

    func readRuntime() throws -> RuntimeInfo {
        let url = DaemonClient.runtimeURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw DaemonError.noRuntimeFile
        }
        guard let data = try? Data(contentsOf: url) else {
            throw DaemonError.badRuntimeFile
        }
        guard let info = try? JSONDecoder().decode(RuntimeInfo.self, from: data),
              let port = info.port, port > 0, info.token?.isEmpty == false else {
            throw DaemonError.badRuntimeFile
        }
        return info
    }

    /// Dashboard URL, or nil when the daemon is not advertising itself.
    func dashboardURL() -> URL? {
        guard let info = try? readRuntime(),
              let port = info.port,
              let token = info.token else { return nil }
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = "127.0.0.1"
        comps.port = port
        comps.path = "/dashboard"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url
    }

    func baseURLString() -> String? {
        guard let info = try? readRuntime(), let port = info.port else { return nil }
        return "http://127.0.0.1:\(port)"
    }

    // MARK: - Requests

    private func request(path: String, method: String, body: Data?) throws -> URLRequest {
        let info = try readRuntime()
        guard let port = info.port, let token = info.token,
              let url = URL(string: "http://127.0.0.1:\(port)\(path)") else {
            throw DaemonError.badRuntimeFile
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func send<T: Decodable>(_ type: T.Type, path: String, method: String, body: Data?) async throws -> T {
        let req = try request(path: path, method: method, body: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw DaemonError.connectionFailed(error.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw DaemonError.httpStatus(http.statusCode)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw DaemonError.decodeFailed(error.localizedDescription)
        }
    }

    func health() async throws -> HealthResponse {
        try await send(HealthResponse.self, path: "/health", method: "GET", body: nil)
    }

    func rebuild() async throws -> RebuildResponse {
        try await send(RebuildResponse.self, path: "/rebuild", method: "POST", body: Data("{}".utf8))
    }

    @discardableResult
    func setPaused(_ paused: Bool) async throws -> PauseResponse {
        let body = try JSONSerialization.data(withJSONObject: ["paused": paused])
        return try await send(PauseResponse.self, path: "/pause", method: "POST", body: body)
    }

    func settings() async throws -> SettingsResponse {
        try await send(SettingsResponse.self, path: "/settings", method: "GET", body: nil)
    }

    @discardableResult
    func updateSettings(
        codexDir: String? = nil,
        claudeDir: String? = nil,
        statusStyle: String? = nil,
        draftConditioning: Bool? = nil,
        shellAlias: Bool? = nil,
        shellAliasOffered: Bool? = nil
    ) async throws -> OKResponse {
        var payload: [String: Any] = [:]
        if let draftConditioning { payload["draftConditioning"] = draftConditioning }
        if let shellAlias { payload["shellAlias"] = shellAlias }
        if let shellAliasOffered { payload["shellAliasOffered"] = shellAliasOffered }
        if let codexDir { payload["codexDir"] = codexDir }
        if let claudeDir { payload["claudeDir"] = claudeDir }
        if let statusStyle { payload["statusStyle"] = statusStyle }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await send(OKResponse.self, path: "/settings", method: "POST", body: body)
    }

    /// Undo everything written outside the app bundle: shell block, then data.
    @discardableResult
    func uninstall() async throws -> UninstallResponse {
        try await send(UninstallResponse.self, path: "/uninstall", method: "POST", body: Data("{}".utf8))
    }

    @discardableResult
    func reset() async throws -> OKResponse {
        try await send(OKResponse.self, path: "/reset", method: "POST", body: Data("{}".utf8))
    }
}
