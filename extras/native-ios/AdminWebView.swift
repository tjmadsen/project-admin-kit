import SwiftUI
import UIKit
import WebKit

private let adminURL = AdminConfiguration.current.adminURL

struct AdminWebView: UIViewRepresentable {
    let credential: AdminCredentialBundle
    let notificationRoute: AdminNotificationRoute?
    let onSignOut: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSignOut: onSignOut)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.applicationNameForUserAgent = "ProjectAdminApp/1.0"

        let userContentController = WKUserContentController()
        userContentController.add(context.coordinator, name: "adminBridge")
        userContentController.addUserScript(credentialInjectionScript())
        configuration.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        context.coordinator.webView = webView

        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(
            context.coordinator,
            action: #selector(Coordinator.handleRefresh(_:)),
            for: .valueChanged
        )
        webView.scrollView.refreshControl = refreshControl
        context.coordinator.refreshControl = refreshControl

        let initialURL = notificationRoute?.url ?? adminURL
        context.coordinator.lastNotificationRouteID = notificationRoute?.id
        var request = URLRequest(url: initialURL)
        request.cachePolicy = .reloadRevalidatingCacheData
        webView.load(request)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard
            let url = notificationRoute?.url,
            context.coordinator.lastNotificationRouteID != notificationRoute?.id
        else {
            return
        }
        context.coordinator.lastNotificationRouteID = notificationRoute?.id
        webView.load(URLRequest(url: url))
    }

    private func credentialInjectionScript() -> WKUserScript {
        let payload: [String: String] = [
            "googleIDToken": credential.googleIDToken,
            "googleAccessToken": credential.googleAccessToken,
            "role": credential.role.rawValue,
        ]
        let payloadData = try! JSONSerialization.data(withJSONObject: payload)
        let payloadJSON = String(decoding: payloadData, as: UTF8.self)
        let source = """
        (function() {
          window.__adminNativeShell = Object.assign(\(payloadJSON), {
            postMessage: function(message) {
              try { window.webkit.messageHandlers.adminBridge.postMessage(message); } catch (_) {}
            }
          });
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let onSignOut: () -> Void
        weak var webView: WKWebView?
        weak var refreshControl: UIRefreshControl?
        var lastNotificationRouteID: UUID?

        init(onSignOut: @escaping () -> Void) {
            self.onSignOut = onSignOut
        }

        @objc func handleRefresh(_ sender: UIRefreshControl) {
            webView?.reloadFromOrigin()
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                return
            }
            if type == "signOut" || type == "authFailed" {
                onSignOut()
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            let isUserNavigation = navigationAction.navigationType == .linkActivated
                || navigationAction.targetFrame == nil
            if isUserNavigation && !Self.isAdminURL(url) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                if Self.isAdminURL(url) {
                    webView.load(URLRequest(url: url))
                } else {
                    UIApplication.shared.open(url)
                }
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            refreshControl?.endRefreshing()
        }

        private static func isAdminURL(_ url: URL) -> Bool {
            guard url.scheme == "https", url.host == adminURL.host else {
                return false
            }
            return url.path == "/admin" || url.path.hasPrefix("/admin/")
        }
    }
}
