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
            let prefix = Self.referencePrefix(forPath: url.path),
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let reference = components.queryItems?.first(where: { $0.name == "item" })?.value,
            Self.reference(reference, hasPrefix: prefix)
        else {
            return nil
        }
        self.url = url
    }

    /// The reference prefix of the work kind whose admin route is `path`, if any.
    private static func referencePrefix(forPath path: String) -> String? {
        let configuration = AdminConfiguration.current
        return configuration.resolvedWorkItemRoutes.first(where: { route, _ in
            configuration.adminURL.appending(path: route).path == path
        })?.value
    }

    private static func reference(_ reference: String, hasPrefix prefix: String) -> Bool {
        let expected = prefix + "-"
        guard reference.hasPrefix(expected) else { return false }
        let number = reference.dropFirst(expected.count)
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
