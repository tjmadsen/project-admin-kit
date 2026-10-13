import { useState } from 'react'
import { signIn } from '../data'
import ProjectMark from '../components/ProjectMark'
import { projectConfig } from '../lib/project-config'

export default function Login() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      await signIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.')
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="field-lines" aria-hidden="true" />
      <main className="auth-card">
        <ProjectMark className="auth-logo" />
        <p className="eyebrow">Operations console</p>
        <h1>{projectConfig.project.name}<br />Admin</h1>
        <p className="auth-copy">Feature work, bug triage, and autonomous agent loops—one quiet place to run the app.</p>
        <button className="google-button" onClick={signIn} disabled={busy}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A10.9 10.9 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
          </svg>
          {busy ? 'Signing in…' : 'Continue with Google'}
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="auth-footnote">Restricted to verified, authorized collaborators.</p>
      </main>
    </div>
  )
}
