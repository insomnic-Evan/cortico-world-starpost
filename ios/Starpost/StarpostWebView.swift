import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct StarpostWebView: UIViewControllerRepresentable {
    let session: LoginSession
    let reload: Int
    let onSessionEnded: () -> Void
    func makeUIViewController(context: Context) -> BrowserController {
        BrowserController(session: session, onSessionEnded: onSessionEnded)
    }
    func updateUIViewController(_ controller: BrowserController, context: Context) {
        if controller.reloadNumber != reload {
            controller.reloadNumber = reload
            controller.retry()
        }
    }
    static func dismantleUIViewController(_ controller: BrowserController, coordinator: ()) { controller.stop() }
}

@MainActor
final class BrowserController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private let session: LoginSession
    private let onSessionEnded: () -> Void
    private var web: WKWebView!
    private var progress = UIActivityIndicatorView(style: .medium)
    private var errorPanel = UIStackView()
    private var active = true
    private var installedCookie = false
    private var setupTask: Task<Void, Never>?
    private var downloads: [ObjectIdentifier: URL] = [:]
    var reloadNumber = 0

    init(session: LoginSession, onSessionEnded: @escaping () -> Void) {
        self.session = session
        self.onSessionEnded = onSessionEnded
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: session.storeIdentifier)
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // Isolated-world, main-frame-only signal. No token, RPC, filesystem or account-switch bridge.
        configuration.userContentController.add(self, contentWorld: .defaultClient, name: "starpostSession")
        let observer = """
        (() => {
          let sent = false;
          const check = () => {
            const login = document.getElementById('login');
            if (!sent && login && !login.classList.contains('hidden') && getComputedStyle(login).display !== 'none') {
              sent = true;
              window.webkit.messageHandlers.starpostSession.postMessage('signed-out');
            }
          };
          new MutationObserver(check).observe(document.documentElement, {subtree:true, attributes:true, attributeFilter:['class'], childList:true});
          check();
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: observer, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.scrollView.keyboardDismissMode = .interactive
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.topAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progress)
        NSLayoutConstraint.activate([progress.centerXAnchor.constraint(equalTo: view.centerXAnchor), progress.topAnchor.constraint(equalTo: view.topAnchor, constant: 12)])
        let label = UILabel()
        label.text = "页面暂时无法载入，请检查网络后重试。"
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        let retryButton = UIButton(type: .system)
        retryButton.setTitle("重新连接", for: .normal)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        errorPanel = UIStackView(arrangedSubviews: [label, retryButton])
        errorPanel.axis = .vertical
        errorPanel.spacing = 16
        errorPanel.backgroundColor = .secondarySystemBackground
        errorPanel.isLayoutMarginsRelativeArrangement = true
        errorPanel.layoutMargins = UIEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        errorPanel.layer.cornerRadius = 24
        errorPanel.translatesAutoresizingMaskIntoConstraints = false
        errorPanel.isHidden = true
        view.addSubview(errorPanel)
        NSLayoutConstraint.activate([
            errorPanel.centerXAnchor.constraint(equalTo: view.centerXAnchor), errorPanel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorPanel.widthAnchor.constraint(lessThanOrEqualToConstant: 400),
            errorPanel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            errorPanel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])
        retry()
    }

    @objc func retry() {
        guard active, web != nil else { return }
        errorPanel.isHidden = true
        progress.startAnimating()
        setupTask?.cancel()
        setupTask = Task { [weak self] in
            guard let self else { return }
            do {
                try session.validate()
                if !installedCookie {
                    let store = web.configuration.websiteDataStore.httpCookieStore
                    for existing in await store.allCookies() where existing.name == "starpost_session" { await store.deleteCookie(existing) }
                    guard active, !Task.isCancelled else { return }
                    guard let cookie = HTTPCookie(properties: [
                        .name: "starpost_session", .value: session.accessToken,
                        .domain: StarpostIdentity.origin.host!, .path: "/web",
                        .secure: "TRUE", .expires: session.expiration,
                        HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                        HTTPCookiePropertyKey("SameSite"): "Strict"
                    ]), cookie.isHTTPOnly, cookie.isSecure else { throw ClientError.invalidResponse }
                    await store.setCookie(cookie)
                    installedCookie = true
                }
                guard active, !Task.isCancelled else { return }
                let current = web.url.flatMap { StarpostIdentity.isTrusted($0) && $0.path.hasPrefix("/app") ? $0 : nil }
                web.load(URLRequest(url: current ?? StarpostIdentity.origin.appendingPathComponent("app/social")))
            } catch {
                guard active, !Task.isCancelled else { return }
                progress.stopAnimating()
                if session.expiration <= Date() { onSessionEnded() }
                else { errorPanel.isHidden = false }
            }
        }
    }

    func stop() {
        active = false
        setupTask?.cancel()
        web?.stopLoading()
        web?.navigationDelegate = nil
        web?.uiDelegate = nil
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "starpostSession", contentWorld: .defaultClient)
        web?.configuration.userContentController.removeAllUserScripts()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard active, message.frameInfo.isMainFrame,
              let source = message.frameInfo.request.url, StarpostIdentity.isTrusted(source),
              message.name == "starpostSession", message.body as? String == "signed-out" else { return }
        onSessionEnded()
    }

    private func isOwnBlob(_ url: URL) -> Bool { url.absoluteString.hasPrefix("blob:\(StarpostIdentity.origin.absoluteString)/") }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard active, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == StarpostIdentity.callbackScheme { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload && (StarpostIdentity.isTrusted(url) || isOwnBlob(url)) {
            decisionHandler(.download); return
        }
        if StarpostIdentity.isTrusted(url) {
            if url.path == "/login" || url.path.hasPrefix("/web/hub/") {
                decisionHandler(.cancel); onSessionEnded(); return
            }
            if navigationAction.targetFrame == nil { webView.load(navigationAction.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
            return
        }
        decisionHandler(.cancel)
        // An external navigation never inherits the authenticated WebView or its cookie store.
        if navigationAction.navigationType == .linkActivated, navigationAction.targetFrame?.isMainFrame != false,
           url.scheme == "https", url.user == nil, url.password == nil {
            UIApplication.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, StarpostIdentity.isTrusted(url) || isOwnBlob(url) else {
            decisionHandler(.cancel); return
        }
        if navigationResponse.canShowMIMEType { decisionHandler(.allow) }
        else if navigationResponse.response.mimeType?.hasPrefix("image/") == true || navigationResponse.response.mimeType?.hasPrefix("audio/") == true {
            decisionHandler(.download)
        } else { decisionHandler(.cancel) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { progress.stopAnimating(); errorPanel.isHidden = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { progress.stopAnimating(); errorPanel.isHidden = false }
    private func showFailure(_ error: Error) {
        guard active else { return }
        progress.stopAnimating()
        if (error as NSError).code != NSURLErrorCancelled { errorPanel.isHidden = false }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let valid = active && frame.isMainFrame && origin.protocol == "https" && origin.host == StarpostIdentity.origin.host
            && (origin.port == 0 || origin.port == 443) && UIApplication.shared.applicationState == .active
        decisionHandler(valid ? .prompt : .deny)
    }

    private func canPresent(_ frame: WKFrameInfo) -> Bool {
        active && frame.isMainFrame && frame.request.url.map(StarpostIdentity.isTrusted) == true
            && presentedViewController == nil && view.window != nil
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard canPresent(frame) else { completionHandler(); return }
        let alert = UIAlertController(title: "星邮", message: String(message.prefix(4000)), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "知道了", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard canPresent(frame) else { completionHandler(false); return }
        let alert = UIAlertController(title: "星邮", message: String(message.prefix(4000)), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard canPresent(frame) else { completionHandler(nil); return }
        let alert = UIAlertController(title: "星邮", message: String(prompt.prefix(4000)), preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard active, response.expectedContentLength <= 25 * 1024 * 1024,
              let url = response.url, StarpostIdentity.isTrusted(url) || isOwnBlob(url) else { completionHandler(nil); return }
        let ext = (suggestedFilename as NSString).pathExtension.lowercased()
        guard ["jpg", "jpeg", "png", "gif", "webp", "mp3", "m4a", "mp4", "ogg", "webm", "wav"].contains(ext) else { completionHandler(nil); return }
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("starpost-share-\(UUID().uuidString).\(ext)")
        downloads[ObjectIdentifier(download)] = target
        completionHandler(target)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        guard active, presentedViewController == nil else { try? FileManager.default.removeItem(at: file); return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file) }
        present(share, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file) }
        if active { errorPanel.isHidden = false }
    }
}
