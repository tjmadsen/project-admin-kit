import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Timestamp, arrayUnion, collection, doc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore'
import EmptyState from '../components/EmptyState'
import ActiveAgentBadge from '../components/ActiveAgentBadge'
import { useRegisterDetailBack } from '../components/DetailBackContext'
import { AttachmentGallery, AttachmentPicker } from '../components/ImageAttachments'
import LinkifiedText from '../components/LinkifiedText'
import Markdown from '../components/Markdown'
import PageHeader from '../components/PageHeader'
import WorkItemDependencies, { blockingDependencies, dependencyWaitLabel } from '../components/WorkItemDependencies'
import { useCollection } from '../hooks/useCollection'
import { useLoopRuns } from '../hooks/useLoopData'
import { AGENT_MODELS, DEFAULT_WORK_AGENT, agentByOwner, agentByToken, thinkingEffortsFor } from '../lib/agents'
import { attachmentFilesFromDataTransfer, mergeAttachmentFiles, uploadWorkAttachments, type UploadedAttachments } from '../lib/attachments'
import { DEPLOYMENT_TARGETS, deploymentTargetsFor, legacyDeploymentType, normalizeDeploymentTargets } from '../lib/deployment'
import { db } from '../lib/firebase'
import { adminWorkItemPath, deploymentLabel, formatRelative, gateLabel, itemRef, matchesItemReference, ownerLabel, toDate, waitingLabel } from '../lib/format'
import { readPreference, writePreference } from '../lib/preferences'
import { preferencePrefix, projectConfig } from '../lib/project-config'
import type { Owner, Priority, ReviewGate, ThinkingEffort, WorkItem, WorkKind, WorkMessage } from '../lib/types'

const terminal: Record<WorkKind, string[]> = { feature: ['shipped', 'declined'], bug: ['closed', 'wont_fix'] }
const collections: Record<WorkKind, string> = { feature: 'featureRequests', bug: 'bugs' }
const priorityRank: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 }
type SortKey = 'priority' | 'updated' | 'created' | 'number'
const sortKeys: SortKey[] = ['priority', 'updated', 'created', 'number']
const PHONE_DETAIL_QUERY = '(max-width: 760px), (max-width: 950px) and (max-height: 500px)'

function isDesktopWorkList() {
  return window.matchMedia('(min-width: 1181px)').matches
}

// The thread scrolls inside .detail-scroll on desktop and on phones, but between
// 761px and 1180px that container is overflow:visible and the page scrolls
// instead. Measure whichever surface actually moves rather than the desktop
// breakpoint, so a reader scrolled up in a phone container is never yanked down.
export function threadNearBottom(container: HTMLElement | null, margin = 120) {
  if (container && container.scrollHeight - container.clientHeight > 1) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < margin
  }
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < margin
}

export function syncPhoneDetailHeight(appShell: HTMLElement, thread: HTMLElement | null, targetWindow: Window = window) {
  const media = targetWindow.matchMedia(PHONE_DETAIL_QUERY)
  const visualViewport = targetWindow.visualViewport
  const previousHeight = appShell.style.getPropertyValue('--app-height')
  let frame: number | null = null

  const update = () => {
    frame = null
    if (!media.matches) {
      appShell.style.removeProperty('--app-height')
      return
    }
    const previousScrollTop = thread?.scrollTop || 0
    const wasNearBottom = Boolean(thread && threadNearBottom(thread))
    const viewportHeight = Math.round(visualViewport?.height || targetWindow.innerHeight)
    if (viewportHeight > 0) appShell.style.setProperty('--app-height', `${viewportHeight}px`)
    // iOS scrolls the page to reveal the focused note box when the keyboard
    // opens. html/body never scroll, so the offset would strand the shell above
    // the viewport (blank screen) and outlive the keyboard as a bottom gap.
    if (targetWindow.scrollY > 0 || (visualViewport?.offsetTop || 0) > 0) targetWindow.scrollTo(0, 0)
    if (thread) {
      thread.scrollTop = wasNearBottom
        ? Math.max(0, thread.scrollHeight - thread.clientHeight)
        : previousScrollTop
    }
  }
  const schedule = () => {
    if (frame !== null) targetWindow.cancelAnimationFrame(frame)
    frame = targetWindow.requestAnimationFrame(update)
  }
  const listenToMedia = media.addEventListener
    ? () => media.addEventListener('change', schedule)
    : () => media.addListener(schedule)
  const stopListeningToMedia = media.removeEventListener
    ? () => media.removeEventListener('change', schedule)
    : () => media.removeListener(schedule)

  visualViewport?.addEventListener('resize', schedule)
  visualViewport?.addEventListener('scroll', schedule)
  targetWindow.addEventListener('scroll', schedule)
  targetWindow.addEventListener('resize', schedule)
  targetWindow.addEventListener('orientationchange', schedule)
  listenToMedia()
  schedule()

  return () => {
    if (frame !== null) targetWindow.cancelAnimationFrame(frame)
    visualViewport?.removeEventListener('resize', schedule)
    visualViewport?.removeEventListener('scroll', schedule)
    targetWindow.removeEventListener('scroll', schedule)
    targetWindow.removeEventListener('resize', schedule)
    targetWindow.removeEventListener('orientationchange', schedule)
    stopListeningToMedia()
    if (previousHeight) appShell.style.setProperty('--app-height', previousHeight)
    else appShell.style.removeProperty('--app-height')
  }
}

// The phone note box starts at one line and grows with its text until the CSS
// max-height, then scrolls inside the box.
export function fitNoteToText(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  const style = getComputedStyle(textarea)
  const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
  textarea.style.height = `${textarea.scrollHeight + borders}px`
}

function usePhoneDetailLayout() {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(PHONE_DETAIL_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(PHONE_DETAIL_QUERY)
    const update = () => setIsPhone(media.matches)
    if (media.addEventListener) media.addEventListener('change', update)
    else media.addListener(update)
    update()
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', update)
      else media.removeListener(update)
    }
  }, [])
  return isPhone
}

function initialSortPreference(kind: WorkKind): { key: SortKey; direction: 'asc' | 'desc' } {
  const savedKey = readPreference(`${preferencePrefix}:${kind}:sort`, '') as SortKey | ''
  const savedDirection = readPreference(`${preferencePrefix}:${kind}:direction`, '')
  const wasOldDefault = (!savedKey || savedKey === 'priority') && (!savedDirection || savedDirection === 'asc')
  if (wasOldDefault) return { key: 'updated', direction: 'desc' }
  return {
    key: savedKey && sortKeys.includes(savedKey) ? savedKey : 'updated',
    direction: savedDirection === 'asc' ? 'asc' : 'desc',
  }
}

export function effectiveGate(item: WorkItem): ReviewGate | undefined {
  if (item.waitingOn !== 'human') return undefined
  if (item.blockedReason) return item.blockedReason
  if (!item.assignedTo) return 'triage'
  if (item.status === 'plan_review') return 'plan_review'
  if (item.status === 'in_review' && item.prUrl) return 'pr_review'
  if (item.status === 'ready_for_deploy') return 'deploy_approval'
  if (item.status === 'blocked') return 'question'
  return 'triage'
}

export const APPROVAL_NOTE = '✅ Approved — please continue.'
export const QUICK_REPLIES = ['Approved, continue', 'Needs changes:', 'Ship it', 'More detail please']
const ONE_TAP_APPROVAL_GATES: ReviewGate[] = ['plan_review', 'pr_review', 'question']

// Deploy approval and acceptance keep their evidence-gated buttons. Only the gates
// that just need Project owner's go-ahead get the one-tap approval, and only once an agent
// owns the item, so the approval always has somewhere to return to.
export function canApproveAndReturn(item: WorkItem) {
  const gate = effectiveGate(item)
  return item.waitingOn === 'human' && Boolean(item.assignedTo) && Boolean(gate && ONE_TAP_APPROVAL_GATES.includes(gate))
}

export function quickReplyDraft(reply: string) {
  return reply.endsWith(':') ? `${reply} ` : reply
}

export function stripMarkdown(value: string) {
  return value
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])([*_])([^*_\n]+)\2(?=$|[\s).,!?:;])/g, '$1$3')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function messageRole(author: string): 'agent' | 'human' {
  return /^(Codex|Claude|Grok)\b/i.test(author.trim()) ? 'agent' : 'human'
}

