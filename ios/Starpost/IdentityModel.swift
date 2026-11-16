import AuthenticationServices
import Combine
import WebKit

@MainActor
final class IdentityModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published private(set) var session: LoginSession?
    @Published private(set) var pending: HubFlow?
    @Published private(set) var busy = false
    @Published private(set) var hasSavedSession = false
    @Published var message: String?
    private var candidate: LoginSession?
    private var browser: ASWebAuthenticationSession?
    private var generation = 0
    private var booted = false
    private let api = StarpostAPI()

    func restore() async {
        guard !booted else { return }
        booted = true
        do {
            candidate = try KeychainVault.read("session", as: LoginSession.self)
            hasSavedSession = candidate != nil
            if let flow = try KeychainVault.read("pending", as: HubFlow.self) {
                if (try? flow.validate()) != nil { pending = flow }
                else { try KeychainVault.remove("pending") }
            }
            if candidate != nil { await verifySaved() }
        } catch { message = "无法读取安全登录状态，请解锁设备后重试。" }
    }

    func verifySaved() async {
        guard !busy, let value = candidate else { return }
        busy = true
        let turn = generation
        defer { if turn == generation { busy = false } }
        do {
            try value.validate()
            let account = try await api.account(value)
            guard turn == generation else { return }
            try value.validate(account: account)
            session = value
            message = nil
        } catch {
            guard turn == generation else { return }
            session = nil
            if let service = error as? ServiceError, [401, 403].contains(service.status) {
                await signOut(revoke: false)
            } else if error is ClientError {
                await signOut(revoke: false)
            }
            message = friendly(error)
        }
    }

    func startLogin() async {
        guard !busy else { return }
        busy = true
        generation += 1
        let turn = generation
        message = nil
        defer { if turn == generation { busy = false } }
        do {
            let verifier = try KeychainVault.verifier()
            let start: StarpostAPI.Start = try await api.post("/mobile/hub/start", body: ["challenge": StarpostIdentity.challenge(verifier)])
            guard turn == generation else { return }
            let flow = HubFlow(flowId: start.flowId, verifier: verifier, authorizationUrl: start.authorizationUrl, expiresAt: start.expiresAt)
            try flow.validate()
            try KeychainVault.save(flow, key: "pending")
            pending = flow
            openAuthorization(flow)
        } catch { if turn == generation { message = friendly(error) } }
    }

    func reopenLogin() {
        guard let flow = pending, !busy else { return }
        do { try flow.validate(); openAuthorization(flow) }
        catch { message = friendly(error) }
    }

    private func openAuthorization(_ flow: HubFlow) {
        browser?.cancel()
        let turn = generation
        let auth = ASWebAuthenticationSession(url: flow.authorizationUrl, callbackURLScheme: StarpostIdentity.callbackScheme) { [weak self] url, error in
            Task { @MainActor in
                guard let self, turn == self.generation else { return }
                self.browser = nil
                if let url { await self.handleCallback(url) }
                else if error != nil { self.message = "登录窗口已关闭。若已在 Hub 授权，可点击“完成登录”；也可重新打开。" }
            }
        }
        auth.presentationContextProvider = self
        // Hub always prompts for account selection/consent; preserve browser SSO convenience.
        auth.prefersEphemeralWebBrowserSession = false
        browser = auth
        if !auth.start() { browser = nil; message = "无法打开系统登录窗口，请稍后重试。" }
    }

    func handleCallback(_ url: URL) async {
        guard let flow = pending else { return }
        do { try flow.validate(); try StarpostIdentity.validateCallback(url, flowID: flow.flowId) }
        catch { message = friendly(error); return }
        await finishLogin()
    }

    func finishLogin() async {
        guard !busy, let flow = pending else { return }
        busy = true
        let turn = generation
        do {
            try flow.validate()
            let result: StarpostAPI.Poll = try await api.post("/mobile/hub/poll", body: ["flowId": flow.flowId, "verifier": flow.verifier])
            guard turn == generation else { return }
            if result.status == "pending" {
                message = "还未完成授权，请在系统浏览器完成 Hub 登录与星邮账号选择后再试。"
                busy = false
                return
            }
            let value = try result.session()
            // Persist before the second network check: redemption is single-use, networks can fail.
            try KeychainVault.save(value, key: "session")
            try KeychainVault.remove("pending")
            pending = nil
            candidate = value
            hasSavedSession = true
            browser?.cancel()
            browser = nil
            busy = false
            await verifySaved()
        } catch {
            guard turn == generation else { return }
            busy = false
            message = friendly(error)
            if let service = error as? ServiceError, [403, 409, 410].contains(service.status) { cancelLogin() }
        }
    }

    func cancelLogin() {
        generation += 1
        browser?.cancel()
        browser = nil
        pending = nil
        busy = false
        do { try KeychainVault.remove("pending") } catch { message = friendly(error) }
    }

    func foreground() async {
        guard booted, !busy, candidate != nil else { return }
        await verifySaved()
    }

    func checkExpiration() async {
        guard let value = session, value.expiration <= Date() else { return }
        await signOut(revoke: false)
        message = ClientError.expired.localizedDescription
    }

    func signOut(revoke: Bool = true) async {
        let previous = candidate
        generation += 1
        browser?.cancel()
        browser = nil
        session = nil
        candidate = nil
        hasSavedSession = false
        pending = nil
        busy = false
        do { try KeychainVault.remove("session"); try KeychainVault.remove("pending") }
        catch { message = friendly(error) }
        if let previous {
            let cookies = WKWebsiteDataStore(forIdentifier: previous.storeIdentifier).httpCookieStore
            for cookie in await cookies.allCookies() where cookie.name == "starpost_session" {
                await cookies.deleteCookie(cookie)
            }
            if revoke { await api.revoke(previous) }
        }
    }

    func webSessionEnded(_ expected: LoginSession) async {
        guard session == expected else { return }
        await signOut(revoke: false)
        message = "已退出登录，请通过 FFA hub 重新登录。"
    }

    private func friendly(_ error: Error) -> String {
        if error is ClientError || error is ServiceError { return error.localizedDescription }
        return "连接失败，请检查网络后重试。已保存的登录状态不会因暂时断网丢失。"
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}
