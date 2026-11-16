import XCTest
@testable import StarpostCore

final class IdentityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func session(subject: String = "ffa_test-a", account: String = "10001H", issuer: String = StarpostIdentity.issuer, token: String = String(repeating: "a", count: 64), expires: Double? = nil) -> LoginSession {
        LoginSession(accessToken: token, expiresAt: expires ?? (now.timeIntervalSince1970 + 86400) * 1000,
                     humanId: account, hubSubject: subject, hubIssuer: issuer)
    }
    func testPKCERFC7636Vector() {
        XCTAssertEqual(StarpostIdentity.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    func testExactHTTPSOrigin() {
        XCTAssertTrue(StarpostIdentity.isTrusted(URL(string: "https://starpost.com.cn/app/social")!))
        XCTAssertTrue(StarpostIdentity.isTrusted(URL(string: "https://starpost.com.cn:443/app")!))
        for input in ["http://starpost.com.cn/app", "https://starpost.com.cn.attacker.test/app", "https://user@starpost.com.cn/app", "https://starpost.com.cn:8443/app", "https://ffahub.net/app", "file:///app"] {
            XCTAssertFalse(StarpostIdentity.isTrusted(URL(string: input)!), input)
        }
    }
    func testCallbackIsBoundToPendingFlowAndContainsNoToken() throws {
        let flow = String(repeating: "a", count: 43)
        try StarpostIdentity.validateCallback(URL(string: "io.starpost.mobile://hub/return?flow=\(flow)")!, flowID: flow)
        for input in [
            "io.starpost.mobile://hub/return?flow=\(flow)&accessToken=bad",
            "io.starpost.mobile://hub/return?flow=\(flow)&flow=\(flow)",
            "io.starpost.mobile://hub/return?flow=\(flow)#fragment",
            "io.starpost.mobile://attacker/return?flow=\(flow)",
            "io.starpost.mobile://hub/return?flow=\(String(repeating: "b", count: 43))",
            "io.starpost.mobile://user@hub/return?flow=\(flow)",
            "https://hub/return?flow=\(flow)"
        ] {
            XCTAssertThrowsError(try StarpostIdentity.validateCallback(URL(string: input)!, flowID: flow), input)
        }
    }
    func testNativeFlowRejectsUntrustedAuthorizationDestination() {
        let flow = String(repeating: "a", count: 43)
        func make(_ url: String, expiry: Double = 300_000) -> HubFlow {
            HubFlow(flowId: flow, verifier: flow, authorizationUrl: URL(string: url)!, expiresAt: now.timeIntervalSince1970 * 1000 + expiry)
        }
        XCTAssertNoThrow(try make("https://starpost.com.cn/web/hub/start?mobile=\(flow)").validate(now: now))
        for url in ["https://attacker.test/web/hub/start?mobile=\(flow)", "https://starpost.com.cn/web/hub/start?mobile=\(flow)&next=evil", "https://starpost.com.cn/app?mobile=\(flow)"] {
            XCTAssertThrowsError(try make(url).validate(now: now))
        }
        XCTAssertThrowsError(try make("https://starpost.com.cn/web/hub/start?mobile=\(flow)", expiry: -1).validate(now: now))
    }
    func testInvalidIdentityAndExpirationCannotOpenWebView() {
        XCTAssertNoThrow(try session().validate(now: now))
        for invalid in [session(account: "9999H"), session(account: "10001"), session(issuer: "https://attacker.test"), session(subject: "missing-prefix"), session(token: "short"), session(expires: now.timeIntervalSince1970 * 1000), session(expires: (now.timeIntervalSince1970 + 20 * 86400) * 1000)] {
            XCTAssertThrowsError(try invalid.validate(now: now))
        }
    }
    func testWebDataIsolationIncludesHubAndBusinessAccount() {
        let first = session()
        XCTAssertEqual(first.storeIdentifier, session().storeIdentifier)
        XCTAssertNotEqual(first.storeIdentifier, session(subject: "ffa_test-b").storeIdentifier)
        XCTAssertNotEqual(first.storeIdentifier, session(account: "10002H").storeIdentifier)
        XCTAssertNotEqual(first.storeIdentifier, session(issuer: "https://other.test").storeIdentifier)
        // Renewing a token does not lose this account's stickers/backgrounds.
        XCTAssertEqual(first.storeIdentifier, session(token: String(repeating: "b", count: 64)).storeIdentifier)
    }
    func testServerAccountCannotSilentlySwitchTheSession() throws {
        let s = LoginSession(accessToken: String(repeating: "a", count: 64), expiresAt: (Date().timeIntervalSince1970 + 3600) * 1000, humanId: "10001H", hubSubject: "ffa_test-a", hubIssuer: StarpostIdentity.issuer)
        try s.validate(account: AccountInfo(humanId: "10001H", hubSubject: "ffa_test-a", hubIssuer: StarpostIdentity.issuer))
        for info in [AccountInfo(humanId: "10002H", hubSubject: "ffa_test-a", hubIssuer: StarpostIdentity.issuer), AccountInfo(humanId: "10001H", hubSubject: "ffa_test-b", hubIssuer: StarpostIdentity.issuer)] {
            XCTAssertThrowsError(try s.validate(account: info))
        }
    }
    func testSessionCookieIsHttpOnlyAndSecure() throws {
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .name: "starpost_session", .value: String(repeating: "a", count: 64),
            .domain: "starpost.com.cn", .path: "/web", .secure: "TRUE",
            .expires: Date().addingTimeInterval(3600),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE", HTTPCookiePropertyKey("SameSite"): "Strict"
        ]))
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertEqual(cookie.path, "/web")
    }
}