export function deploymentSummary(item: Pick<WorkItem, 'deploymentTargets' | 'deploymentType' | 'deploymentApprovedTargets'>, approved = false) {
  const targets = deploymentTargetsFor(item, approved)
  if (targets.length > 0) return targets.map(deploymentLabel).join(' + ')
  return item.deploymentType === 'mixed' ? 'Targets need itemizing' : 'Not selected'
}

export function deploymentNotesReady(notes?: string) {
  const value = notes?.trim() || ''
  return value.length >= 80 && ['Scope', 'Commands', 'Verification', 'Acceptance'].every((section) => new RegExp(`(^|\\n)${section}:\\s*\\S`, 'i').test(value))
}

export function deploymentApprovalIssue(item: Pick<WorkItem, 'prNumber' | 'prUrl' | 'branchName' | 'deploymentNotes' | 'deploymentNotesPrNumber' | 'deploymentNotesPrUrl' | 'deploymentNotesBranchName'>, notes?: string) {
  if (!deploymentNotesReady(notes)) return 'Complete the Scope, Commands, Verification, and Acceptance sections in deploy notes.'
  const value = notes?.trim() || ''
  const notedPrs = [...value.matchAll(/\bPR\s*#\s*(\d+)\b/gi)].map((match) => Number(match[1]))
  const mismatchedPr = item.prNumber && notedPrs.find((number) => number !== item.prNumber)
  if (mismatchedPr) return `Deploy notes name PR #${mismatchedPr}, but the linked pull request is PR #${item.prNumber}. Refresh the deploy notes.`
  if (item.deploymentNotes === notes) {
    if (item.deploymentNotesPrNumber && item.prNumber && item.deploymentNotesPrNumber !== item.prNumber) {
      return `Deploy notes were written for PR #${item.deploymentNotesPrNumber}, but the linked pull request is PR #${item.prNumber}. Refresh the deploy notes.`
    }
    if (item.deploymentNotesPrUrl && item.prUrl && item.deploymentNotesPrUrl !== item.prUrl) {
      return 'The linked pull-request URL changed after these deploy notes were written. Refresh the deploy notes.'
    }
    if (item.deploymentNotesBranchName && item.branchName && item.deploymentNotesBranchName !== item.branchName) {
      return 'The linked branch changed after these deploy notes were written. Refresh the deploy notes.'
    }
  }
  return undefined
}

export type CloseWithoutDeploymentMode = 'hidden' | 'direct' | 'confirm'

export function closeWithoutDeploymentMode(item: Pick<WorkItem, 'kind' | 'status' | 'waitingOn' | 'deploymentTargets' | 'deploymentType' | 'deploymentApprovedTargets' | 'deploymentApprovedAt' | 'deploymentInProgressTarget'>): CloseWithoutDeploymentMode {
  if (terminal[item.kind].includes(item.status)) return 'hidden'
  const approved = item.deploymentApprovedAt ? deploymentTargetsFor(item, true).filter((target) => target !== 'none') : []
  const planned = deploymentTargetsFor(item).filter((target) => target !== 'none')
  const releasePending = approved.length > 0 || planned.length > 0 || item.waitingOn === 'deployer' || Boolean(item.deploymentInProgressTarget)
  return releasePending ? 'confirm' : 'direct'
}

function authorMark(author: string, role: 'agent' | 'human') {
  if (role === 'agent') return 'AI'
  const words = author.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || 'A'
}

function messageFingerprint(entry: WorkMessage) {
  const normalizedBody = entry.body.replace(/testflight-[^\s/]+-\d{10,12}\.log/gi, 'testflight-[build].log')
  return `${entry.author.trim().toLowerCase()}\n${normalizedBody}`
}

export function groupThreadMessages(messages: WorkMessage[]) {
  return messages.reduce<Array<{ entry: WorkMessage; count: number }>>((groups, entry) => {
    const previous = groups.at(-1)
    if (previous && messageFingerprint(previous.entry) === messageFingerprint(entry)) {
      previous.entry = entry
      previous.count += 1
    } else groups.push({ entry, count: 1 })
    return groups
  }, [])
}

export function lastMessagePreview(item: Pick<WorkItem, 'description' | 'messages'>, maxLength = 140) {
  const latest = groupThreadMessages(item.messages || []).at(-1)?.entry
  const body = stripMarkdown(latest?.body || '')
  const value = body && latest ? `${latest.author}: ${body}` : stripMarkdown(item.description)
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export function unreadMessageCount(messageCount: number, seenCount?: number) {
  return Math.max(0, messageCount - Math.max(0, seenCount || 0))
}

export function parseSeenCounts(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0)) as Record<string, number>
  } catch { return {} }
}

function timestampValue(value: unknown) { return toDate(value)?.getTime() ?? 0 }
function isLeaseOpen(item: WorkItem) { return !item.claimedBy || timestampValue(item.leaseExpiresAt) <= Date.now() }

function sortWorkItems(items: WorkItem[], sortKey: SortKey, direction: 'asc' | 'desc') {
  const sign = direction === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    if (sortKey === 'priority') return ((priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2)) * sign || (timestampValue(a.createdAt) - timestampValue(b.createdAt))
    if (sortKey === 'number') return (a.number - b.number) * sign
    return (timestampValue(sortKey === 'created' ? a.createdAt : a.updatedAt) - timestampValue(sortKey === 'created' ? b.createdAt : b.updatedAt)) * sign
  })
}

export { matchesItemReference }

export function matchesFilter(item: WorkItem, value: string) {
  return value === 'all' || item.waitingOn === value
}

function locationItemReference() {
  return new URLSearchParams(window.location.search).get('item')
}

function replaceLocationItem(reference: string | null) {
  const url = new URL(window.location.href)
  if (reference) url.searchParams.set('item', reference)
  else url.searchParams.delete('item')
  url.searchParams.delete('gate')
  window.history.replaceState(window.history.state, '', url)
}

