import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { BACKEND, signOut, type SessionUser } from '../data'
import { detectSidebarSwipe, resolveEdgeSwipeAction } from '../lib/edge-swipe'
import type { AccessRole } from '../lib/auth'
import { THEME_LABELS, THEME_PREFERENCES, readTheme, writeTheme, type ThemePreference } from '../lib/theme'
import { useDetailBack } from './DetailBackContext'
import ProjectMark from './ProjectMark'
import { projectConfig } from '../lib/project-config'
import { WORK_KINDS, workKindPath } from '../lib/work-kinds'

// One navigation entry per configured work kind, in config order.
const workKindNav = WORK_KINDS.map((kind) => ({ to: workKindPath(kind), label: kind.pluralLabel, icon: kind.icon }))

const nav = [
  { to: '/', label: 'Dashboard', icon: 'grid' },
  ...workKindNav,
  { to: '/loops', label: 'Agent Loops', icon: 'loop' },
  { to: '/activity', label: 'Activity', icon: 'pulse' },
  { to: '/users', label: 'Users', icon: 'users' },
  { to: '/operations', label: 'Operations', icon: 'terminal' },
]

const icons: Record<string, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  spark: <path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z"/>,
  bug: <><path d="M8 9h8v7a4 4 0 0 1-8 0V9Z"/><path d="M10 9V7a2 2 0 0 1 4 0v2M4 13h4m8 0h4M5 18l3-1m8 0 3 1"/></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>,
  loop: <><path d="M20 7h-9a5 5 0 0 0-5 5v1"/><path d="m17 4 3 3-3 3M4 17h9a5 5 0 0 0 5-5v-1"/><path d="m7 20-3-3 3-3"/></>,
  pulse: <path d="M3 12h4l2-7 4 14 2-7h6"/>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
  terminal: <><path d="m5 7 4 4-4 4M11 17h7"/><rect x="2" y="3" width="20" height="18" rx="3"/></>,
}

const themeIcons: Record<ThemePreference, ReactNode> = {
  system: <><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></>,
  light: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/></>,
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>,
}

export default function Layout({ user, role, children }: { user: SessionUser; role: AccessRole; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<ThemePreference>(() => readTheme())
  const location = useLocation()
  const { isDetailOpen, goBack } = useDetailBack()
  const collaboratorDestinations = new Set([...workKindNav.map((item) => item.to), '/loops', '/activity'])
  const visibleNav = role === 'admin' ? nav : nav.filter((item) => collaboratorDestinations.has(item.to))
  const fallbackInitials = (user.displayName || user.email || projectConfig.project.shortName).split(/[\s@]+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')
  const productionHost = (() => { try { return new URL(projectConfig.project.productionUrl).host } catch { return projectConfig.project.productionUrl } })()

  useEffect(() => { setOpen(false) }, [location.pathname])

  const chooseTheme = (preference: ThemePreference) => {
    writeTheme(preference)
    setTheme(preference)
  }

  useEffect(() => {
    let startX = 0
    let startY = 0
    let tracking = false
    const gestureBlocked = () => Boolean(document.querySelector('[aria-modal="true"], .image-lightbox'))
    const onStart = (event: TouchEvent) => {
      const phoneViewport = typeof window.matchMedia !== 'function' || window.matchMedia('(max-width: 760px), (max-width: 950px) and (max-height: 500px)').matches
      if (!phoneViewport || gestureBlocked() || event.touches.length !== 1) {
        tracking = false
        return
      }
      tracking = true
      startX = event.touches[0].clientX
      startY = event.touches[0].clientY
    }
    const onEnd = (event: TouchEvent) => {
      if (!tracking) return
      tracking = false
      if (gestureBlocked()) return
      const touch = event.changedTouches[0]
      if (!touch) return
      const result = detectSidebarSwipe({ startX, startY, endX: touch.clientX, endY: touch.clientY }, open)
      const action = resolveEdgeSwipeAction(result, isDetailOpen())
      if (action === 'back') goBack()
      else if (action === 'open') setOpen(true)
      else if (action === 'close') setOpen(false)
    }
    const cancel = () => { tracking = false }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', cancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', cancel)
    }
  }, [goBack, isDetailOpen, open])

  return (
    <div className="app-shell">
      {open && <button aria-label="Close navigation" className="nav-scrim" onClick={() => setOpen(false)} />}
      <aside id="admin-navigation" className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <ProjectMark />
          <div><strong>{projectConfig.project.shortName}</strong><span>{role === 'admin' ? 'Admin' : 'Collaborator'}</span></div>
        </div>
        <nav aria-label="Main navigation">
          {visibleNav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={() => setOpen(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">{icons[item.icon]}</svg>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-status"><i /><span>{role === 'admin' ? 'Production' : 'Collaborator access'}</span><small>{role === 'admin' ? productionHost : [...WORK_KINDS.map((kind) => kind.shortLabel), 'Loops', 'Activity'].join(' · ')}</small></div>
        <div className="account">
          {user.photoURL ? <img src={user.photoURL} alt="" /> : <div className="avatar">{fallbackInitials}</div>}
          <div><strong>{user.displayName || user.email?.split('@')[0] || 'Collaborator'}</strong><span>{user.email}</span></div>
          {BACKEND !== 'local' && <button title="Sign out" aria-label="Sign out" onClick={() => void signOut()}>↗</button>}
          <div className="theme-toggle" role="radiogroup" aria-label="Appearance">
            {THEME_PREFERENCES.map((preference) => (
              <button key={preference} type="button" role="radio" aria-checked={theme === preference} className={theme === preference ? 'active' : ''} onClick={() => chooseTheme(preference)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">{themeIcons[preference]}</svg>
                <span>{THEME_LABELS[preference]}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="mobile-header">
          <button aria-label="Open navigation" aria-controls="admin-navigation" aria-expanded={open} onClick={() => setOpen(true)}>☰</button>
          <span>{projectConfig.project.shortName} {role === 'admin' ? 'Admin' : 'Collaborator'}</span>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  )
}
