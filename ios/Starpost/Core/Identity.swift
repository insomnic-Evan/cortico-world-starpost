import Foundation
import CryptoKit

enum ClientError: LocalizedError {
    case invalidIdentity, invalidCallback, invalidResponse, expired, keychain, unavailable
    var errorDescription: String? {
        switch self {
        case .invalidIdentity: return "登录身份不匹配，请重新通过 FFA hub 登录。"
        case .invalidCallback: return "登录回调无效，请重新发起登录。"
        case .invalidResponse: return "服务器响应无效，请稍后重试。"
        case .expired: return "登录已过期，请重新通过 FFA hub 验证。"
        case .keychain: return "无法安全保存登录状态，请解锁设备后重试。"
        case .unavailable: return "暂时无法连接星邮，请检查网络后重试。"
        }
    }
}

enum StarpostIdentity {
    static let origin = URL(string: "https://starpost.com.cn")!
    static let issuer = "https://ffahub.net"
    // Matches the existing server callback; no token is carried in this URL.
    static let callbackScheme = "io.starpost.mobile"
    static func isTrusted(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.scheme == "https" && c.host == origin.host && (c.port == nil || c.port == 443)
            && c.user == nil && c.password == nil
    }
    static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }
    static func challenge(_ verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    static func validateCallback(_ url: URL, flowID: String) throws {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme == callbackScheme, c.host == "hub", c.path == "/return",
              c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
              c.queryItems == [URLQueryItem(name: "flow", value: flowID)],
              matches(flowID, "^[A-Za-z0-9_-]{43}$") else { throw ClientError.invalidCallback }
    }
}

struct HubFlow: Codable, Equatable {
    let flowId: String
    let verifier: String
    let authorizationUrl: URL
    let expiresAt: Double
    func validate(now: Date = Date()) throws {
        guard expiresAt.isFinite, expiresAt > now.timeIntervalSince1970 * 1000 else { throw ClientError.expired }
        guard expiresAt <= (now.timeIntervalSince1970 + 660) * 1000,
              StarpostIdentity.matches(flowId, "^[A-Za-z0-9_-]{43}$"),
              StarpostIdentity.matches(verifier, "^[A-Za-z0-9_-]{43,128}$"),
              StarpostIdentity.isTrusted(authorizationUrl), authorizationUrl.path == "/web/hub/start",
              let c = URLComponents(url: authorizationUrl, resolvingAgainstBaseURL: false), c.fragment == nil,
              c.queryItems == [URLQueryItem(name: "mobile", value: flowId)] else { throw ClientError.invalidResponse }
    }
}

struct AccountInfo: Decodable {
    let humanId: String
    let hubSubject: String
    let hubIssuer: String
}

struct LoginSession: Codable, Equatable {
    let accessToken: String
    let expiresAt: Double
    let humanId: String
    let hubSubject: String
    let hubIssuer: String
    var expiration: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
    func validate(now: Date = Date()) throws {
        guard expiresAt.isFinite, expiration > now else { throw ClientError.expired }
        guard expiration.timeIntervalSince(now) <= 14 * 86400 + 300,
              StarpostIdentity.matches(accessToken, "^[a-f0-9]{64}$"),
              StarpostIdentity.matches(humanId, "^[1-9][0-9]{4,11}H$"),
              let numericID = Int(humanId.dropLast()), numericID >= 10001,
              hubSubject.hasPrefix("ffa_"), hubSubject.count <= 128,
              StarpostIdentity.matches(hubSubject, "^ffa_[A-Za-z0-9-]+$"),
              hubIssuer == StarpostIdentity.issuer else { throw ClientError.invalidIdentity }
    }
    func validate(account: AccountInfo) throws {
        try validate()
        guard account.humanId == humanId, account.hubSubject == hubSubject,
              account.hubIssuer == hubIssuer else { throw ClientError.invalidIdentity }
    }
    func webCookie(now: Date = Date()) throws -> HTTPCookie {
        try validate(now: now)
        let age = Int(expiration.timeIntervalSince(now))
        let header = "starpost_session=\(accessToken); Path=/web; Secure; HttpOnly; SameSite=Strict; Max-Age=\(age)"
        let parsed = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: StarpostIdentity.origin)
        guard parsed.count == 1, let cookie = parsed.first, cookie.name == "starpost_session",
              cookie.isHTTPOnly, cookie.isSecure, cookie.sameSitePolicy == .sameSiteStrict,
              cookie.path == "/web", cookie.domain == StarpostIdentity.origin.host else { throw ClientError.invalidResponse }
        return cookie
    }
    // The issuer, Hub subject AND Starpost business account all partition local storage.
    var storeIdentifier: UUID {
        let scope = [StarpostIdentity.origin.absoluteString, hubIssuer, hubSubject, humanId]
        let bytes = try! JSONEncoder().encode(scope)
        var b = Array(SHA256.hash(data: bytes).prefix(16))
        b[6] = (b[6] & 0x0f) | 0x50
        b[8] = (b[8] & 0x3f) | 0x80
        return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                           b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
    }
}