export default function WorkItems({ kind, canManage, actorEmail, actorName = canManage ? projectConfig.admin.ownerName : projectConfig.admin.defaultCollaboratorName }: { kind: WorkKind; canManage: boolean; actorEmail: string; actorName?: string }) {
  const primaryCollection = useCollection<WorkItem>(collections[kind])
  const relatedCollection = useCollection<WorkItem>(collections[kind === 'feature' ? 'bug' : 'feature'])
  const { data } = primaryCollection
  const { runs } = useLoopRuns(150)
  const loading = primaryCollection.loading || relatedCollection.loading
  const error = primaryCollection.error || relatedCollection.error
  const allItems = useMemo(() => [...new Map([...relatedCollection.data, ...data].map((item) => [item.id, item])).values()], [data, relatedCollection.data])
  const initialSort = initialSortPreference(kind)
  const [queryText, setQueryText] = useState('')
  const [filter, setFilter] = useState('human')
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [sortKey, setSortKey] = useState<SortKey>(() => initialSort.key)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => initialSort.direction)
  const [autoAdvance, setAutoAdvance] = useState(() => readPreference(`${preferencePrefix}:${kind}:auto-advance`, 'true') !== 'false')
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [seenCounts, setSeenCounts] = useState<Record<string, number>>(() => parseSeenCounts(readPreference(`${preferencePrefix}:${kind}:seen`, '{}')))
  const [selectedUnreadCount, setSelectedUnreadCount] = useState(0)
  const [requestedItem, setRequestedItem] = useState<string | null>(() => locationItemReference())
  const [toast, setToast] = useState<string | null>(null)
  const [returningToList, setReturningToList] = useState(false)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const savedListScrollTop = useRef(0)
  const toastTimer = useRef<number | null>(null)
  const returnAnimationTimer = useRef<number | null>(null)
  const suppressDesktopAutoSelect = useRef(false)
  const label = kind === 'feature' ? 'Feature Requests' : 'Bugs'
  const filtered = useMemo(() => sortWorkItems(data.filter((item) => {
    const matchesText = `${item.title} ${item.description} ${item.number}`.toLowerCase().includes(queryText.toLowerCase())
    return matchesText && matchesFilter(item, filter) && (ownerFilter === 'all' || item.assignedTo === ownerFilter)
  }), sortKey, sortDirection), [data, filter, kind, ownerFilter, queryText, sortDirection, sortKey])
  const selected = data.find((item) => item.id === selectedId) ?? null
  const filterValues = ['human', 'agent', 'deployer', 'hold', 'all']
  const filterCounts = useMemo(() => Object.fromEntries(filterValues.map((value) => [value, data.filter((item) => matchesFilter(item, value)).length])), [data, kind])
  const upNext = useMemo(() => {
    const eligible = sortWorkItems(data.filter((item) => item.waitingOn === 'agent' && !terminal[kind].includes(item.status) && isLeaseOpen(item) && blockingDependencies(item, allItems).length === 0), 'priority', 'asc')
    return AGENT_MODELS.map((agent) => ({
      agent,
      items: eligible.filter((item) => item.assignedTo === agent.owner || (agent.claimsUnassigned && !item.assignedTo)).slice(0, 3),
    })).filter((lane) => lane.items.length > 0)
  }, [allItems, data, kind])

  const openItem = useCallback((item: WorkItem) => {
    const messageCount = item.messages?.length || 0
    setSelectedUnreadCount(unreadMessageCount(messageCount, seenCounts[item.id]))
    if (seenCounts[item.id] !== messageCount) {
      const next = { ...seenCounts, [item.id]: messageCount }
      writePreference(`${preferencePrefix}:${kind}:seen`, JSON.stringify(next))
      setSeenCounts(next)
    }
    const reference = itemRef(item.kind, item.number)
    setSelectedId(item.id)
    setRequestedItem(reference)
    replaceLocationItem(reference)
  }, [kind, seenCounts])

  useEffect(() => {
    const syncLocation = () => setRequestedItem(locationItemReference())
    window.addEventListener('popstate', syncLocation)
    return () => window.removeEventListener('popstate', syncLocation)
  }, [])

  useEffect(() => {
    const requested = data.find((item) => matchesItemReference(item, requestedItem))
    if (requested) {
      if (selectedId !== requested.id) openItem(requested)
      return
    }
    if (!selectedId && filtered.length > 0 && isDesktopWorkList() && !suppressDesktopAutoSelect.current) openItem(filtered[0])
  }, [data, filtered, openItem, requestedItem, selectedId])

  useEffect(() => { writePreference(`${preferencePrefix}:${kind}:sort`, sortKey) }, [kind, sortKey])
  useEffect(() => { writePreference(`${preferencePrefix}:${kind}:direction`, sortDirection) }, [kind, sortDirection])
  useEffect(() => { writePreference(`${preferencePrefix}:${kind}:auto-advance`, String(autoAdvance)) }, [autoAdvance, kind])
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    if (returnAnimationTimer.current !== null) window.clearTimeout(returnAnimationTimer.current)
  }, [])

  const selectItem = (item: WorkItem) => {
    if (!isDesktopWorkList()) savedListScrollTop.current = listScrollRef.current?.scrollTop ?? 0
    suppressDesktopAutoSelect.current = false
    if (item.kind !== kind) {
      window.location.assign(adminWorkItemPath(item))
      return
    }
    openItem(item)
  }
  const clearSelection = (suppressAutoSelect = false) => {
    suppressDesktopAutoSelect.current = suppressAutoSelect
    setSelectedId(null)
    setRequestedItem(null)
    replaceLocationItem(null)
  }
  const returnToList = () => {
    const mobile = !isDesktopWorkList()
    if (mobile) setReturningToList(true)
    clearSelection(true)
    if (!mobile) return
    window.requestAnimationFrame(() => {
      if (listScrollRef.current) listScrollRef.current.scrollTop = savedListScrollTop.current
    })
    if (returnAnimationTimer.current !== null) window.clearTimeout(returnAnimationTimer.current)
    returnAnimationTimer.current = window.setTimeout(() => setReturningToList(false), 220)
  }
  const showCompletionToast = (message: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = window.setTimeout(() => setToast(null), 2000)
  }
  const focusListItem = (id: string) => {
    window.requestAnimationFrame(() => {
      const row = listScrollRef.current?.querySelector<HTMLElement>(`[data-work-item-id="${id}"]`)
      row?.focus({ preventScroll: true })
      row?.scrollIntoView?.({ block: 'nearest' })
    })
  }
  const handleDone = (changes: Record<string, unknown>, confirmation: string) => {
    if (!selected) return
    const postPatchItem = { ...selected, ...changes } as WorkItem
    if (matchesFilter(postPatchItem, filter)) {
      showCompletionToast(`${confirmation} → back to list`)
      return
    }
    if (!isDesktopWorkList()) {
      returnToList()
      return
    }
    const selectedIndex = filtered.findIndex((item) => item.id === selected.id)
    const nextItem = filtered[selectedIndex + 1] || filtered.find((item) => item.id !== selected.id)
    clearSelection(true)
    if (!autoAdvance || !nextItem) return
    const reference = itemRef(nextItem.kind, nextItem.number)
    suppressDesktopAutoSelect.current = false
    setSelectedId(nextItem.id)
    setRequestedItem(reference)
    replaceLocationItem(reference)
    focusListItem(nextItem.id)
  }
  useRegisterDetailBack(Boolean(selected), returnToList)

  return <div className={`work-page ${selected ? 'has-selection' : ''}`}>
    <PageHeader eyebrow={kind === 'feature' ? 'Product backlog' : 'Triage queue'} title={label} description={canManage ? (kind === 'feature' ? 'Shape, assign, and ship the next useful improvements.' : 'Capture defects, approve repair plans, and follow fixes to production.') : (kind === 'feature' ? 'Submit ideas and follow their progress.' : 'Report defects and follow their progress.')} action={<button className="button primary" onClick={() => setCreating(true)}>＋ New {kind === 'feature' ? 'request' : 'bug'}</button>} />
    {error && <div className="error-banner">{error}</div>}
    <div className={`work-split ${selected ? 'has-selection' : ''} ${returningToList ? 'returning-to-list' : ''}`}>
      <section className="panel work-list-pane">
        <div className="work-list-tools">
          <label className="search-box"><span>⌕</span><input aria-label={`Search ${label}`} placeholder={`Search ${label.toLowerCase()}…`} value={queryText} onChange={(event) => setQueryText(event.target.value)} /></label>
          <div className="waiting-filter"><span>Waiting on</span><div className="filter-group">{filterValues.map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}><span>{value === 'deployer' ? 'Deploy' : value[0].toUpperCase() + value.slice(1)}</span><b>{filterCounts[value]}</b></button>)}</div></div>
          <div className="list-options">
            <label>Owner<select aria-label="Filter by owner" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value="all">All models</option>{AGENT_MODELS.map((agent) => <option key={agent.owner} value={agent.owner}>{agent.label}</option>)}<option value="">Unassigned</option></select></label>
            <label>Sort<select aria-label="Sort items" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}><option value="priority">Priority</option><option value="updated">Updated</option><option value="created">Created</option><option value="number">Number</option></select></label>
            <button type="button" aria-label="Reverse sort" title="Reverse sort" onClick={() => setSortDirection((value) => value === 'asc' ? 'desc' : 'asc')}>{sortDirection === 'asc' ? '↑' : '↓'}</button>
            {canManage && <label className="auto-advance-option"><input type="checkbox" checked={autoAdvance} onChange={(event) => setAutoAdvance(event.target.checked)} /><span>Auto-advance after hand-back</span></label>}
          </div>
          {upNext.length > 0 && <div className="up-next-queue"><span className="up-next-label">Up next</span>{upNext.map(({ agent, items }) => <span className="up-next-lane" key={agent.owner}><b>{agent.emoji} {agent.short}</b>{items.map((item) => <button type="button" key={item.id} title={item.title} onClick={() => selectItem(item)}>{itemRef(kind, item.number)}</button>)}</span>)}</div>}
        </div>
        <div className="work-list-scroll" ref={listScrollRef}>
          {loading ? <div className="table-loading"><div className="spinner" /> Loading {label.toLowerCase()}…</div> : filtered.length === 0 ? <EmptyState title={`No ${filter} ${label.toLowerCase()}`} copy="Try another filter or add the first item." /> : filtered.map((item) => { const unread = unreadMessageCount(item.messages?.length || 0, seenCounts[item.id]); return <div role="button" tabIndex={0} className={`work-list-card ${selectedId === item.id ? 'selected' : ''}`} data-work-item-id={item.id} key={item.id} onClick={() => selectItem(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectItem(item) } }}>
            <span className={`priority-rail ${item.priority}`} />
            <span className="work-card-top"><small>{itemRef(kind, item.number)}</small><ActiveAgentBadge itemRef={itemRef(kind, item.number)} runs={runs} /><b className={`priority-chip ${item.priority}`}>{item.priority}</b>{effectiveGate(item) && <b className={`gate-chip ${effectiveGate(item)}`}>{gateLabel(effectiveGate(item))}</b>}<time>{formatRelative(item.updatedAt)}</time></span>
            <strong>{unread > 0 && <i className="unread-dot" aria-label="Unread messages" />}{item.title}</strong><em>{lastMessagePreview(item)}</em>
            {dependencyWaitLabel(item, allItems) && <span className="dependency-wait">{dependencyWaitLabel(item, allItems)}</span>}
            <span className="work-card-meta"><span>{ownerLabel(item.assignedTo)}</span><b className={`queue-pill ${item.waitingOn}`}>{waitingLabel(item.waitingOn)}</b>{item.prNumber && item.prUrl ? <a className="pr-pill" href={item.prUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>PR #{item.prNumber}</a> : item.prNumber ? <span>PR #{item.prNumber}</span> : null}{deploymentTargetsFor(item).filter((target) => target !== 'none').length > 0 && <span>{deploymentSummary(item)}</span>}<span>{groupThreadMessages(item.messages || []).length} events</span>{unread > 0 && <b className="new-message-count">+{unread} new</b>}{item.imageUrls?.length ? <span>{item.imageUrls.length} attachments</span> : null}</span>
          </div>})}
        </div>
      </section>
      <section className="panel work-detail-pane">{selected ? <ItemDetail key={selected.id} item={selected} allItems={allItems} runs={runs} unreadAtOpen={selectedUnreadCount} canManage={canManage} actorEmail={actorEmail} actorName={actorName} onBack={returnToList} onDone={handleDone} onSelectItem={selectItem} /> : <EmptyState title={`Select a ${kind === 'feature' ? 'feature request' : 'bug'}`} copy={canManage ? 'Its full history, routing, delivery fields, and actions will stay visible here.' : 'Its full history and AI conversation will stay visible here.'} />}</section>
    </div>
    {toast && <div className="work-completion-toast" role="status"><span>{toast}</span><button type="button" onClick={() => setToast(null)}>Stay</button></div>}
    {creating && <NewItem kind={kind} canManage={canManage} actorEmail={actorEmail} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelectedId(id); setRequestedItem(id); replaceLocationItem(id) }} />}
  </div>
}

