import { useMemo, useState } from 'react'
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import { useCollection } from '../hooks/useCollection'
import { db } from '../lib/firebase'
import { normalizeEmail } from '../lib/auth'
import { formatRelative } from '../lib/format'
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENT_TYPES,
  resolveNotificationPreferences,
  summarizeNotificationPreferences,
  withNotificationPreference,
} from '../lib/notificationPreferences'
import type { AdminUser, NotificationChannel, NotificationEventType } from '../lib/types'

export default function Users({ currentEmail }: { currentEmail: string }) {
  const users = useCollection<AdminUser>('adminUsers', 500)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<AdminUser['role']>('collaborator')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [expandedUser, setExpandedUser] = useState('')
  const normalizedCurrentEmail = normalizeEmail(currentEmail)
  const sorted = useMemo(() => [...users.data].sort((a, b) => a.email.localeCompare(b.email)), [users.data])

  const save = async () => {
    const normalized = normalizeEmail(email)
    if (!/^\S+@\S+\.\S+$/.test(normalized)) {
      setError('Enter a valid email address.')
      return
    }
    setBusy(normalized)
    setError('')
    try {
      await setDoc(doc(db, 'adminUsers', normalized), {
        email: normalized,
        displayName: displayName.trim() || normalized.split('@')[0],
        role,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: normalizedCurrentEmail,
      }, { merge: true })
      setEmail('')
      setDisplayName('')
      setRole('collaborator')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this user.')
    } finally {
      setBusy('')
    }
  }

  const patchUser = async (user: AdminUser, values: Partial<AdminUser>) => {
    if (user.email === normalizedCurrentEmail && (values.active === false || values.role === 'collaborator')) {
      setError('You cannot revoke or demote your own active admin account.')
      return
    }
    setBusy(user.id)
    setError('')
    try {
      await updateDoc(doc(db, 'adminUsers', user.id), { ...values, updatedAt: serverTimestamp() })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this user.')
    } finally {
      setBusy('')
    }
  }

  // Writes the full resolved map so every event/channel key is an explicit
  // boolean the lifecycle Functions and security rules can validate.
  const toggleNotification = async (user: AdminUser, channel: NotificationChannel, type: NotificationEventType, enabled: boolean) => {
    setBusy(user.id)
    setError('')
    try {
      await updateDoc(doc(db, 'adminUsers', user.id), {
        notifications: withNotificationPreference(user.notifications, channel, type, enabled),
        updatedAt: serverTimestamp(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update notification preferences.')
    } finally {
      setBusy('')
    }
  }

  const removeUser = async (user: AdminUser) => {
    if (user.email === normalizedCurrentEmail) {
      setError('You cannot remove your own active admin account.')
      return
    }
    if (!window.confirm(`Remove access for ${user.email}?`)) return
    setBusy(user.id)
    setError('')
    try {
      await deleteDoc(doc(db, 'adminUsers', user.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove this user.')
    } finally {
      setBusy('')
    }
  }

  return <>
    <PageHeader eyebrow="Access control" title="Users" description="Grant, change, suspend, or revoke access without rebuilding the console." />
    {(error || users.error) && <div className="error-banner" role="alert">{error || users.error}</div>}
    <section className="users-layout">
      <div className="panel users-panel">
        <div className="panel-heading"><div><p className="eyebrow">Authorized people</p><h2>Admin access</h2></div><small>{sorted.filter((user) => user.active).length} active</small></div>
        {users.loading ? <div className="loading-line">Loading users…</div> : sorted.length === 0 ? <EmptyState title="No users configured" copy="Bootstrap the first owner from the CLI, then manage everyone here." /> : <div className="user-list">
          {sorted.map((user) => <article key={user.id} className={!user.active ? 'inactive' : ''}>
            <div className="user-avatar">{(user.displayName || user.email).slice(0, 2).toUpperCase()}</div>
            <div className="user-identity"><strong>{user.displayName || user.email}</strong><span>{user.email}</span><small>Updated {formatRelative(user.updatedAt)}</small></div>
            <label>Role<select aria-label={`Role for ${user.email}`} value={user.role} disabled={busy === user.id || user.email === normalizedCurrentEmail} onChange={(event) => void patchUser(user, { role: event.target.value as AdminUser['role'] })}><option value="admin">Admin</option><option value="collaborator">Collaborator</option></select></label>
            <button className="button secondary" disabled={busy === user.id || user.email === normalizedCurrentEmail} onClick={() => void patchUser(user, { active: !user.active })}>{user.active ? 'Suspend' : 'Activate'}</button>
            <button className="button secondary user-notifications-toggle" aria-expanded={expandedUser === user.id} aria-controls={`notifications-${user.id}`} aria-label={`Notifications for ${user.email}`} onClick={() => setExpandedUser(expandedUser === user.id ? '' : user.id)}>Notifications</button>
            <button className="icon-danger" aria-label={`Remove ${user.email}`} disabled={busy === user.id || user.email === normalizedCurrentEmail} onClick={() => void removeUser(user)}>×</button>
            {expandedUser === user.id && <div className="user-notifications" id={`notifications-${user.id}`}>
              <div className="user-notifications-head"><strong>Lifecycle notifications</strong><small>{summarizeNotificationPreferences(user.notifications)}</small></div>
              <table className="user-notifications-grid">
                <thead><tr><th scope="col"><span className="visually-hidden">Channel</span></th>{NOTIFICATION_EVENT_TYPES.map((type) => <th key={type} scope="col">{NOTIFICATION_EVENT_LABELS[type]}</th>)}</tr></thead>
                <tbody>
                  {NOTIFICATION_CHANNELS.map((channel) => {
                    const resolved = resolveNotificationPreferences(user.notifications)[channel]
                    return <tr key={channel}>
                      <th scope="row">{NOTIFICATION_CHANNEL_LABELS[channel]}</th>
                      {NOTIFICATION_EVENT_TYPES.map((type) => <td key={type}>
                        <input type="checkbox" aria-label={`${NOTIFICATION_CHANNEL_LABELS[channel]} ${NOTIFICATION_EVENT_LABELS[type]} for ${user.email}`} checked={resolved[type]} disabled={busy === user.id} onChange={(event) => void toggleNotification(user, channel, type, event.target.checked)} />
                      </td>)}
                    </tr>
                  })}
                </tbody>
              </table>
              <small>Email for a gate repeats at most once per 24 hours per item; deploy progress stays in the thread and push. Push always fires when enabled.</small>
            </div>}
          </article>)}
        </div>}
      </div>
      <aside className="panel user-create-panel">
        <p className="eyebrow">Add access</p><h2>Authorize a user</h2><p>They can sign in with this verified Google email immediately after you save it.</p>
        <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex Smith" /></label>
        <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="alex@example.com" /></label>
        <label>Role<select value={role} onChange={(event) => setRole(event.target.value as AdminUser['role'])}><option value="collaborator">Collaborator</option><option value="admin">Admin</option></select></label>
        <button className="button primary" disabled={Boolean(busy) || !email.trim()} onClick={() => void save()}>{busy && busy === normalizeEmail(email) ? 'Saving…' : 'Add user'}</button>
        <small>Admins control users, routing, approvals, and releases. Collaborators can submit, discuss, and monitor work.</small>
      </aside>
    </section>
  </>
}
