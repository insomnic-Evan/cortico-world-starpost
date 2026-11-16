import Foundation

struct ServiceError: LocalizedError {
    let status: Int
    var errorDescription: String? {
        switch status {
        case 401, 403: return "登录状态失效或访问权限已变更，请重新登录。"
        case 409, 410: return "本次登录已结束或过期，请重新发起。"
        case 429: return "请求较频繁，请稍后再试。"
        default: return "星邮暂时无法响应（\(status)），请稍后重试。"
        }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class StarpostAPI {
    private let client: URLSession
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 30
        client = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }
    private struct Envelope<T: Decodable>: Decodable { let ok: Bool; let result: T? }
    func post<T: Decodable>(_ path: String, body: [String: Any], token: String? = nil) async throws -> T {
        guard ["/mobile/hub/start", "/mobile/hub/poll", "/mobile/rpc"].contains(path) else { throw ClientError.invalidResponse }
        var request = URLRequest(url: StarpostIdentity.origin.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Starpost-iOS/0.1.0", forHTTPHeaderField: "User-Agent")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (bytes, response) = try await client.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard http.statusCode == 200 else { throw ServiceError(status: http.statusCode) }
        guard response.mimeType == "application/json" else { throw ClientError.invalidResponse }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 1_048_576 else { throw ClientError.invalidResponse }
            data.append(byte)
        }
        let envelope = try JSONDecoder().decode(Envelope<T>.self, from: data)
        guard envelope.ok, let result = envelope.result else { throw ClientError.invalidResponse }
        return result
    }
    struct Start: Decodable { let flowId: String; let authorizationUrl: URL; let expiresAt: Double }
    struct Poll: Decodable {
        let status: String
        let accessToken: String?; let expiresAt: Double?; let humanId: String?
        let hubSubject: String?; let hubIssuer: String?
        func session() throws -> LoginSession {
            guard status == "complete", let accessToken, let expiresAt, let humanId, let hubSubject, let hubIssuer else { throw ClientError.invalidResponse }
            let value = LoginSession(accessToken: accessToken, expiresAt: expiresAt, humanId: humanId, hubSubject: hubSubject, hubIssuer: hubIssuer)
            try value.validate()
            return value
        }
    }
    func account(_ session: LoginSession) async throws -> AccountInfo {
        try await post("/mobile/rpc", body: ["action": "account.info", "args": [:]], token: session.accessToken)
    }
    func revoke(_ session: LoginSession) async {
        struct Logout: Decodable {}
        let _: Logout? = try? await post("/mobile/rpc", body: ["action": "logout", "args": [:]], token: session.accessToken)
    }
}