function NewItem({ kind, canManage, actorEmail, onClose, onCreated }: { kind: WorkKind; canManage: boolean; actorEmail: string; onClose: () => void; onCreated: (id: string) => void }) {
  const defaultOwner = agentByToken(DEFAULT_WORK_AGENT)?.owner || 'sol-agent'
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [routeNow, setRouteNow] = useState(false)
  const [owner, setOwner] = useState<Owner>(defaultOwner)
  const [effort, setEffort] = useState<ThinkingEffort>('xhigh')
  const [attachments, setAttachments] = useState<File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [draftId] = useState(() => doc(collectionRef(kind)).id)
  const hasUnsavedChanges = title !== '' || description !== '' || priority !== 'medium' || routeNow || owner !== defaultOwner || effort !== 'xhigh' || attachments.length > 0
  const requestClose = () => {
    if (saving) return
    if (!hasUnsavedChanges || window.confirm('Discard this draft? Your changes will be lost.')) onClose()
  }
  const addAttachments = (incoming: File[]) => setAttachments((current) => {
    const merged = mergeAttachmentFiles(current, incoming)
    setAttachmentError(merged.error)
    return merged.files
  })
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = attachmentFilesFromDataTransfer(event.clipboardData?.items)
    if (pasted.length) { event.preventDefault(); addAttachments(pasted) }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true); setError('')
    let uploaded: UploadedAttachments | undefined
    try {
      uploaded = await uploadWorkAttachments(attachments, kind, draftId, actorEmail)
      const itemDoc = doc(db, collections[kind], draftId)
      await runTransaction(db, async (transaction) => {
        const counterRef = doc(db, 'system', 'counters')
        const counter = await transaction.get(counterRef)
        const field = kind === 'feature' ? 'nextFeatureNumber' : 'nextBugNumber'
        const number = Number(counter.data()?.[field] ?? 0) + 1
        transaction.set(counterRef, { [field]: number, updatedAt: serverTimestamp() }, { merge: true })
        transaction.set(itemDoc, {
          kind, number, title: title.trim(), description: description.trim(), imageUrls: uploaded?.urls || [], priority,
          status: kind === 'feature' ? 'backlog' : 'open', waitingOn: canManage && routeNow ? 'agent' : 'human', blockedReason: canManage && routeNow ? null : 'triage', assignedTo: owner,
          thinkingEffort: effort, targetMachine: projectConfig.automation.defaultMachineId, deploymentType: 'none', deploymentTargets: [], messages: [],
          createdByEmail: actorEmail.toLowerCase(), createdByRole: canManage ? 'admin' : 'collaborator', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        })
      })
      onCreated(draftId)
    } catch (err) {
      await uploaded?.cleanup()
      setError(err instanceof Error ? err.message : 'Could not create item.')
      setSaving(false)
    }
  }

  return <Modal title={`New ${kind === 'feature' ? 'feature request' : 'bug'}`} onClose={requestClose}>
    <form className="form-stack" onSubmit={submit}>
      <label>Title<input required autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Description<textarea required rows={6} value={description} onPaste={handlePaste} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the goal or problem. You can paste supported attachments here." /></label>
      <AttachmentPicker files={attachments} disabled={saving} onAdd={addAttachments} onRemove={(index) => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))} />
      {attachmentError && <p className="form-error">{attachmentError}</p>}
      <label>Priority<select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{['critical', 'high', 'medium', 'low'].map((value) => <option key={value}>{value}</option>)}</select></label>
      {canManage ? <>
        <details className="advanced-disclosure">
          <summary>Route now <span>Optional</span></summary>
          <label className="check-field"><input type="checkbox" checked={routeNow} onChange={(event) => setRouteNow(event.target.checked)} /><span><strong>Send directly to an agent</strong><small>Otherwise this starts in your review queue.</small></span></label>
          {routeNow && <div className="form-grid"><label>Agent model<OwnerSelect value={owner} onChange={setOwner} /></label><label>Thinking effort<select value={effort} onChange={(event) => setEffort(event.target.value as ThinkingEffort)}>{thinkingEffortsFor(owner, effort).map((value) => <option key={value}>{value}</option>)}</select></label></div>}
        </details>
      </> : <p className="creator-form-note">Your submission defaults to {agentByToken(DEFAULT_WORK_AGENT)?.label || DEFAULT_WORK_AGENT} at xhigh and will be marked for {projectConfig.admin.ownerName} to review. After work starts, you can continue the conversation and attach more files.</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={requestClose} disabled={saving}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Uploading & creating…' : canManage ? (routeNow ? 'Create & queue' : 'Create for review') : 'Submit for review'}</button></div>
    </form>
  </Modal>
}

function useSyncedDraft<T>(storedValue: T) {
  const [draft, setDraft] = useState(storedValue)
  const previousStoredValue = useRef(storedValue)

  useEffect(() => {
    const previous = previousStoredValue.current
    previousStoredValue.current = storedValue
    setDraft((current) => Object.is(current, previous) ? storedValue : current)
  }, [storedValue])

  return [draft, setDraft] as const
}

