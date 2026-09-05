import {
  GoogleAuthProvider,
  signInWithCredential,
  signOut,
  type Auth,
} from 'firebase/auth'

declare global {
  interface Window {
    __adminNativeShell?: {
      googleIDToken: string
      googleAccessToken: string
      role?: string
      /** Appearance the wrapper is rendering in; honoured while the stored theme is "system". */
      appearance?: 'light' | 'dark'
      postMessage?: (message: unknown) => void
    }
    __adminNativeBridge?: AdminNativeBridge
    webkit?: {
      messageHandlers?: {
        adminBridge?: { postMessage: (message: unknown) => void }
      }
    }
  }
}

export interface AdminNativeBridge {
  readonly isNative: boolean
  readonly authReady: Promise<void>
  deepLink: (path: string) => void
  requestNativeSignOut: () => void
}

export function detectNativeShell(): boolean {
  return /ProjectAdminApp\//.test(navigator.userAgent) || Boolean(window.__adminNativeShell)
}

export function normalizeAdminPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  return trimmed
}

/**
 * Initializes the one-per-page native bridge before React subscribes to auth.
 * Waiting for authReady prevents the native shell from flashing the web login
 * screen while Firebase exchanges the injected Google credential.
 */
export function initNativeBridge(auth: Auth): AdminNativeBridge {
  if (window.__adminNativeBridge) return window.__adminNativeBridge

  const isNative = detectNativeShell()
  const bridge: AdminNativeBridge = {
    isNative,
    authReady: isNative ? consumeNativeCredential(auth) : Promise.resolve(),
    deepLink: (path) => {
      const normalizedPath = normalizeAdminPath(path)
      if (normalizedPath) {
        window.history.pushState({}, '', `/admin${normalizedPath}`)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }
    },
    requestNativeSignOut: () => {
      try {
        window.webkit?.messageHandlers?.adminBridge?.postMessage({ type: 'signOut' })
      } catch (error) {
        console.warn('[native-bridge] native sign-out failed', error)
      }
    },
  }

  window.__adminNativeBridge = bridge
  return bridge
}

export async function signOutAdmin(auth: Auth): Promise<void> {
  window.__adminNativeBridge?.requestNativeSignOut()
  await signOut(auth)
}

async function consumeNativeCredential(auth: Auth): Promise<void> {
  const shell = window.__adminNativeShell
  if (!shell?.googleIDToken || auth.currentUser) return

  try {
    const credential = GoogleAuthProvider.credential(
      shell.googleIDToken,
      shell.googleAccessToken,
    )
    await signInWithCredential(auth, credential)
  } catch (error) {
    console.error('[native-bridge] Firebase credential exchange failed', error)
    shell.postMessage?.({ type: 'authFailed' })
  }
}
