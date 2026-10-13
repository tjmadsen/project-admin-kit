// Screenshot harness: renders the real admin pages inside the real Layout with
// fixture data instead of Firestore (see vite.config.ts for the module swaps).
// Query parameters: route=/features  item=FR-25  theme=light|dark|system  role=admin|creator
import React from 'react'
import ReactDOM from 'react-dom/client'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { User } from 'firebase/auth'
import Layout from '../src/components/Layout'
import { DetailBackProvider } from '../src/components/DetailBackContext'
import Dashboard from '../src/pages/Dashboard'
import WorkItems from '../src/pages/WorkItems'
import AgentLoops from '../src/pages/AgentLoops'
import Activity from '../src/pages/Activity'
import Operations from '../src/pages/Operations'
import { WORK_KINDS, workKindPath } from '../src/lib/work-kinds'
import '../src/index.css'

const params = new URLSearchParams(window.location.search)
const route = params.get('route') || '/'
const theme = params.get('theme')
const role = params.get('role') === 'collaborator' ? 'collaborator' : 'admin'

if (theme) {
  // Match what index.html's boot script and lib/theme.ts do for a stored
  // preference, so the stylesheet and the sidebar toggle agree.
  try { window.localStorage.setItem('project-admin-theme', theme) } catch { /* storage optional */ }
  document.documentElement.setAttribute('data-theme', theme)
}

const user = {
  uid: 'screenshot-user',
  email: role === 'admin' ? 'owner@example.com' : 'collaborator@example.com',
  displayName: role === 'admin' ? 'Project owner' : 'Collaborator User',
  photoURL: null,
  emailVerified: true,
} as unknown as User
const actorName = role === 'admin' ? 'Project owner' : 'Collaborator User'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={[route]}>
      <DetailBackProvider>
        <Layout user={user} role={role}>
          <Routes>
            <Route path="/" element={role === 'admin' ? <Dashboard /> : <Navigate to="/features" replace />} />
            {WORK_KINDS.map((kind) => <Route key={kind.id} path={workKindPath(kind)} element={<WorkItems key={kind.id} kind={kind.id} canManage={role === 'admin'} actorEmail={user.email || ''} actorName={actorName} />} />)}
            <Route path="/loops" element={<AgentLoops canManage={role === 'admin'} />} />
            <Route path="/activity" element={<Activity readOnly={role !== 'admin'} />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </DetailBackProvider>
    </MemoryRouter>
  </React.StrictMode>,
)