function ItemDetail({ item, allItems, runs, unreadAtOpen, canManage, actorEmail, actorName, onBack, onDone, onSelectItem }: { item: WorkItem; allItems: WorkItem[]; runs: import('../lib/types').AgentLoopRun[]; unreadAtOpen: number; canManage: boolean; actorEmail: string; actorName: string; onBack: () => void; onDone: (changes: Record<string, unknown>, confirmation: string) => void; onSelectItem: (item: WorkItem) => void }) {
  const [message, setMessage] = useState('')
  const [previewingMessage, setPreviewingMessage] = useState(false)
  const [attachments, setAttachments] = useState<File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [prUrl, setPrUrl] = useSyncedDraft(item.prUrl || '')
  const [branchName, setBranchName] = useSyncedDraft(item.branchName || '')
  const [deploymentNotes, setDeploymentNotes] = useSyncedDraft(item.deploymentNotes || '')
  const [closing, setClosing] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const detailShellRef = useRef<HTMLDivElement>(null)
  const detailScrollRef = useRef<HTMLDivElement>(null)
  const deliveryCardRef = useRef<HTMLDetailsElement>(null)
  const replyToolsRef = useRef<HTMLDetailsElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const previousItemIdRef = useRef(item.id)
  const previousMessageCountRef = useRef(groupThreadMessages(item.messages || []).length)
  const wasNearBottomRef = useRef(true)
  const isPhoneLayout = usePhoneDetailLayout()
  const itemDoc = doc(db, collections[item.kind], item.id)
  const isTerminal = terminal[item.kind].includes(item.status)
  // FR-20's tokenizer runs on the text nodes Markdown exposes, so FR-N/BUG-N
  // references and bare URLs stay navigable inside rendered bodies.
  const renderMarkdownText = useCallback((text: string) => <LinkifiedText text={text} items={allItems} onSelectItem={onSelectItem} />, [allItems, onSelectItem])
  const baseStatus = item.kind === 'feature' ? 'backlog' : 'open'
  const addAttachments = (incoming: File[]) => setAttachments((current) => {
    const merged = mergeAttachmentFiles(current, incoming)
    setAttachmentError(merged.error)
    return merged.files
  })
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = attachmentFilesFromDataTransfer(event.clipboardData?.items)
    if (pasted.length) { event.preventDefault(); addAttachments(pasted) }
  }
  const patch = async (data: Record<string, unknown>) => {
    setBusy(true); setError('')
    try { await updateDoc(itemDoc, { ...data, updatedAt: serverTimestamp() }); return true }
    catch (err) { setError(err instanceof Error ? err.message : 'Update failed.'); return false }
    finally { setBusy(false) }
  }
  const patchAndFinish = async (data: Record<string, unknown>, confirmation: string) => {
    const succeeded = await patch(data)
    if (succeeded) onDone(data, confirmation)
    return succeeded
  }
  const sentToAgentLabel = `Sent to ${agentByOwner(item.assignedTo)?.short || ownerLabel(item.assignedTo)}`
  const addMessage = async (returnToAgent = false) => {
    if (!message.trim() && attachments.length === 0) return
    setBusy(true); setError('')
    let uploaded: UploadedAttachments | undefined
    try {
      uploaded = await uploadWorkAttachments(attachments, item.kind, item.id, actorEmail)
      const changes: Record<string, unknown> = { messages: arrayUnion({ author: actorName, authorEmail: actorEmail.toLowerCase(), body: message.trim(), imageUrls: uploaded.urls, createdAt: Timestamp.now() }), updatedAt: serverTimestamp() }
      if (returnToAgent) Object.assign(changes, { waitingOn: 'agent', status: 'in_progress', blockedReason: null, leaseExpiresAt: null, claimedBy: null })
      await updateDoc(itemDoc, changes)
      setMessage(''); setAttachments([]); setAttachmentError('')
      if (returnToAgent) onDone(changes, sentToAgentLabel)
    } catch (err) {
      await uploaded?.cleanup()
      setError(err instanceof Error ? err.message : 'Could not add the note.')
    } finally { setBusy(false) }
  }
  const saveText = (field: string, value: string, original?: string) => { if (value !== (original || '')) void patch({ [field]: value.trim() }) }
  const saveDeploymentNotes = () => {
    if (deploymentNotes === (item.deploymentNotes || '')) return
    void patch({
      deploymentNotes: deploymentNotes.trim(),
      deploymentNotesPrNumber: item.prNumber || null,
      deploymentNotesPrUrl: prUrl.trim(),
      deploymentNotesBranchName: branchName.trim(),
    })
  }
  const sendToAgent = () => {
    const changes = { waitingOn: 'agent', status: 'in_progress', blockedReason: null, leaseExpiresAt: null, claimedBy: null }
    return patchAndFinish(changes, sentToAgentLabel)
  }
  // One updateDoc so the approval note and the routing land together: without the
  // note the thread carries no record of the decision the agent is resuming from.
  const approveAndReturn = () => {
    const changes = {
      messages: arrayUnion({ author: actorName, authorEmail: actorEmail.toLowerCase(), body: APPROVAL_NOTE, imageUrls: [], createdAt: Timestamp.now() }),
      waitingOn: 'agent', status: 'in_progress', blockedReason: null, leaseExpiresAt: null, claimedBy: null,
    }
    return patchAndFinish(changes, sentToAgentLabel)
  }
  const moveToReview = () => patch({ waitingOn: 'human', status: 'in_review', blockedReason: item.prUrl ? 'pr_review' : 'question', leaseExpiresAt: null, claimedBy: null })
  const plannedDeploymentTargets = deploymentTargetsFor(item)
  const deploymentNotesIssue = deploymentApprovalIssue({ ...item, prUrl: prUrl.trim(), branchName: branchName.trim() }, deploymentNotes)
  const deployApprovalReady = plannedDeploymentTargets.length > 0 && !deploymentNotesIssue
  const deployApprovalHint = plannedDeploymentTargets.length === 0
    ? 'Select at least one explicit deployment target.'
    : deploymentNotesIssue
  const deployHandoffHintId = `deployment-handoff-hint-${item.id}`
  const deployPreparationLabel = plannedDeploymentTargets.length === 0
    ? '⚙ Select deployment target'
    : deploymentNotesIssue?.startsWith('Complete the ')
      ? '⚙ Complete deploy notes'
      : '⚙ Refresh deploy notes'
  const prepareDeployment = () => {
    setError('')
    const deliveryCard = deliveryCardRef.current
    if (!deliveryCard) return
    if (replyToolsRef.current) replyToolsRef.current.open = false
    deliveryCard.open = true
    window.requestAnimationFrame(() => {
      deliveryCard.scrollIntoView({ block: 'start', behavior: 'smooth' })
      const missingField = plannedDeploymentTargets.length === 0
        ? deliveryCard.querySelector<HTMLInputElement>('.deployment-target-picker input')
        : deliveryCard.querySelector<HTMLTextAreaElement>('textarea[aria-label="Deploy notes"]')
      missingField?.focus({ preventScroll: true })
    })
  }
  const sendToDeploy = async () => {
    if (!deployApprovalReady) { setError(deployApprovalHint || 'Complete the deployment handoff first.'); return false }
    const changes = {
      waitingOn: 'deployer', status: 'ready_for_deploy', blockedReason: null,
      deploymentTargets: plannedDeploymentTargets, deploymentType: legacyDeploymentType(plannedDeploymentTargets), deploymentNotes: deploymentNotes.trim(),
      deploymentNotesPrNumber: item.prNumber || null, deploymentNotesPrUrl: prUrl.trim(), deploymentNotesBranchName: branchName.trim(),
      deploymentApprovedTargets: plannedDeploymentTargets, deploymentApprovedNotes: deploymentNotes.trim(),
      deploymentApprovedAt: serverTimestamp(), deploymentApprovedBy: actorEmail.toLowerCase(),
      deploymentEvidence: {}, deploymentResult: '', deploymentVerifiedAt: null,
      leaseExpiresAt: null, claimedBy: null,
    }
    return patchAndFinish(changes, 'Sent to deploy')
  }
  const updateDeploymentTargets = (targets: string[]) => patch({
    deploymentTargets: targets, deploymentType: legacyDeploymentType(targets),
    deploymentApprovedAt: null, deploymentApprovedBy: null, deploymentApprovedTargets: [], deploymentApprovedNotes: '',
    deploymentEvidence: {}, deploymentResult: '', deploymentVerifiedAt: null,
  })
  const acceptanceTargets = deploymentTargetsFor(item, true)
  const acceptanceReady = acceptanceTargets.length > 0 && acceptanceTargets.every((target) => {
    const evidence = item.deploymentEvidence?.[target]
    return Boolean(evidence?.proof && evidence?.acceptance) || (target === 'testflight' && Boolean(item.deploymentBuild && item.deploymentResult))
  })
  const finish = () => {
    if (!acceptanceReady) { setError('Every approved deployment target needs verification evidence before acceptance.'); return false }
    const changes = item.kind === 'feature'
      ? { status: 'shipped', waitingOn: 'done', blockedReason: null, shippedAt: serverTimestamp(), deploymentAcceptedAt: serverTimestamp(), resolution: `Accepted by ${projectConfig.admin.ownerName} after deployment verification.`, leaseExpiresAt: null, claimedBy: null }
      : { status: 'closed', waitingOn: 'done', blockedReason: null, resolvedAt: serverTimestamp(), deploymentAcceptedAt: serverTimestamp(), resolution: `Accepted by ${projectConfig.admin.ownerName} after deployment verification.`, leaseExpiresAt: null, claimedBy: null }
    return patchAndFinish(changes, item.kind === 'feature' ? 'Marked shipped' : 'Resolved')
  }
  const decline = () => patchAndFinish({ status: item.kind === 'feature' ? 'declined' : 'wont_fix', waitingOn: 'done', blockedReason: null, leaseExpiresAt: null, claimedBy: null }, item.kind === 'feature' ? 'Declined' : "Won't fix")
  const closeMode = closeWithoutDeploymentMode(item)
  const closeWithoutDeployment = async () => {
    const note = closeNote.trim()
    if (!note) { setError('Add a short resolution note first.'); return false }
    const changes = {
      ...(item.kind === 'feature' ? { status: 'shipped', shippedAt: serverTimestamp() } : { status: 'closed', resolvedAt: serverTimestamp() }),
      waitingOn: 'done', blockedReason: null, resolution: note, leaseExpiresAt: null, claimedBy: null,
      messages: arrayUnion({ author: actorName, authorEmail: actorEmail.toLowerCase(), body: `Closed without deployment: ${note}`, imageUrls: [], createdAt: Timestamp.now() }),
    }
    const done = await patchAndFinish(changes, item.kind === 'feature' ? 'Marked shipped' : 'Closed')
    if (done) { setClosing(false); setCloseNote('') }
    return done
  }
  const reopen = () => patch(item.kind === 'feature' ? { status: baseStatus, waitingOn: 'human', blockedReason: 'triage', shippedAt: null, leaseExpiresAt: null, claimedBy: null } : { status: baseStatus, waitingOn: 'human', blockedReason: 'triage', resolvedAt: null, leaseExpiresAt: null, claimedBy: null })
  const resume = () => item.assignedTo ? sendToAgent() : patch({ status: baseStatus, waitingOn: 'human', blockedReason: 'triage', leaseExpiresAt: null, claimedBy: null })
  const copyReference = async () => {
    try { await navigator.clipboard.writeText(`${itemRef(item.kind, item.number)} — ${item.title}`); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }
    catch { setError('Could not copy the reference.') }
  }

  const gate = effectiveGate(item)
  const groupedMessages = groupThreadMessages(item.messages || [])

  useEffect(() => {
    const container = detailScrollRef.current
    const updateNearBottom = () => {
      wasNearBottomRef.current = threadNearBottom(container)
    }
    container?.addEventListener('scroll', updateNearBottom)
    window.addEventListener('scroll', updateNearBottom)
    return () => {
      container?.removeEventListener('scroll', updateNearBottom)
      window.removeEventListener('scroll', updateNearBottom)
    }
  }, [item.id])

  useEffect(() => {
    const appShell = detailShellRef.current?.closest<HTMLElement>('.app-shell')
    if (!appShell) return
    return syncPhoneDetailHeight(appShell, detailScrollRef.current)
  }, [item.id])

  useLayoutEffect(() => {
    const note = noteRef.current
    if (!note) return
    if (isPhoneLayout) fitNoteToText(note)
    else note.style.removeProperty('height')
  }, [message, isPhoneLayout, previewingMessage])

  useEffect(() => {
    previousItemIdRef.current = item.id
    previousMessageCountRef.current = groupedMessages.length
    wasNearBottomRef.current = true
    const end = threadEndRef.current
    if (end && typeof end.scrollIntoView === 'function') end.scrollIntoView({ block: 'end' })
  }, [item.id])

  useEffect(() => {
    const itemChanged = previousItemIdRef.current !== item.id
    const messageAppended = groupedMessages.length > previousMessageCountRef.current
    if (!itemChanged && messageAppended && wasNearBottomRef.current) {
      const end = threadEndRef.current
      if (end && typeof end.scrollIntoView === 'function') end.scrollIntoView({ block: 'end', behavior: 'smooth' })
    }
    previousItemIdRef.current = item.id
    previousMessageCountRef.current = groupedMessages.length
  }, [groupedMessages.length, item.id])

  const firstUnseenIndex = Math.max(0, (item.messages?.length || 0) - unreadAtOpen)
  const deliverySummary = item.prNumber ? `PR #${item.prNumber}` : item.prUrl ? 'PR linked' : 'No PR yet'
  const collaboratorCanReturn = !canManage && gate !== 'triage' && gate !== 'deploy_approval' && gate !== 'acceptance_review' && item.status !== 'ready_for_deploy'
  const canReturnToAgent = item.waitingOn === 'human' && Boolean(item.assignedTo) && (canManage || collaboratorCanReturn)
  const showApprove = canManage && canApproveAndReturn(item)
  const composerReady = Boolean(message.trim()) || attachments.length > 0
  const approveButton = (className: string) => <button type="button" className={className} disabled={busy} onClick={() => void approveAndReturn()}>✓ Approve → return to agent</button>
  const deployActionButton = (readyLabel: string) => deployApprovalReady
    ? <button type="button" className="action deploy-action" disabled={busy} onClick={() => void sendToDeploy()}>{readyLabel}</button>
    : <button type="button" className="action warning-action deploy-preparation-action" disabled={busy} aria-describedby={deployHandoffHintId} title={deployApprovalHint} onClick={prepareDeployment}>{deployPreparationLabel}</button>
  const sendOnShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    if (busy || !composerReady) return
    void addMessage(canReturnToAgent)
  }
  const humanAction = gate === 'deploy_approval'
    ? deployActionButton(`🚀 Approve ${deploymentSummary(item)} → deploy`)
    : gate === 'acceptance_review'
      ? <button type="button" className="action success-action" disabled={busy || !acceptanceReady} title={!acceptanceReady ? 'Waiting for verification evidence from every approved target' : undefined} onClick={() => void finish()}>✓ Accept & {item.kind === 'feature' ? 'mark shipped' : 'resolve'}</button>
      : showApprove
        ? approveButton('action primary-action')
        : <button type="button" className="action primary-action" disabled={busy || !item.assignedTo} title={!item.assignedTo ? 'Select an agent model first' : undefined} onClick={() => void sendToAgent()}>{gate === 'plan_review' ? '✓ Approve plan' : gate === 'pr_review' ? '✓ Approve PR' : gate === 'question' ? '↩ Return with answer' : '✓ Route'} → {ownerLabel(item.assignedTo)}</button>

  const primaryAction = isTerminal
    ? <button type="button" className="action primary-action" disabled={busy} onClick={() => void reopen()}>↻ Reopen</button>
    : item.waitingOn === 'human'
      ? humanAction
      : item.waitingOn === 'agent'
        ? <button type="button" className="action primary-action" disabled={busy} onClick={() => void moveToReview()}>✓ Move to owner review</button>
        : item.waitingOn === 'deployer'
          ? item.deploymentApprovedAt
            ? <button type="button" className="action success-action" disabled>✓ Approved · waiting for deploy loop</button>
            : deployActionButton(`⚠ Confirm ${deploymentSummary(item)} approval`)
          : item.waitingOn === 'hold'
            ? <button type="button" className="action primary-action" disabled={busy} onClick={() => void resume()}>▶ Resume</button>
            : <button type="button" className="action primary-action" disabled={busy || !item.assignedTo} onClick={() => void sendToAgent()}>▶ Send to agent</button>

  const deployIsPrimary = gate === 'deploy_approval' || item.waitingOn === 'deployer'
  const returnToAgentHint = item.assignedTo ? 'Return this item to the assigned agent for another implementation pass.' : 'Select an agent model first.'
  const actionBar = canManage ? <>
    {primaryAction}
    {!isTerminal && !deployIsPrimary && deployActionButton('🚀 Approve & send to deploy')}
    {!isTerminal && gate === 'acceptance_review' && <button type="button" className="action warning-action" disabled={busy || !item.assignedTo} title={returnToAgentHint} onClick={() => void sendToAgent()}>↩ Request changes</button>}
    {!isTerminal && item.waitingOn !== 'hold' && <button type="button" className="action hold-action" disabled={busy} title="Pause agent and deployment work for this item." onClick={() => void patchAndFinish({ waitingOn: 'hold', leaseExpiresAt: null, claimedBy: null }, 'Put on hold')}>⏸ Hold</button>}
    {!isTerminal && <button type="button" className="action danger-action" disabled={busy} title={item.kind === 'feature' ? 'Decline this feature request.' : 'Close this bug as won\'t fix.'} onClick={() => void decline()}>{item.kind === 'feature' ? 'Decline' : "Won't fix"}</button>}
    <details className="action-menu"><summary className="action quiet-action" role="button">Utilities ▾</summary><div>
      <button type="button" disabled={busy} onClick={() => void copyReference()}>{copied ? '✓ Copied' : '⧉ Copy reference'}</button>
      {!isTerminal && closeMode !== 'hidden' && <button type="button" disabled={busy} onClick={() => setClosing(true)}>✓ Mark done (no deployment)</button>}
    </div></details>
  </> : null

  const bottomRoutingControls = canManage && !isTerminal ? <div className="detail-action-routing" aria-label="Quick routing controls">
    <label>Priority<select aria-label="Bottom action priority" value={item.priority} disabled={busy} onChange={(event) => void patch({ priority: event.target.value })}>{['critical', 'high', 'medium', 'low'].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>Effort<select aria-label="Bottom action effort" value={item.thinkingEffort || 'xhigh'} disabled={busy} onChange={(event) => void patch({ thinkingEffort: event.target.value })}>{thinkingEffortsFor(item.assignedTo, item.thinkingEffort).map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>Machine<select aria-label="Bottom action machine" value={item.targetMachine || projectConfig.automation.defaultMachineId} disabled={busy} onChange={(event) => void patch({ targetMachine: event.target.value })}>{![projectConfig.automation.defaultMachineId, 'any'].includes(item.targetMachine) && <option value={item.targetMachine}>{item.targetMachine}</option>}<option value={projectConfig.automation.defaultMachineId}>{projectConfig.automation.defaultMachineLabel}</option><option value="any">Any machine</option></select></label>
  </div> : null

  return <div className="detail-shell" ref={detailShellRef}>
    <div className="detail-scroll" ref={detailScrollRef}>
      <header className="detail-header">
      <button className="detail-back" onClick={onBack}>← Back to list</button>
      <div className="detail-title-row"><div><span>{itemRef(item.kind, item.number)}{item.createdByEmail ? ` · Submitted by ${item.createdByEmail}` : ''}</span><h2>{item.title}</h2></div><div className="detail-badges"><ActiveAgentBadge itemRef={itemRef(item.kind, item.number)} runs={runs} /><b className={`priority-chip ${item.priority}`}>{item.priority}</b>{gate && <b className={`gate-chip ${gate}`}>{gateLabel(gate)}</b>}<b className={`queue-pill ${item.waitingOn}`}>{waitingLabel(item.waitingOn)}</b>{item.prNumber && item.prUrl && <a className="pr-pill" href={item.prUrl} target="_blank" rel="noreferrer">PR #{item.prNumber}</a>}</div></div>
      {canManage && <div className="action-bar detail-actions-top">{actionBar}</div>}
      {error && <div className="detail-error">{error}</div>}
      </header>

      <div className="detail-body">
        {!canManage && <div className="creator-readonly-note"><strong>Collaborator</strong><span>You can add notes and return replies to the AI. Administrators control models, lifecycle approvals, closing, and every deployment.</span></div>}
        <Markdown className="description" source={item.description} renderText={renderMarkdownText} />
        <AttachmentGallery urls={item.imageUrls} label={`${itemRef(item.kind, item.number)} attachment`} />

      <section className="routing-card">
        <div><p className="eyebrow">Workflow</p><h3>State and routing</h3></div>
        <div className="routing-grid">
          <ReadonlyField label="Status" value={item.status.replaceAll('_', ' ')} />
          <ReadonlyField label="Waiting on" value={waitingLabel(item.waitingOn)} />
          <ReadonlyField label="Review gate" value={gate ? gateLabel(gate) : 'None'} />
          <label>Priority<select aria-label="Priority" value={item.priority} disabled={busy} onChange={(event) => void patch({ priority: event.target.value })}>{['critical', 'high', 'medium', 'low'].map((value) => <option key={value}>{value}</option>)}</select></label>
          {canManage ? <>
            <label>Agent model<OwnerSelect value={item.assignedTo || ''} onChange={(value) => void patch({ assignedTo: value, claimedBy: null, leaseExpiresAt: null })} /></label>
            <label>Thinking effort<select aria-label="Thinking effort" value={item.thinkingEffort || 'xhigh'} disabled={busy} onChange={(event) => void patch({ thinkingEffort: event.target.value })}>{thinkingEffortsFor(item.assignedTo, item.thinkingEffort).map((value) => <option key={value}>{value}</option>)}</select></label>
          </> : <>
            <ReadonlyField label="Agent model" value={ownerLabel(item.assignedTo)} />
            <ReadonlyField label="Thinking effort" value={item.thinkingEffort || 'xhigh'} />
          </>}
        </div>
      </section>

      <WorkItemDependencies item={item} allItems={allItems} canManage={canManage} disabled={busy} onChange={(dependsOn) => void patch({ dependsOn })} onSelectItem={onSelectItem} />

      <details className="delivery-card" ref={deliveryCardRef} open><summary role="button"><span><span className="eyebrow">Delivery</span><strong>PR and deploy handoff</strong></span><small>{deliverySummary} · {deploymentSummary(item)}</small></summary><div className="delivery-grid">
        {canManage ? <>
          <label>PR URL<input aria-label="PR URL" placeholder="https://github.com/…" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} onBlur={() => saveText('prUrl', prUrl, item.prUrl)} /></label>
          <label>Branch<input aria-label="Branch" placeholder="agent/fr-N" value={branchName} onChange={(event) => setBranchName(event.target.value)} onBlur={() => saveText('branchName', branchName, item.branchName)} /></label>
          <DeploymentTargetPicker value={plannedDeploymentTargets} disabled={busy || item.waitingOn === 'deployer'} onChange={(targets) => void updateDeploymentTargets(targets)} />
          <label className="wide-field">Deploy notes<textarea aria-label="Deploy notes" rows={6} placeholder={'Scope: What must be released and why\nCommands: Exact release commands/order\nVerification: Target-specific checks and URLs\nAcceptance: Observable FR/bug behavior that must work'} value={deploymentNotes} onChange={(event) => setDeploymentNotes(event.target.value)} onBlur={saveDeploymentNotes} /></label>
          {deployApprovalHint && <p className="deployment-handoff-hint wide-field" id={deployHandoffHintId}>{deployApprovalHint}</p>}
        </> : <>
          <ReadonlyField label="PR URL" value={item.prUrl || 'Not linked'} /><ReadonlyField label="Branch" value={item.branchName || 'Not assigned'} /><ReadonlyField label="Deployment" value={deploymentSummary(item)} />
          {item.deploymentNotes && <div className="wide-field"><ReadonlyField label="Deploy notes" value={item.deploymentNotes} markdown /></div>}
        </>}
        {plannedDeploymentTargets.length > 0 && <div className="deployment-checklist wide-field"><span>Verification evidence</span>{plannedDeploymentTargets.map((target) => {
          const evidence = item.deploymentEvidence?.[target]
          return <article className={evidence ? 'verified' : ''} key={target}><b>{evidence ? '✓' : '○'} {deploymentLabel(target)}</b>{evidence?.proof ? <Markdown className="deployment-proof" source={evidence.proof} /> : <small>Awaiting deploy-loop verification</small>}{evidence?.acceptance && <div className="deployment-acceptance"><span>Acceptance</span><Markdown source={evidence.acceptance} /></div>}</article>
        })}</div>}
        {item.deploymentBuild && <ReadonlyField label="Build" value={item.deploymentBuild} />}
        {item.deploymentResult && <div className="wide-field"><ReadonlyField label="Deploy result" value={item.deploymentResult} markdown /></div>}
      </div></details>

        <section className="thread"><h3>{canManage ? 'Internal thread' : 'AI collaboration thread'} <span>{item.messages?.length || 0} notes{groupedMessages.length !== (item.messages?.length || 0) ? ` · ${groupedMessages.length} events` : ''}</span></h3>{groupedMessages.length === 0 ? <p className="muted">No notes yet. Add context or attachments for the selected model.</p> : groupedMessages.map(({ entry, count }, index) => {
          const role = messageRole(entry.author)
          const messagesBefore = groupedMessages.slice(0, index).reduce((total, group) => total + group.count, 0)
          const showUnreadDivider = unreadAtOpen > 0 && messagesBefore <= firstUnseenIndex && firstUnseenIndex < messagesBefore + count
          return <div key={index}>{showUnreadDivider && <div className="unread-divider"><span>{unreadAtOpen} new</span></div>}<article className={`thread-message ${role}`}>
            <div className="thread-message-head"><span className="thread-avatar" aria-hidden="true">{authorMark(entry.author, role)}</span><div><strong>{entry.author}</strong><small>{role === 'agent' ? 'Agent response' : 'Human response'}</small>{count > 1 && <b className="repeat-count">Repeated {count}×</b>}</div><time>{formatRelative(entry.createdAt)}</time></div>
            {entry.body && <Markdown className="thread-entry" source={entry.body} renderText={renderMarkdownText} />}<AttachmentGallery urls={entry.imageUrls} label={`Note ${index + 1} attachment`} />
          </article></div>
        })}</section>
        {canManage && !isPhoneLayout && <div className="action-bar detail-actions-bottom">{actionBar}{bottomRoutingControls}</div>}
        <div ref={threadEndRef} aria-hidden="true" />
      </div>
    </div>

    <form className={`detail-reply ${isPhoneLayout ? 'compact-detail-reply' : ''}`} onSubmit={(event) => { event.preventDefault(); void addMessage(false) }}>
      {isPhoneLayout ? <details className="reply-tools" ref={replyToolsRef}><summary role="button">Reply tools <span>{canManage ? 'Item actions · ' : ''}Quick replies · Preview</span></summary><div>
        {canManage && <section className="phone-item-actions" aria-label="Item actions"><span>Item actions</span><div className="action-bar">{actionBar}</div></section>}
        <div className="filter-group quick-replies" role="group" aria-label="Quick replies">{QUICK_REPLIES.map((reply) => <button type="button" key={reply} disabled={busy} onClick={() => setMessage(quickReplyDraft(reply))}>{reply}</button>)}</div>
        <div className="reply-compose-toolbar"><span>{previewingMessage ? 'Markdown preview' : 'Markdown supported'}</span><button type="button" aria-pressed={previewingMessage} onClick={() => setPreviewingMessage((value) => !value)}>Preview</button></div>
      </div></details> : <>
        <div className="filter-group quick-replies" role="group" aria-label="Quick replies">{QUICK_REPLIES.map((reply) => <button type="button" key={reply} disabled={busy} onClick={() => setMessage(quickReplyDraft(reply))}>{reply}</button>)}</div>
        <div className="reply-compose-toolbar"><span>{previewingMessage ? 'Markdown preview' : 'Markdown supported'}</span><button type="button" aria-pressed={previewingMessage} onClick={() => setPreviewingMessage((value) => !value)}>Preview</button></div>
      </>}
      <div className="reply-compose">{previewingMessage ? <div className="reply-preview" aria-label="Note preview">{message.trim() ? <Markdown source={message} /> : <p className="muted">Nothing to preview yet.</p>}</div> : <textarea ref={noteRef} aria-label="Add note" rows={isPhoneLayout ? 1 : 2} placeholder={isPhoneLayout ? 'Add a note… (⌘↵ to send)' : 'Add context or paste an attachment… (⌘↵ to send)'} value={message} onPaste={handlePaste} onKeyDown={sendOnShortcut} onChange={(event) => setMessage(event.target.value)} />}
      <AttachmentPicker compact files={attachments} disabled={busy} onAdd={addAttachments} onRemove={(index) => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index))} /></div>
      {attachmentError && <p className="form-error">{attachmentError}</p>}
      {isPhoneLayout
        ? <div className="compact-reply-actions">{canReturnToAgent
          ? <button type="button" className="button primary" disabled={busy || !composerReady} onClick={() => void addMessage(true)}>Add & return to agent</button>
          : <button type="submit" className="button primary" disabled={busy || !composerReady}>Add note</button>}</div>
        : <div>{showApprove && approveButton('button success')}<button type="submit" className="button secondary" disabled={busy || !composerReady}>Add note</button>{canReturnToAgent && <button type="button" className="button primary" disabled={busy || !composerReady} onClick={() => void addMessage(true)}>Add & return to agent</button>}</div>}
    </form>
    {closing && <Modal title={`Mark ${itemRef(item.kind, item.number)} done without a deployment`} onClose={busy ? () => undefined : () => setClosing(false)}>
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void closeWithoutDeployment() }}>
        {closeMode === 'confirm' && <p className="form-error">This item still has a release scope: {deploymentSummary(item, Boolean(item.deploymentApprovedAt))}. Marking it done skips that release and nothing will be deployed.</p>}
        <p className="muted">Marks {itemRef(item.kind, item.number)} {item.kind === 'feature' ? 'shipped' : 'closed'} with your note in the thread and no deployment proof. Use it for audits, research, docs-only changes, duplicates, or work verified by hand.</p>
        <label>Resolution note<textarea required autoFocus rows={3} value={closeNote} onChange={(event) => setCloseNote(event.target.value)} placeholder="How was this completed without a release?" /></label>
        <div className="form-actions"><button type="button" className="button secondary" onClick={() => setClosing(false)} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !closeNote.trim()}>{closeMode === 'confirm' ? 'Skip release & mark done' : `Mark ${item.kind === 'feature' ? 'shipped' : 'closed'}`}</button></div>
      </form>
    </Modal>}
  </div>
}

