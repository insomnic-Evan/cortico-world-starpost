import XCTest
@testable import StarpostCore

final class IdentityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func session(subject: String = "ffa_test-a", account: String = "10001H", issuer: String = StarpostIdentity.issuer, token: String = String(repeating: "a", count: 64), expires: Double? = nil) -> LoginSession {
        LoginSession(accessToken: token, expiresAt: expires ?? (now.timeIntervalSince1970 + 86400) * 1000,
                     humanId: account, hubSubject: subject, hubIssuer: issuer)
    }
    func testUnsignedUpdatesAndBeijingMidnight() throws {
        func release(_ url: String) -> MobileRelease {
            MobileRelease(platform: "ios", version: "0.2.0", build: "2", signed: false, minimumIOS: "17.0", url: URL(string: url)!)
        }
        let link = MobileRelease.directory + "/0.2.0/starpost-ios-0.2.0-unsigned.ipa"
        XCTAssertTrue(release(link).isAvailable(after: 1, systemVersion: "27.2"))
        XCTAssertFalse(release(link).isAvailable(after: 2, systemVersion: "27.2"))
        XCTAssertFalse(release(link).isAvailable(after: 1, systemVersion: "16.6"))
        XCTAssertFalse(release(link + "?redirect=other").isAvailable(after: 1, systemVersion: "27.2"))
        let midnight = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-20T16:00:00Z"))
        XCTAssertNotEqual(MobileRelease.beijingDay(midnight.addingTimeInterval(-1)), MobileRelease.beijingDay(midnight))
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
        XCTAssertNoThrow(try make("https://8.148.13.225/web/hub/start?mobile=\(flow)").validate(now: now))
        XCTAssertFalse(StarpostIdentity.isTrusted(URL(string: "https://8.148.13.225/app")!))
        for url in ["https://8.148.13.225:8443/web/hub/start?mobile=\(flow)", "https://8.148.13.225.example.com/web/hub/start?mobile=\(flow)", "https://attacker.test/web/hub/start?mobile=\(flow)", "https://starpost.com.cn/web/hub/start?mobile=\(flow)&next=evil", "https://starpost.com.cn/app?mobile=\(flow)"] {
            XCTAssertThrowsError(try make(url).validate(now: now))
        }
        XCTAssertThrowsError(try make("https://starpost.com.cn/web/hub/start?mobile=\(flow)", expiry: -1).validate(now: now))
    }
    func testServiceFramesStaySeparateFromAuthenticatedNavigation() {
        let panel = "https://8.137.59.209/downloads/ffa/addons/coodock/web/1.0.0/index.html"
        for route in ["world", "workbench", "deployments"] {
            let url = URL(string: panel + "#" + route)!
            XCTAssertTrue(StarpostIdentity.isDockPanel(url, isMainFrame: false))
            XCTAssertFalse(StarpostIdentity.isDockPanel(url, isMainFrame: true))
            XCTAssertFalse(StarpostIdentity.isTrusted(url))
        }
        for candidate in [panel + "?redirect=x", panel + "/other", panel.replacingOccurrences(of: "1.0.0", with: "%2E%2E"), panel.replacingOccurrences(of: "8.137.59.209", with: "8.137.59.209.example.org"), panel.replacingOccurrences(of: "/downloads/", with: ":8443/downloads/")] {
            XCTAssertFalse(StarpostIdentity.isDockPanel(URL(string: candidate)!, isMainFrame: false))
        }
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
        let cookie = try session().webCookie(now: now)
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertEqual(cookie.path, "/web")
        XCTAssertEqual(cookie.sameSitePolicy, .sameSiteStrict)
        XCTAssertThrowsError(try session(expires: now.timeIntervalSince1970 * 1000).webCookie(now: now))
    }
}
