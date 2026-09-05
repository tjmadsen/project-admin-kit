import Combine
import Foundation

struct AdminNotificationRoute: Equatable, Identifiable {
    let id = UUID()
    let url: URL

    init?(url: URL) {
        guard
            let adminComponents = URLComponents(url: AdminConfiguration.current.adminURL, resolvingAgainstBaseURL: false),
            url.scheme?.lowercased() == "https",
            url.host?.lowercased() == adminComponents.host?.lowercased(),
            url.port == nil,
            url.user == nil,
            url.password == nil,
            url.fragment == nil,
            ["features", "bugs"].map({ AdminConfiguration.current.adminURL.appending(path: $0).path }).contains(url.path),
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let reference = components.queryItems?.first(where: { $0.name == "item" })?.value,
            Self.reference(reference, matchesPath: url.path)
        else {
            return nil
        }
        self.url = url
    }

    private static func reference(_ reference: String, matchesPath path: String) -> Bool {
        let prefix = path.hasSuffix("/bugs") ? "BUG-" : "FR-"
        guard reference.hasPrefix(prefix) else { return false }
        let number = reference.dropFirst(prefix.count)
        return !number.isEmpty && number.allSatisfy(\.isNumber)
    }
}

extension Notification.Name {
    static let projectAdminNotificationRoute = Notification.Name("ProjectAdminNotificationRoute")
}

@MainActor
final class AdminNotificationRouter: ObservableObject {
    @Published private(set) var route: AdminNotificationRoute?

    private let notificationCenter: NotificationCenter
    private var observer: NSObjectProtocol?

    init(notificationCenter: NotificationCenter = .default) {
        self.notificationCenter = notificationCenter
        observer = notificationCenter.addObserver(
            forName: .projectAdminNotificationRoute,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let route = notification.object as? AdminNotificationRoute else { return }
            Task { @MainActor in
                self?.route = route
            }
        }
    }

    deinit {
        if let observer {
            notificationCenter.removeObserver(observer)
        }
    }
}
