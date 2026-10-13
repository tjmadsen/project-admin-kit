import Combine
import FirebaseAuth
import FirebaseFirestore
import FirebaseMessaging
import Foundation
import UIKit
import UserNotifications

enum AdminPushRegistrationPolicy {
    static func shouldRegister(
        role: AdminAccessRole?,
        authorizationStatus: UNAuthorizationStatus
    ) -> Bool {
        guard role != nil else { return false }
        return authorizationStatus == .authorized
            || authorizationStatus == .provisional
            || authorizationStatus == .ephemeral
    }
}

@MainActor
final class AdminNotificationCoordinator: NSObject, ObservableObject {
    private struct ActiveRegistration {
        let uid: String
        let email: String
        let deviceID: String

        var documentID: String { "\(uid)_\(deviceID)" }
    }

    private static let deviceIDKey = "ProjectAdminPushDeviceID"

    private let notificationCenter: UNUserNotificationCenter
    private let database: Firestore
    private let userDefaults: UserDefaults
    private var activeRegistration: ActiveRegistration?

    override convenience init() {
        self.init(
            notificationCenter: .current(),
            database: .firestore(),
            userDefaults: .standard
        )
    }

    init(
        notificationCenter: UNUserNotificationCenter,
        database: Firestore,
        userDefaults: UserDefaults
    ) {
        self.notificationCenter = notificationCenter
        self.database = database
        self.userDefaults = userDefaults
        super.init()
    }

    func activate(for user: User) async {
        guard
            let role = AdminAccessPolicy.role(
                email: user.email,
                emailVerified: user.isEmailVerified
            ),
            let email = user.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        else {
            return
        }

        let registration = ActiveRegistration(
            uid: user.uid,
            email: email,
            deviceID: deviceID()
        )

        var settings = await notificationCenter.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            do {
                _ = try await notificationCenter.requestAuthorization(options: [.alert, .badge, .sound])
                settings = await notificationCenter.notificationSettings()
            } catch {
                NSLog("ProjectAdmin notification permission request failed: %@", error.localizedDescription)
                return
            }
        }

        guard AdminPushRegistrationPolicy.shouldRegister(
            role: role,
            authorizationStatus: settings.authorizationStatus
        ) else {
            do {
                try await deleteDocument(registration.documentID)
            } catch {
                NSLog("ProjectAdmin disabled push token cleanup failed: %@", error.localizedDescription)
            }
            do {
                try await deleteMessagingToken()
            } catch {
                NSLog("ProjectAdmin disabled FCM token cleanup failed: %@", error.localizedDescription)
            }
            return
        }

        activeRegistration = registration
        Messaging.messaging().delegate = self
        UIApplication.shared.registerForRemoteNotifications()
        do {
            let token = try await messagingToken()
            try await persist(token: token)
        } catch {
            NSLog("ProjectAdmin push token registration failed: %@", error.localizedDescription)
        }
    }

    func deactivate() async {
        guard let activeRegistration else { return }
        self.activeRegistration = nil
        do {
            try await deleteDocument(activeRegistration.documentID)
        } catch {
            NSLog("ProjectAdmin push token removal failed: %@", error.localizedDescription)
        }
        do {
            try await deleteMessagingToken()
        } catch {
            NSLog("ProjectAdmin FCM token invalidation failed: %@", error.localizedDescription)
        }
    }

    private func deviceID() -> String {
        if let stored = userDefaults.string(forKey: Self.deviceIDKey), !stored.isEmpty {
            return stored
        }
        let generated = UUID().uuidString.lowercased()
        userDefaults.set(generated, forKey: Self.deviceIDKey)
        return generated
    }

    private func messagingToken() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            Messaging.messaging().token { token, error in
                if let token {
                    continuation.resume(returning: token)
                } else {
                    continuation.resume(throwing: error ?? AdminNotificationError.missingToken)
                }
            }
        }
    }

    private func deleteMessagingToken() async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            Messaging.messaging().deleteToken { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func persist(token: String) async throws {
        guard let activeRegistration, !token.isEmpty else { return }
        let values: [String: Any] = [
            "uid": activeRegistration.uid,
            "email": activeRegistration.email,
            "deviceId": activeRegistration.deviceID,
            "token": token,
            "platform": "ios_admin",
            "createdAt": FieldValue.serverTimestamp(),
            "updatedAt": FieldValue.serverTimestamp(),
        ]
        try await setDocument(activeRegistration.documentID, values: values)
    }

    private func setDocument(_ documentID: String, values: [String: Any]) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            database.collection("pushDeviceTokens").document(documentID).setData(values) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func deleteDocument(_ documentID: String) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            database.collection("pushDeviceTokens").document(documentID).delete { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }
}

extension AdminNotificationCoordinator: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { @MainActor [weak self] in
            do {
                try await self?.persist(token: fcmToken)
            } catch {
                NSLog("ProjectAdmin push token refresh failed: %@", error.localizedDescription)
            }
        }
    }
}

private enum AdminNotificationError: Error {
    case missingToken
}
