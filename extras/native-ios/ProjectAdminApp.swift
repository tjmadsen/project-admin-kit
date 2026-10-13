import FirebaseCore
import FirebaseMessaging
import GoogleSignIn
import SwiftUI
import UIKit
import UserNotifications

@main
struct ProjectAdminApp: App {
    @UIApplicationDelegateAdaptor(ProjectAdminAppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            AdminContentView()
                .onOpenURL { url in
                    GIDSignIn.sharedInstance.handle(url)
                }
                .task {
                    if let route = delegate.consumePendingNotificationRoute() {
                        NotificationCenter.default.post(
                            name: .projectAdminNotificationRoute,
                            object: route
                        )
                    }
                }
        }
    }
}
final class ProjectAdminAppDelegate: NSObject, UIApplicationDelegate {
    private var pendingNotificationRoute: AdminNotificationRoute?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        FirebaseApp.configure()
        UNUserNotificationCenter.current().delegate = self

        if let clientID = FirebaseApp.app()?.options.clientID {
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
        } else {
            assertionFailure("Google Sign-In client ID is missing from GoogleService-Info.plist")
        }

        return true
    }

    func consumePendingNotificationRoute() -> AdminNotificationRoute? {
        defer { pendingNotificationRoute = nil }
        return pendingNotificationRoute
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NSLog("ProjectAdmin remote notification registration failed: %@", error.localizedDescription)
    }
}

extension ProjectAdminAppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard
            let rawURL = response.notification.request.content.userInfo["primaryUrl"] as? String,
            let url = URL(string: rawURL),
            let route = AdminNotificationRoute(url: url)
        else {
            return
        }
        pendingNotificationRoute = route
        NotificationCenter.default.post(name: .projectAdminNotificationRoute, object: route)
    }
}
