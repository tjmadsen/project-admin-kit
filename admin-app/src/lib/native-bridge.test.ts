import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auth } from 'firebase/auth'

const firebaseMocks = vi.hoisted(() => ({
  credential: vi.fn(() => ({ providerId: 'google.com' })),
  signInWithCredential: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
}))

vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: { credential: firebaseMocks.credential },
  signInWithCredential: firebaseMocks.signInWithCredential,
  signOut: firebaseMocks.signOut,
}))

import {
  detectNativeShell,
  initNativeBridge,
  normalizeAdminPath,
  signOutAdmin,
} from './native-bridge'

const auth = { currentUser: null } as unknown as Auth

afterEach(() => {
  delete window.__adminNativeShell
  delete window.__adminNativeBridge
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
  firebaseMocks.credential.mockClear()
  firebaseMocks.signInWithCredential.mockClear()
  firebaseMocks.signOut.mockClear()
})

describe('native admin bridge', () => {
  it('detects the injected native shell', () => {
    window.__adminNativeShell = {
      googleIDToken: 'id-token',
      googleAccessToken: 'access-token',
    }
    expect(detectNativeShell()).toBe(true)
  })

  it('exchanges native Google tokens before authReady resolves', async () => {
    window.__adminNativeShell = {
      googleIDToken: 'id-token',
      googleAccessToken: 'access-token',
    }

    const bridge = initNativeBridge(auth)
    await bridge.authReady

    expect(firebaseMocks.credential).toHaveBeenCalledWith('id-token', 'access-token')
    expect(firebaseMocks.signInWithCredential).toHaveBeenCalledWith(
      auth,
      { providerId: 'google.com' },
    )
  })

  it('routes only internal admin paths', () => {
    const bridge = initNativeBridge(auth)
    bridge.deepLink('/features')
    expect(window.location.pathname).toBe('/admin/features')

    bridge.deepLink('https://example.com')
    expect(window.location.pathname).toBe('/admin/features')
    expect(normalizeAdminPath('//example.com')).toBeNull()
  })

  it('returns control to native sign-in when credential exchange fails', async () => {
    const postMessage = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    firebaseMocks.signInWithCredential.mockRejectedValueOnce(new Error('network unavailable'))
    window.__adminNativeShell = {
      googleIDToken: 'id-token',
      googleAccessToken: 'access-token',
      postMessage,
    }

    await initNativeBridge(auth).authReady

    expect(postMessage).toHaveBeenCalledWith({ type: 'authFailed' })
    expect(consoleError).toHaveBeenCalled()
  })

  it('signs out both the native shell and web Firebase session', async () => {
    const postMessage = vi.fn()
    window.__adminNativeShell = {
      googleIDToken: 'id-token',
      googleAccessToken: 'access-token',
    }
    window.webkit = { messageHandlers: { adminBridge: { postMessage } } }
    initNativeBridge(auth)

    await signOutAdmin(auth)

    expect(postMessage).toHaveBeenCalledWith({ type: 'signOut' })
    expect(firebaseMocks.signOut).toHaveBeenCalledWith(auth)
  })
})