function DeploymentTargetPicker({ value, disabled, onChange }: { value: string[]; disabled: boolean; onChange: (targets: string[]) => void }) {
  const selected = normalizeDeploymentTargets(value)
  const toggle = (target: string, checked: boolean) => {
    if (target === 'none') { onChange(checked ? ['none'] : []); return }
    const next = checked ? [...selected.filter((value) => value !== 'none'), target] : selected.filter((value) => value !== target)
    onChange(normalizeDeploymentTargets(next))
  }
  return <fieldset className="deployment-target-picker wide-field" aria-label="Deployment targets" disabled={disabled}>
    <legend>Deployment targets <small>Choose every release surface</small></legend>
    <div>{DEPLOYMENT_TARGETS.map((target) => <label key={target}><input type="checkbox" aria-label={deploymentLabel(target)} checked={selected.includes(target)} onChange={(event) => toggle(target, event.target.checked)} /><span>{deploymentLabel(target)}</span></label>)}</div>
  </fieldset>
}

function ReadonlyField({ label, value, markdown = false }: { label: string; value: string; markdown?: boolean }) {
  return <div className="readonly-field"><span>{label}</span>{markdown ? <div className="readonly-value"><Markdown source={value} /></div> : <strong>{value}</strong>}</div>
}
function collectionRef(kind: WorkKind) { return collection(db, collections[kind]) }

function OwnerSelect({ value, onChange }: { value: Owner; onChange: (value: Owner) => void }) {
  const legacy = value && !AGENT_MODELS.some((agent) => agent.owner === value)
  return <select aria-label="Agent model" value={value} onChange={(event) => onChange(event.target.value)}>{legacy && <option value={value}>{ownerLabel(value)}</option>}{AGENT_MODELS.map((agent) => <option key={agent.owner} value={agent.owner}>{agent.emoji} {agent.label}</option>)}<option value="">Unassigned</option></select>
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button aria-label="Close" onClick={onClose}>×</button></header>{children}</section></div>
}
