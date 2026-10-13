import FirebaseAuth
import SwiftUI

struct AdminContentView: View {
    @StateObject private var auth = AdminAuthBridge()
    @StateObject private var notificationCoordinator = AdminNotificationCoordinator()
    @StateObject private var notificationRouter = AdminNotificationRouter()

    var body: some View {
        Group {
            switch auth.state {
            case .loading, .checkingAdmin:
                ProgressView("Opening the control room…")
                    .controlSize(.large)
            case .signedOut:
                AdminSignInView(auth: auth)
            case .denied(let user):
                AdminAccessDeniedView(user: user, auth: auth)
            case .allowed(let credential):
                AdminWebView(
                    credential: credential,
                    notificationRoute: notificationRouter.route,
                    onSignOut: {
                        Task {
                            await notificationCoordinator.deactivate()
                            auth.signOut()
                        }
                    }
                )
                    .ignoresSafeArea(edges: .bottom)
                    .task(id: credential.user.uid) {
                        await notificationCoordinator.activate(for: credential.user)
                    }
            }
        }
        .task {
            await auth.bootstrap()
        }
    }
}

private struct AdminAccessDeniedView: View {
    let user: User
    let auth: AdminAuthBridge

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 54))
                .foregroundStyle(.red)
            Text("Access denied")
                .font(.title.bold())
            Text("This Google account is not an authorized collaborator.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Text(user.email ?? "")
                .font(.footnote)
                .foregroundStyle(.tertiary)
            Button("Sign out", action: auth.signOut)
                .buttonStyle(.borderedProminent)
        }
        .padding(32)
    }
}
