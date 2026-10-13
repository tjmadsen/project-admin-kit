import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { onAuthChanged, signOut, subscribeAccessRole, type SessionUser } from './data'
import type { AccessRole } from './lib/auth'
import Login from './pages/Login'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import WorkItems from './pages/WorkItems'
import AgentLoops from './pages/AgentLoops'
import Activity from './pages/Activity'
import Operations from './pages/Operations'
import Users from './pages/Users'
import { DetailBackProvider } from './components/DetailBackContext'
import { projectConfig } from './lib/project-config'
import { WORK_KINDS, workKindPath } from './lib/work-kinds'

export default function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined)
  const [role, setRole] = useState<AccessRole | null | undefined>(undefined)
  const [accessError, setAccessError] = useState('')

  useEffect(() => onAuthChanged((nextUser) => {
    setUser(nextUser)
  }), [])

  useEffect(() => {
    setRole(undefined)
    setAccessError('')
    if (!user) {
      if (user === null) setRole(null)
      return
    }
    return subscribeAccessRole(user, (nextRole, error) => {
      setRole(nextRole)
      setAccessError(error?.message || '')
    })
  }, [user])

  if (user === undefined || role === undefined) return <div className="boot-screen"><div className="spinner" /><p>Opening the control room…</p></div>
  if (!user) return <Login />
  if (!role) {
    return (
      <div className="auth-screen">
        <div className="auth-card denied-card">
          <div className="auth-mark">!</div>
          <p className="eyebrow">Access denied</p>
          <h1>This console is private.</h1>
          <p><strong>{user.email}</strong> is signed in, but is not an active {projectConfig.project.name} collaborator.</p>
          {accessError && <p className="form-error">{accessError}</p>}
          <button className="button secondary wide" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    )
  }

  // Collaborators land on the first configured work kind.
  const collaboratorHome = workKindPath(WORK_KINDS[0])
  const actorName = user.displayName?.trim()
    || (user.email?.toLowerCase() === projectConfig.admin.ownerEmail.toLowerCase()
      ? projectConfig.admin.ownerName
      : projectConfig.admin.defaultCollaboratorName)

  return (
    <DetailBackProvider>
      <Layout user={user} role={role}>
        <Routes>
          <Route path="/" element={role === 'admin' ? <Dashboard /> : <Navigate to={collaboratorHome} replace />} />
          {WORK_KINDS.map((kind) => <Route key={kind.id} path={workKindPath(kind)} element={<WorkItems key={kind.id} kind={kind.id} canManage={role === 'admin'} actorEmail={user.email || ''} actorName={actorName} />} />)}
          <Route path="/loops" element={<AgentLoops canManage={role === 'admin'} />} />
          <Route path="/activity" element={<Activity readOnly={role !== 'admin'} />} />
          <Route path="/users" element={role === 'admin' ? <Users currentEmail={user.email || ''} /> : <Navigate to={collaboratorHome} replace />} />
          <Route path="/operations" element={role === 'admin' ? <Operations /> : <Navigate to={collaboratorHome} replace />} />
          <Route path="*" element={<Navigate to={role === 'admin' ? '/' : collaboratorHome} replace />} />
        </Routes>
      </Layout>
    </DetailBackProvider>
  )
}
