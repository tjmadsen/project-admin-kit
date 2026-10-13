import FirebaseAuth
import FirebaseFirestore
import Foundation
import GoogleSignIn
import UIKit

struct AdminCredentialBundle {
    let user: User
    let role: AdminAccessRole
    let googleIDToken: String
    let googleAccessToken: String
}

enum AdminAuthState {
    case loading
    case signedOut
    case checkingAdmin(User)
    case denied(User)
    case allowed(AdminCredentialBundle)
}

/// Owns native Google and Firebase authentication, then hands the fresh Google
/// credential to the embedded web console. Google blocks popup authentication
/// inside WKWebView, so the native-to-web credential handoff is required.
@MainActor
final class AdminAuthBridge: ObservableObject {
    @Published private(set) var state: AdminAuthState = .loading
    @Published private(set) var lastError: String?

    private var authHandle: AuthStateDidChangeListenerHandle?

    init() {
        authHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            guard user == nil else { return }
            Task { @MainActor in
                self?.state = .signedOut
            }
        }
    }

    deinit {
        if let authHandle {
            Auth.auth().removeStateDidChangeListener(authHandle)
        }
    }

    func bootstrap() async {
        guard GIDSignIn.sharedInstance.hasPreviousSignIn() else {
            signOut()
            return
        }

        do {
            let googleUser = try await restorePreviousGoogleSignIn()
            try await finishSignIn(with: googleUser)
        } catch {
            signOut()
        }
    }

    func signInWithGoogle() async {
        lastError = nil
        guard let presenter = topPresentingController() else {
            lastError = "Unable to open the Google sign-in screen."
            return
        }

        do {
            let result = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<GIDSignInResult, Error>) in
                GIDSignIn.sharedInstance.signIn(withPresenting: presenter) { result, error in
                    if let result {
                        continuation.resume(returning: result)
                    } else {
                        continuation.resume(throwing: error ?? AdminAuthError.googleSignInFailed)
                    }
                }
            }
            try await finishSignIn(with: result.user)
        } catch {
            lastError = error.localizedDescription
            state = .signedOut
        }
    }

    func signOut() {
        GIDSignIn.sharedInstance.signOut()
        try? Auth.auth().signOut()
        state = .signedOut
    }

    private func finishSignIn(with googleUser: GIDGoogleUser) async throws {
        let tokens = try await freshGoogleTokens(for: googleUser)
        let credential = GoogleAuthProvider.credential(
            withIDToken: tokens.idToken,
            accessToken: tokens.accessToken
        )
        let result = try await Auth.auth().signIn(with: credential)
        state = .checkingAdmin(result.user)

        guard result.user.isEmailVerified, let email = result.user.email?.lowercased() else {
            state = .denied(result.user)
            return
        }
        let access = try await Firestore.firestore().collection("adminUsers").document(email).getDocument()
        guard let role = AdminAccessPolicy.role(record: access.data(), emailVerified: true) else {
            state = .denied(result.user)
            return
        }

        state = .allowed(
            AdminCredentialBundle(
                user: result.user,
                role: role,
                googleIDToken: tokens.idToken,
                googleAccessToken: tokens.accessToken
            )
        )
    }

    private func restorePreviousGoogleSignIn() async throws -> GIDGoogleUser {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<GIDGoogleUser, Error>) in
            GIDSignIn.sharedInstance.restorePreviousSignIn { user, error in
                if let user {
                    continuation.resume(returning: user)
                } else {
                    continuation.resume(throwing: error ?? AdminAuthError.googleSignInFailed)
                }
            }
        }
    }

    private func freshGoogleTokens(
        for googleUser: GIDGoogleUser
    ) async throws -> (idToken: String, accessToken: String) {
        let refreshedUser = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<GIDGoogleUser, Error>) in
            googleUser.refreshTokensIfNeeded { user, error in
                if let user {
                    continuation.resume(returning: user)
                } else {
                    continuation.resume(throwing: error ?? AdminAuthError.tokenRefreshFailed)
                }
            }
        }

        guard let idToken = refreshedUser.idToken?.tokenString else {
            throw AdminAuthError.missingIDToken
        }
        return (idToken, refreshedUser.accessToken.tokenString)
    }

    private func topPresentingController() -> UIViewController? {
        guard
            let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
            let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first,
            var topController = window.rootViewController
        else {
            return nil
        }

        while let presentedController = topController.presentedViewController {
            topController = presentedController
        }
        return topController
    }
}

private enum AdminAuthError: LocalizedError {
    case googleSignInFailed
    case tokenRefreshFailed
    case missingIDToken

    var errorDescription: String? {
        switch self {
        case .googleSignInFailed:
            return "Google sign-in did not complete."
        case .tokenRefreshFailed:
            return "Google could not refresh the saved sign-in."
        case .missingIDToken:
            return "Google sign-in did not return an ID token."
        }
    }
}
