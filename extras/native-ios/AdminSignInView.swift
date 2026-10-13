import SwiftUI

struct AdminSignInView: View {
    @ObservedObject var auth: AdminAuthBridge
    @State private var signingIn = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.02, green: 0.13, blue: 0.22),
                    Color(red: 0.03, green: 0.25, blue: 0.25),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                Image(systemName: "square.3.layers.3d")
                    .font(.system(size: 58))
                    .foregroundStyle(Color(red: 0.94, green: 0.65, blue: 0.18))

                VStack(spacing: 7) {
                    Text(AdminConfiguration.current.projectName)
                        .font(.system(size: 36, weight: .bold))
                        .foregroundStyle(.white)
                    Text("Admin")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.72))
                }

                Spacer()

                Button {
                    Task {
                        signingIn = true
                        await auth.signInWithGoogle()
                        signingIn = false
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "g.circle.fill")
                            .font(.title3)
                        Text(signingIn ? "Signing in…" : "Sign in with Google")
                            .font(.headline)
                    }
                    .frame(maxWidth: 320)
                    .padding(.vertical, 14)
                    .background(.white)
                    .foregroundStyle(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .disabled(signingIn)

                if let error = auth.lastError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red.opacity(0.95))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Spacer()

                Text("Authorized collaborators only")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.52))
                    .padding(.bottom, 32)
            }
            .padding(.horizontal, 32)
        }
    }
}
