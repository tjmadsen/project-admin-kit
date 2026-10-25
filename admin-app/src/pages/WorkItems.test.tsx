import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Timestamp } from 'firebase/firestore'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkItem } from '../lib/types'
import { DetailBackProvider, useDetailBack } from '../components/DetailBackContext'
import { adminWorkItemPath } from '../lib/format'
import WorkItems, { APPROVAL_NOTE, canApproveAndReturn, closeWithoutDeploymentMode, deploymentApprovalIssue, deploymentNotesReady, deploymentSummary, effectiveGate, groupThreadMessages, lastMessagePreview, matchesItemReference, messageRole, parseSeenCounts, quickReplyDraft, stripMarkdown, syncPhoneDetailHeight, threadNearBottom, unreadMessageCount } from './WorkItems'

const state = vi.hoisted(() => ({ data: [] as unknown[], transactionData: undefined as Record<string, unknown> | null | undefined }))
const firestore = vi.hoisted(() => ({
  updateDoc: vi.fn(async (_reference: unknown, _data: Record<string, unknown>) => undefined),
  transactionSets: [] as Array<{ path: string; data: Record<string, unknown> }>,
  transactionUpdate: vi.fn((_reference: unknown, _data: Record<string, unknown>) => undefined),
  transactionSet: vi.fn((_reference: unknown, _data: Record<string, unknown>) => undefined),
  // One transaction fake for both callers: new items read the counters doc,
  // deferral saves read the item itself (state.transactionData, or null for a
  // deleted item).
  runTransaction: vi.fn(async (_database: unknown, callback: (transaction: unknown) => Promise<unknown>) => callback({
    get: async (reference: { path?: string }) => reference?.path === 'system/counters'
      ? { exists: () => true, data: () => ({ nextFeatureNumber: 30, nextBugNumber: 12 }) }
      : { exists: () => state.transactionData !== null, data: () => state.transactionData ?? state.data[0] ?? {} },
    update: (reference: unknown, data: Record<string, unknown>) => {
      firestore.transactionUpdate(reference, data)
      void firestore.updateDoc(reference, data)
    },
    set: (reference: { path: string }, data: Record<string, unknown>) => {
      firestore.transactionSets.push({ path: reference.path, data })
      firestore.transactionSet(reference, data)
    },
  })),
}))
const scrollIntoView = vi.fn()
const preferenceStore = new Map<string, string>()

vi.mock('../hooks/useCollection', () => ({
  useCollection: () => ({ data: state.data, loading: false, error: '' }),
}))

vi.mock('../hooks/useLoopData', () => ({
  useLoopRuns: () => ({ runs: [], error: '' }),
}))

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>()
  return {
    ...actual,
    updateDoc: firestore.updateDoc,
    runTransaction: firestore.runTransaction,
    arrayUnion: (...values: unknown[]) => ({ arrayUnion: values }),
    serverTimestamp: () => 'server-timestamp',
  }
})

const item: WorkItem = {
  id: 'feature-1',
  kind: 'feature',
  number: 1,
  title: 'Creator-visible feature',
  description: 'A feature Collaborator can follow without managing.',
  priority: 'medium',
  status: 'backlog',
  waitingOn: 'human',
  assignedTo: '',
  thinkingEffort: 'medium',
  targetMachine: 'local-mac',
  deploymentType: 'firebase_hosting',
  createdByEmail: 'collaborator@example.com',
  createdByRole: 'collaborator',
  createdAt: null,
  updatedAt: null,
  messages: [],
}

const approvable: WorkItem = { ...item, assignedTo: 'sol-agent', status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review', prUrl: 'https://github.com/example/repo/pull/42' }
const validDeploymentNotes = 'Scope: Release the affected admin surface from PR #42.\nCommands: Build admin and deploy Hosting in that order.\nVerification: Open the production admin route and inspect the current asset.\nAcceptance: Complete the workflow and observe the expected saved result.'
const multiPrDeploymentNotes = 'Scope: Release the affected admin surface through PR #43, including merged implementation PR #42.\nCommands: Fetch PR #43, build admin, and deploy Hosting in that order.\nVerification: Open the production admin route and inspect the current asset.\nAcceptance: Complete the workflow and observe the expected saved result.'

function usePhoneDetailLayout() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function DetailBackTrigger() {
  const { goBack } = useDetailBack()
  return <button onClick={goBack}>Trigger detail back</button>
}

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-image') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    get length() { return preferenceStore.size },
    clear: () => preferenceStore.clear(),
    getItem: (key: string) => preferenceStore.get(key) ?? null,
    key: (index: number) => [...preferenceStore.keys()][index] ?? null,
    removeItem: (key: string) => preferenceStore.delete(key),
    setItem: (key: string, value: string) => preferenceStore.set(key, String(value)),
  } satisfies Storage })
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: !query.includes('max-width'),
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

afterAll(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  firestore.updateDoc.mockReset()
  firestore.updateDoc.mockResolvedValue(undefined)
  firestore.transactionUpdate.mockReset()
  firestore.transactionSet.mockReset()
  firestore.runTransaction.mockClear()
  state.transactionData = undefined
  scrollIntoView.mockClear()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/admin/features')
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: !query.includes('max-width'),
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

describe('work item thread scrolling', () => {
  const firstMessage = { author: 'Codex Sol', body: 'Initial investigation', createdAt: null }
  const nextMessage = { author: 'Project owner', body: 'Approved, continue', createdAt: null }

  function setScrollPosition(element: Element, { scrollHeight, scrollTop, clientHeight }: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: scrollHeight },
      scrollTop: { configurable: true, value: scrollTop },
      clientHeight: { configurable: true, value: clientHeight },
    })
  }

  it('scrolls to the newest message when an item opens', async () => {
    state.data = [{ ...item, messages: [firstMessage] }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' }))
  })

  it('smooth-scrolls when a message arrives while the reader is near the bottom', async () => {
    state.data = [{ ...item, messages: [firstMessage] }]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    scrollIntoView.mockClear()
    const detailScroll = view.container.querySelector('.detail-scroll')!
    setScrollPosition(detailScroll, { scrollHeight: 1000, scrollTop: 800, clientHeight: 100 })
    fireEvent.scroll(detailScroll)

    state.data = [{ ...item, messages: [firstMessage, nextMessage] }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' }))
  })

  it('does not scroll when a message arrives while the reader is higher in history', async () => {
    state.data = [{ ...item, messages: [firstMessage] }]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    scrollIntoView.mockClear()
    const detailScroll = view.container.querySelector('.detail-scroll')!
    setScrollPosition(detailScroll, { scrollHeight: 1000, scrollTop: 200, clientHeight: 100 })
    fireEvent.scroll(detailScroll)

    state.data = [{ ...item, messages: [firstMessage, nextMessage] }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(view.container.querySelectorAll('.thread-message')).toHaveLength(2))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  function usePhoneViewport() {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: !query.includes('min-width: 1181px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }

  async function openPhoneDetail() {
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(view.container.querySelector('.work-list-card')!)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' }))
    scrollIntoView.mockClear()
    return view
  }

  const pageScrollKeys = ['scrollY', 'innerHeight'] as const
  const savedPageScroll = pageScrollKeys.map((key) => Object.getOwnPropertyDescriptor(window, key))

  function setPageScrollPosition({ scrollHeight, scrollY, innerHeight }: { scrollHeight: number; scrollY: number; innerHeight: number }) {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: scrollY })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight })
  }

  afterEach(() => {
    pageScrollKeys.forEach((key, index) => {
      const descriptor = savedPageScroll[index]
      if (descriptor) Object.defineProperty(window, key, descriptor)
    })
  })

  it('does not follow an append while a phone reader is scrolled up inside the detail container', async () => {
    usePhoneViewport()
    state.data = [{ ...item, messages: [firstMessage] }]
    const view = await openPhoneDetail()
    const detailScroll = view.container.querySelector('.detail-scroll')!
    setScrollPosition(detailScroll, { scrollHeight: 1000, scrollTop: 200, clientHeight: 100 })
    fireEvent.scroll(detailScroll)

    state.data = [{ ...item, messages: [firstMessage, nextMessage] }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(view.container.querySelectorAll('.thread-message')).toHaveLength(2))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('follows an append while a phone reader is near the bottom of the detail container', async () => {
    usePhoneViewport()
    state.data = [{ ...item, messages: [firstMessage] }]
    const view = await openPhoneDetail()
    const detailScroll = view.container.querySelector('.detail-scroll')!
    setScrollPosition(detailScroll, { scrollHeight: 1000, scrollTop: 830, clientHeight: 100 })
    fireEvent.scroll(detailScroll)

    state.data = [{ ...item, messages: [firstMessage, nextMessage] }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' }))
  })

  it('measures the page when the detail container does not scroll', async () => {
    usePhoneViewport()
    state.data = [{ ...item, messages: [firstMessage] }]
    const view = await openPhoneDetail()
    const detailScroll = view.container.querySelector('.detail-scroll')!
    setScrollPosition(detailScroll, { scrollHeight: 500, scrollTop: 0, clientHeight: 500 })
    setPageScrollPosition({ scrollHeight: 1000, scrollY: 200, innerHeight: 100 })
    fireEvent.scroll(window)

    state.data = [{ ...item, messages: [firstMessage, nextMessage] }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(view.container.querySelectorAll('.thread-message')).toHaveLength(2))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('picks the surface that actually scrolls', () => {
    const container = document.createElement('div')
    setScrollPosition(container, { scrollHeight: 1000, scrollTop: 200, clientHeight: 100 })
    setPageScrollPosition({ scrollHeight: 100, scrollY: 0, innerHeight: 100 })
    expect(threadNearBottom(container)).toBe(false)

    setScrollPosition(container, { scrollHeight: 500, scrollTop: 0, clientHeight: 500 })
    setPageScrollPosition({ scrollHeight: 1000, scrollY: 200, innerHeight: 100 })
    expect(threadNearBottom(container)).toBe(false)
    expect(threadNearBottom(null)).toBe(false)

    setPageScrollPosition({ scrollHeight: 1000, scrollY: 850, innerHeight: 100 })
    expect(threadNearBottom(container)).toBe(true)
  })
})

describe('phone detail viewport sizing', () => {
  const visualViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight')

  afterEach(() => {
    if (visualViewportDescriptor) Object.defineProperty(window, 'visualViewport', visualViewportDescriptor)
    else Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor)
  })

  it('tracks visualViewport shrinking and restoration while preserving thread position', async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    const listeners = new Map<string, EventListener>()
    const viewport = {
      height: 500,
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const appShell = document.createElement('div')
    const thread = document.createElement('div')
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    })
    thread.scrollTop = 700

    const cleanup = syncPhoneDetailHeight(appShell, thread)
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('500px'))
    expect(thread.scrollTop).toBe(700)

    thread.scrollTop = 240
    viewport.height = 320
    listeners.get('resize')?.(new Event('resize'))
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('320px'))
    expect(thread.scrollTop).toBe(240)

    viewport.height = 700
    listeners.get('resize')?.(new Event('resize'))
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('700px'))
    expect(thread.scrollTop).toBe(240)

    cleanup()
    expect(appShell.style.getPropertyValue('--app-height')).toBe('')
    expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(viewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })

  it('falls back to window height when visualViewport is unavailable', async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 612 })
    const appShell = document.createElement('div')

    const cleanup = syncPhoneDetailHeight(appShell, null)
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('612px'))
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 744 })
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('744px'))
    cleanup()
  })

  it('returns a keyboard-scrolled page to the top so the shell never sits off-screen', async () => {
    usePhoneDetailLayout()
    const listeners = new Map<string, EventListener>()
    const viewport = {
      height: 700,
      offsetTop: 0,
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY')
    let pageOffset = 0
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => pageOffset })
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => { pageOffset = 0; viewport.offsetTop = 0 })
    const appShell = document.createElement('div')

    const cleanup = syncPhoneDetailHeight(appShell, null)
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('700px'))
    expect(scrollTo).not.toHaveBeenCalled()

    // iOS scrolls the page up to reveal the focused note box as the keyboard opens.
    pageOffset = 380
    viewport.height = 320
    listeners.get('resize')?.(new Event('resize'))
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('320px'))
    expect(window.scrollY).toBe(0)

    // Closing the keyboard must not leave the header cut off and a gap at the bottom.
    viewport.offsetTop = 120
    viewport.height = 700
    listeners.get('resize')?.(new Event('resize'))
    await waitFor(() => expect(appShell.style.getPropertyValue('--app-height')).toBe('700px'))
    expect(viewport.offsetTop).toBe(0)

    cleanup()
    scrollTo.mockRestore()
    if (scrollYDescriptor) Object.defineProperty(window, 'scrollY', scrollYDescriptor)
  })
})

describe('phone note composer', () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight')

  afterEach(() => {
    if (scrollHeightDescriptor) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', scrollHeightDescriptor)
  })

  it('grows the note box as a long note is typed and shrinks it after sending', async () => {
    usePhoneDetailLayout()
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) { return 16 + 22 * Math.max(1, this.value.split('\n').length) },
    })
    state.data = [{ ...approvable, waitingOn: 'agent', status: 'in_progress', blockedReason: undefined }]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const composer = await screen.findByLabelText('Add note')
    const oneLine = composer.style.height

    fireEvent.change(composer, { target: { value: 'First line\nsecond\nthird\nfourth' } })
    expect(parseFloat(composer.style.height)).toBeGreaterThan(parseFloat(oneLine) || 0)
    expect(composer.style.height).toBe('106px')

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByLabelText('Add note')).toHaveValue(''))
    expect(screen.getByLabelText('Add note').style.height).toBe('40px')
  })
})

describe('WorkItems collaborator access', () => {
  it('lets Collaborator collaborate with an assigned AI without management or deploy controls', async () => {
    state.data = [{ ...item, assignedTo: 'sol-agent', status: 'blocked', blockedReason: 'question' }]
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" actorName="Collaborator User" />)
    await waitFor(() => expect(screen.getByText('Collaborator')).toBeInTheDocument())
    expect(screen.getByText(/Administrators control models, lifecycle approvals, closing, and every deployment/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Priority')).toBeInTheDocument()
    expect(screen.queryByLabelText('Agent model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Thinking effort')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Add note')).toBeInTheDocument()
    expect(screen.getByLabelText('Choose attachments')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add & return to agent/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /More actions/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send to Deploy/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mark shipped/i })).not.toBeInTheDocument()
  })

  it('keeps deploy approval and acceptance actions exclusive to Project owner', async () => {
    state.data = [{ ...item, assignedTo: 'sol-agent', status: 'ready_for_deploy', blockedReason: 'deploy_approval' }]
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" actorName="Collaborator User" />)
    await waitFor(() => expect(screen.getByLabelText('Add note')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /return to agent/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve Firebase Hosting → deploy/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /More actions/i })).not.toBeInTheDocument()
  })

  it('limits creator submissions to content and initial attachments', () => {
    state.data = []
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New request/i }))
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
    expect(screen.getByLabelText('Priority')).toBeInTheDocument()
    expect(screen.queryByLabelText('Agent model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Thinking effort')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Choose attachments')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeInTheDocument()
  })

  it('uses waiting-on filters and a per-agent up-next queue', async () => {
    state.data = [
      { ...item, id: 'feature-sol', number: 8, assignedTo: 'sol-agent', waitingOn: 'agent', priority: 'high' },
      { ...item, id: 'feature-terra', number: 9, assignedTo: 'terra-agent', waitingOn: 'agent', priority: 'medium' },
    ]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(screen.getByText('Up next')).toBeInTheDocument())
    expect(screen.getAllByText('Waiting on').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Human 0$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Human 0$/ })).toHaveClass('active')
    expect(screen.getByRole('button', { name: /^Agent 2$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Deploy 0$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Hold 0$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^All 2$/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Active/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Critical/ })).not.toBeInTheDocument()
    expect(screen.getByText('☀️ Sol')).toBeInTheDocument()
    expect(screen.getByText('🌍 Terra')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'FR-8' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'FR-9' })).toBeInTheDocument()
  })

  it.each(['feature', 'bug'] as const)('saves and clears a %s deadline without moving it out of the Agent queue', async (kind) => {
    state.data = [{ ...item, kind, status: kind === 'feature' ? 'backlog' : 'open', waitingOn: 'agent', assignedTo: 'sol-agent' }]
    render(<WorkItems kind={kind} canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /^Agent 1$/ }))
    const input = await screen.findByLabelText('Deferred until')
    fireEvent.change(input, { target: { value: '2026-10-03T17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save deferral' }))
    await waitFor(() => expect(firestore.transactionUpdate).toHaveBeenCalled())
    const payload = firestore.transactionUpdate.mock.calls[0][1]
    expect((payload.deferredUntil as Timestamp).toDate()).toEqual(new Date('2026-10-03T17:30'))
    expect(Object.keys(payload).sort()).toEqual(['deferredUntil', 'updatedAt'])
    expect(screen.getByLabelText('Deferred until')).toHaveValue('2026-10-03T17:30')
    fireEvent.click(screen.getByRole('button', { name: 'Clear deferral' }))
    await waitFor(() => expect(firestore.transactionUpdate.mock.calls.at(-1)?.[1]).toEqual({ deferredUntil: null, updatedAt: 'server-timestamp' }))
    expect(screen.getByLabelText('Deferred until')).toHaveValue('')
  })

  it('refuses to defer an item that an agent claims while the form is open', async () => {
    state.data = [{ ...item, waitingOn: 'agent', assignedTo: 'sol-agent' }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /^Agent 1$/ }))
    fireEvent.change(await screen.findByLabelText('Deferred until'), { target: { value: '2026-10-03T17:30' } })
    state.transactionData = { ...state.data[0] as WorkItem, claimedBy: 'sol', leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) }
    fireEvent.click(screen.getByRole('button', { name: 'Save deferral' }))
    expect(await screen.findByText(/already working on this item/i)).toBeInTheDocument()
    expect(firestore.transactionUpdate).not.toHaveBeenCalled()
  })

  it('keeps deferred work in Agent and adds it to Up next when the deadline passes', () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-10-03T12:00:00Z')
      vi.setSystemTime(now)
      state.data = [{ ...item, number: 8, waitingOn: 'agent', assignedTo: 'sol-agent', deferredUntil: Timestamp.fromMillis(now.getTime() + 60_000) }]
      render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
      fireEvent.click(screen.getByRole('button', { name: /^Agent 1$/ }))
      expect(screen.getAllByText(item.title).length).toBeGreaterThan(0)
      expect(screen.queryByRole('button', { name: 'FR-8' })).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(60_001))
      expect(screen.getByRole('button', { name: 'FR-8' })).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it.each(['feature', 'bug'] as const)('creates a queued %s with the selected local deadline', async (kind) => {
    state.data = []
    render(<WorkItems kind={kind} canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: kind === 'feature' ? /New request/i : /New bug/i }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Scheduled work' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Start after the deadline.' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Send directly to an agent/i }))
    fireEvent.change(screen.getByLabelText('Deferred until'), { target: { value: '2026-10-03T17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create & queue' }))
    await waitFor(() => expect(firestore.transactionSet).toHaveBeenCalledTimes(2))
    const payload = firestore.transactionSet.mock.calls[1][1]
    expect(payload).toMatchObject({ kind, waitingOn: 'agent', blockedReason: null })
    expect((payload.deferredUntil as Timestamp).toDate()).toEqual(new Date('2026-10-03T17:30'))
  })

  it('shows a saved deadline to a collaborator without allowing edits', async () => {
    state.data = [{ ...item, deferredUntil: Timestamp.fromDate(new Date('2026-10-03T17:30')) }]
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" />)
    await screen.findByLabelText('Add note')
    expect(screen.queryByLabelText('Deferred until')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save deferral' })).not.toBeInTheDocument()
    expect(screen.getByText(new Date('2026-10-03T17:30').toLocaleString())).toBeInTheDocument()
  })

  it('filters the list to on-hold items', async () => {
    state.data = [
      { ...item, id: 'feature-held', number: 10, title: 'Paused idea', assignedTo: 'sol-agent', waitingOn: 'hold' },
      { ...item, id: 'feature-live', number: 11, title: 'Active idea', assignedTo: 'terra-agent', waitingOn: 'agent' },
    ]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(await screen.findByRole('button', { name: /^Hold 1$/ }))
    expect(screen.getByRole('button', { name: /^Hold 1$/ })).toHaveClass('active')
    expect(screen.getAllByText('Paused idea').length).toBeGreaterThan(0)
    expect(screen.queryByText('Active idea')).not.toBeInTheDocument()
  })

  it('shows why a dependent item is waiting and keeps it out of the up-next lane', async () => {
    state.data = [
      { ...item, id: 'feature-7', number: 7, title: 'UI overhaul', assignedTo: 'terra-agent', status: 'in_review', waitingOn: 'human' },
      { ...item, id: 'feature-8', number: 8, title: 'Mock data', assignedTo: 'sol-agent', waitingOn: 'agent', dependsOn: ['feature-7'] },
    ]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /^Agent 1$/ }))

    expect(await screen.findByText('Waiting on FR-7')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'FR-8' })).not.toBeInTheDocument()
  })

  it('defaults the work list to most recently updated first', () => {
    state.data = [
      { ...item, id: 'older', number: 10, title: 'Older update', updatedAt: { toDate: () => new Date('2026-08-30T12:00:00Z') } },
      { ...item, id: 'newer', number: 11, title: 'Newer update', updatedAt: { toDate: () => new Date('2026-08-31T12:00:00Z') } },
    ]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect(screen.getByRole('combobox', { name: 'Sort items' })).toHaveValue('updated')
    expect(screen.getByRole('button', { name: 'Reverse sort' })).toHaveTextContent('↓')
    expect([...container.querySelectorAll('.work-list-card > strong')].map((element) => element.textContent)).toEqual(['Newer update', 'Older update'])
  })

  it('defaults routed admin work to Sol with xhigh thinking, offering Sol\'s full effort range', () => {
    state.data = []
    render(<WorkItems kind="bug" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New bug/i }))
    fireEvent.click(screen.getByText('Route now'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Send directly to an agent/i }))
    expect(screen.getByLabelText('Agent model')).toHaveValue('sol-agent')
    expect(screen.getByLabelText('Thinking effort')).toHaveValue('xhigh')
    expect([...screen.getByLabelText('Thinking effort').querySelectorAll('option')].map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  it('narrows and widens the thinking-effort menu as the routed agent model changes', () => {
    state.data = []
    render(<WorkItems kind="bug" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New bug/i }))
    fireEvent.click(screen.getByText('Route now'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Send directly to an agent/i }))

    fireEvent.change(screen.getByLabelText('Agent model'), { target: { value: 'grok-agent' } })
    expect([...screen.getByLabelText('Thinking effort').querySelectorAll('option')].map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh'])

    fireEvent.change(screen.getByLabelText('Agent model'), { target: { value: 'sol-agent' } })
    expect([...screen.getByLabelText('Thinking effort').querySelectorAll('option')].map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  it('keeps an edited create draft when backdrop dismissal is rejected', () => {
    state.data = []
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = render(<WorkItems kind="bug" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New bug/i }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft title' } })

    fireEvent.mouseDown(container.querySelector('.modal-backdrop')!)

    expect(confirm).toHaveBeenCalledWith('Discard this draft? Your changes will be lost.')
    expect(screen.getByLabelText('Title')).toHaveValue('Draft title')
    expect(screen.getByRole('dialog', { name: 'New bug' })).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('closes an edited create draft when discard is confirmed', () => {
    state.data = []
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<WorkItems kind="bug" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New bug/i }))
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Unsaved details' } })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'New bug' })).not.toBeInTheDocument()
    confirm.mockRestore()
  })

  it('closes an untouched create form without prompting', () => {
    state.data = []
    const confirm = vi.spyOn(window, 'confirm')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New request/i }))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(confirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'New feature request' })).not.toBeInTheDocument()
    confirm.mockRestore()
  })

  it('accepts pasted screenshots in the create form', () => {
    state.data = []
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New request/i }))
    const image = new File(['pixels'], 'clipboard.png', { type: 'image/png' })
    fireEvent.paste(screen.getByLabelText('Description'), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] },
    })
    expect(screen.getByAltText('clipboard.png')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove clipboard.png' })).toBeInTheDocument()
  })

  it('accepts PDF, CSV, and TXT files in the create form', () => {
    state.data = []
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New request/i }))
    const files = [
      new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
      new File(['csv'], 'players.csv', { type: 'text/csv' }),
      new File(['txt'], 'notes.txt', { type: 'text/plain' }),
    ]
    fireEvent.change(screen.getByLabelText('Choose attachments'), { target: { files } })
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('players.csv')).toBeInTheDocument()
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
  })

  it('attaches a file dropped on the note box, not only on the small attach button', async () => {
    state.data = [item]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const composer = await screen.findByLabelText('Add note')
    const file = new File(['csv'], 'players.csv', { type: 'text/csv' })
    fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(screen.getByText('players.csv')).toBeInTheDocument()
    // A drop on the attach button inside the row must attach once, not twice.
    const notes = new File(['txt'], 'notes.txt', { type: 'text/plain' })
    fireEvent.drop(screen.getByLabelText('Choose attachments').closest('label')!, { dataTransfer: { types: ['Files'], files: [notes] } })
    expect(screen.getAllByText('notes.txt')).toHaveLength(1)
  })

  it('renders uploaded documents as named open or download cards', async () => {
    state.data = [{
      ...item,
      imageUrls: ['https://firebasestorage.googleapis.com/v0/b/demo/o/work-item-attachments%2Flogan%2Ffeature%2Ffeature-1%2F1234567890123-0-weekly-report.pdf?alt=media'],
    }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const link = await screen.findByRole('link', { name: 'Open or download weekly-report.pdf' })
    expect(link).toHaveAttribute('download', 'weekly-report.pdf')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders safe clickable links in descriptions and human and agent thread notes', async () => {
    state.data = [{
      ...item,
      description: 'Read https://example.com/docs.\nMirror http://example.org/path?x=1&y=2!',
      messages: [
        { author: 'Project owner', body: 'Compare (https://support.example.com/a_(b)). Keep javascript:alert(1) as text.', createdAt: null },
        { author: 'Codex Sol', body: 'Build details: https://ci.example.com/build/42, then reply.', createdAt: null },
      ],
    }]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    const expectedLinks = [
      'https://example.com/docs',
      'http://example.org/path?x=1&y=2',
      'https://support.example.com/a_(b)',
      'https://ci.example.com/build/42',
    ]
    for (const href of expectedLinks) {
      const link = await screen.findByRole('link', { name: href })
      expect(link).toHaveAttribute('href', href)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }

    expect(container.querySelector('.description')).toHaveTextContent('Read https://example.com/docs. Mirror http://example.org/path?x=1&y=2!')
    expect(screen.getByText(/Keep javascript:alert\(1\) as text/)).toBeInTheDocument()
    expect(container.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.thread-message.human .work-item-link')).toHaveLength(1)
    expect(container.querySelectorAll('.thread-message.agent .work-item-link')).toHaveLength(1)
  })

  it('resolves FR-N references inside Markdown-rendered bodies and keeps list previews plain', async () => {
    const target: WorkItem = { ...item, id: 'feature-2', number: 2, title: 'Linkify target' }
    state.data = [
      { ...item, messages: [{ author: 'Codex Sol', body: '### Handoff\n- Blocked on **FR-2**\n- `FR-2` stays literal', createdAt: null }] },
      target,
    ]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    const card = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-work-item-id="feature-1"]')
      expect(node).not.toBeNull()
      return node!
    })
    expect(card.querySelector('em')).toHaveTextContent('Codex Sol: Handoff Blocked on FR-2 FR-2 stays literal')
    fireEvent.click(card)

    const entry = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.thread-entry.markdown')
      expect(node).not.toBeNull()
      return node!
    })
    expect(entry.querySelector('h3')).toHaveTextContent('Handoff')
    expect(entry.querySelectorAll('li')).toHaveLength(2)
    expect(entry.querySelector('code')).toHaveTextContent('FR-2')
    const references = entry.querySelectorAll<HTMLElement>('.work-item-ref-link')
    expect(references).toHaveLength(1)

    fireEvent.click(references[0])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Linkify target' })).toBeInTheDocument())
  })

  // Every keystroke and every live snapshot used to replace each text
  // node and link in the open thread, about 9,600 DOM nodes for one short note.
  it('typing a note or a live update leaves the rendered thread in place', async () => {
    const target: WorkItem = { ...item, id: 'feature-2', number: 2, title: 'Linkify target' }
    const messages = [
      { author: 'Codex Sol', body: 'Blocked on **FR-2**. See [PR #42](https://github.com/example/repo/pull/42) and https://example.com/docs.', createdAt: null },
      { author: 'Owner', body: 'Approved, continue with FR-2', createdAt: null },
    ]
    state.data = [{ ...item, messages }, target]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>('[data-work-item-id="feature-1"]')
      expect(node).not.toBeNull()
      return node!
    }))
    const thread = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>('.thread')
      expect(node?.querySelectorAll('.thread-entry')).toHaveLength(2)
      return node!
    })
    const reference = thread.querySelector('.work-item-ref-link')!
    const link = thread.querySelector('a[href="https://github.com/example/repo/pull/42"]')!
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(thread, { childList: true, subtree: true, characterData: true })

    const note = screen.getByLabelText('Add note')
    for (const draft of ['L', 'Lo', 'Loo', 'Look', 'Looks good']) fireEvent.change(note, { target: { value: draft } })
    state.data = [{ ...item, messages, priority: 'high' }, { ...target }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(view.container.querySelector('.detail-title-row .priority-chip')).toHaveTextContent('high'))
    mutations.push(...observer.takeRecords())
    observer.disconnect()

    expect(note).toHaveValue('Looks good')
    expect(mutations.flatMap((record) => [...record.removedNodes])).toHaveLength(0)
    expect(reference.isConnected).toBe(true)
    expect(link.isConnected).toBe(true)
  })

  it('keeps the admin base path when a bug thread links to a feature', () => {
    expect(adminWorkItemPath({ kind: 'feature', number: 98 })).toBe('/admin/features?item=FR-98')
  })

  it('previews a composer draft with the shared Markdown renderer', async () => {
    state.data = [item]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.change(await screen.findByLabelText('Add note'), { target: { value: '### Check\n**Ready**' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    const preview = screen.getByLabelText('Note preview')
    expect(preview.querySelector('h3')).toHaveTextContent('Check')
    expect(preview.querySelector('strong')).toHaveTextContent('Ready')
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders deployment notes, results, and evidence as Markdown', async () => {
    state.data = [{
      ...item,
      deploymentNotes: '## Scope\n- Release admin',
      deploymentResult: '**Hosting** is live.',
      deploymentEvidence: { firebase_hosting: { proof: '`index.html` has the new asset.', acceptance: 'Preview shows a **table**.' } },
    }]
    const { container } = render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" actorName="Collaborator User" />)

    await screen.findByText('Deploy notes')
    expect(container.querySelector('.readonly-value h2')).toHaveTextContent('Scope')
    expect(container.querySelector('.deployment-proof code')).toHaveTextContent('index.html')
    expect(container.querySelector('.deployment-acceptance strong')).toHaveTextContent('table')
    expect(screen.getByText('Hosting')).toHaveProperty('tagName', 'STRONG')
  })

  it('renders the PR number as a real link in the list and detail badges', async () => {
    state.data = [{ ...item, prNumber: 42, prUrl: 'https://github.com/example/repo/pull/42' }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const links = await screen.findAllByRole('link', { name: 'PR #42' })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'https://github.com/example/repo/pull/42')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    }
  })

  it('retains all management controls for Project owner', async () => {
    state.data = [item]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Creator-visible feature' })).toBeInTheDocument())
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()
    expect(screen.getByText('backlog')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent model')).toBeInTheDocument()
    expect(screen.getByLabelText('Add note')).toBeInTheDocument()
    expect(screen.getByLabelText('Choose attachments')).toBeInTheDocument()
    expect(container.querySelectorAll('.action-bar')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Utilities/i })).toHaveLength(2)
    const deployPreparationActions = screen.getAllByRole('button', { name: /Complete deploy notes/i })
    expect(deployPreparationActions).toHaveLength(2)
    deployPreparationActions.forEach((button) => {
      expect(button).toBeEnabled()
      expect(button).toHaveAttribute('aria-describedby', 'deployment-handoff-hint-feature-1')
    })
    expect(screen.getByText(/Complete the Scope, Commands, Verification, and Acceptance sections/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '⏸ Hold' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Decline' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /More actions/i })).not.toBeInTheDocument()
    expect(screen.getAllByText(/Copy reference/i)).toHaveLength(2)
    expect(container.querySelector('.detail-actions-bottom [aria-label="Quick routing controls"]')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^✓ Mark shipped$/i })).not.toBeInTheDocument()
  })

  it.each([['top', 0], ['bottom', 1]] as const)('keeps both action bars in sync when the %s bar starts a write', async (_label, actionIndex) => {
    let finishWrite!: () => void
    firestore.updateDoc.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishWrite = () => resolve(undefined) }))
    state.data = [{ ...item, assignedTo: 'sol-agent', status: 'in_progress', waitingOn: 'agent' }]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    const holdActions = await screen.findAllByRole('button', { name: '⏸ Hold' })
    expect(holdActions).toHaveLength(2)
    fireEvent.click(holdActions[actionIndex])

    await waitFor(() => screen.getAllByRole('button', { name: '⏸ Hold' }).forEach((button) => expect(button).toBeDisabled()))
    // The data layer loads its adapter before the write reaches Firestore.
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    finishWrite()
    await waitFor(() => screen.getAllByRole('button', { name: '⏸ Hold' }).forEach((button) => expect(button).toBeEnabled()))
  })

  it('opens an exact work item from the email deep link', async () => {
    state.data = [
      { ...item, id: 'feature-8', number: 8, title: 'Another item' },
      { ...item, id: 'feature-9', number: 9, title: 'Email-linked item', blockedReason: 'pr_review' },
    ]
    window.history.replaceState({}, '', '/admin/features?item=FR-9&gate=pr_review')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Email-linked item' })).toBeInTheDocument())
  })

  it('registers phone detail selection with the app-shell back gesture', async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    state.data = [{ ...item, title: 'Swipe-back item' }]
    const { container } = render(
      <DetailBackProvider>
        <DetailBackTrigger />
        <WorkItems kind="feature" canManage actorEmail="owner@example.com" />
      </DetailBackProvider>,
    )

    fireEvent.click(container.querySelector('.work-list-card')!)
    await screen.findByRole('heading', { name: 'Swipe-back item' })
    fireEvent.click(screen.getByRole('button', { name: 'Trigger detail back' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Swipe-back item' })).not.toBeInTheDocument())
    expect(container.querySelector('.work-list-pane')).toBeInTheDocument()
  })

  it('keeps the delivery handoff visible with a concise release summary', async () => {
    state.data = [{ ...item, prNumber: 42, prUrl: 'https://github.com/example/repo/pull/42' }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const heading = await screen.findByText('PR and deploy handoff')
    expect(heading.closest('details')).toHaveAttribute('open')
    expect(screen.getByText('PR #42 · Firebase Hosting')).toBeInTheDocument()
    expect(screen.getByLabelText('PR URL')).toBeVisible()
  })

  it('shows every explicit deployment target instead of a single mixed value', async () => {
    state.data = [{ ...item, deploymentType: 'mixed', deploymentTargets: ['testflight', 'firebase_hosting'] }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await screen.findByText('PR and deploy handoff')
    expect(screen.getAllByText(/TestFlight \+ Firebase Hosting/).length).toBeGreaterThan(0)
    expect(screen.getByRole('group', { name: 'Deployment targets' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'TestFlight' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Firebase Hosting' })).toBeChecked()
    expect(screen.queryByRole('option', { name: 'Mixed release' })).not.toBeInTheDocument()
  })

  it('offers the configured deploy targets: enabled ones plus any the item already names', async () => {
    state.data = [{ ...item, deploymentType: 'firebase_hosting', deploymentTargets: ['firebase_hosting'] }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const picker = await screen.findByRole('group', { name: 'Deployment targets' })
    // The sample config disables TestFlight, Vercel, Flutter web, and Cloud Run.
    expect(within(picker).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['Firebase Hosting', 'Firebase Functions', 'Rules & indexes', 'No deploy'])
  })

  it('shows a deployment action instead of sending an approved release back to the build agent', async () => {
    state.data = [{ ...item, assignedTo: 'sol-agent', status: 'ready_for_deploy', blockedReason: 'deploy_approval', prNumber: 42, prUrl: 'https://github.com/example/repo/pull/42', branchName: 'sol/fr-42', deploymentNotes: validDeploymentNotes }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Approve Firebase Hosting → deploy/i })).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /Approve → Codex/i })).not.toBeInTheDocument()
  })

  it('requires old deploy-queue items to acquire the durable approval grant', async () => {
    state.data = [{ ...item, assignedTo: 'sol-agent', status: 'ready_for_deploy', waitingOn: 'deployer', blockedReason: 'deploy_approval', deploymentType: 'testflight', prNumber: 42, prUrl: 'https://github.com/example/repo/pull/42', branchName: 'sol/fr-42', deploymentNotes: validDeploymentNotes }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /^Deploy 1$/ }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Confirm TestFlight approval/i })).toHaveLength(2))
    expect(screen.queryByText('Deploy approval')).not.toBeInTheDocument()
  })

  it('allows Project owner acceptance only after every approved target has evidence', async () => {
    state.data = [{
      ...item,
      status: 'in_review',
      waitingOn: 'human',
      blockedReason: 'acceptance_review',
      deploymentType: 'mixed',
      deploymentTargets: ['testflight', 'firebase_hosting'],
      deploymentApprovedTargets: ['testflight', 'firebase_hosting'],
      deploymentBuild: '2609012201',
      deploymentResult: 'TestFlight build is valid.',
    }]
    const { rerender } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect((await screen.findAllByRole('button', { name: /Accept & mark shipped/i }))).toHaveLength(2)
    screen.getAllByRole('button', { name: /Accept & mark shipped/i }).forEach((button) => expect(button).toBeDisabled())
    const requestChangesActions = screen.getAllByRole('button', { name: /Request changes/i })
    expect(requestChangesActions).toHaveLength(2)
    requestChangesActions.forEach((button) => {
      expect(button).toHaveClass('warning-action')
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Select an agent model first.')
    })
    state.data = [{
      ...state.data[0] as WorkItem,
      deploymentEvidence: {
        testflight: { proof: 'TestFlight build 2609012201 is VALID.', acceptance: 'Project owner can now test the requested feature behavior.' },
        firebase_hosting: { proof: 'Production route loaded the new asset revision.', acceptance: 'The requested web workflow completed successfully.' },
      },
    }]
    rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    screen.getAllByRole('button', { name: /Accept & mark shipped/i }).forEach((button) => expect(button).toBeEnabled())
  })
})

describe('post-action list navigation', () => {
  const routedItem = { ...item, id: 'feature-24', number: 24, title: 'Current triage item', assignedTo: 'sol-agent' }
  const nextItem = { ...item, id: 'feature-25', number: 25, title: 'Next triage item', assignedTo: 'terra-agent' }

  it('auto-advances to and focuses the next filtered row after a successful hand-back', async () => {
    state.data = [routedItem, nextItem]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect(await screen.findByRole('heading', { name: 'Current triage item' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Auto-advance after hand-back' })).toBeChecked()

    fireEvent.click(screen.getAllByRole('button', { name: /Route → Codex Sol/i })[0])

    expect(await screen.findByRole('heading', { name: 'Next triage item' })).toBeInTheDocument()
    await waitFor(() => expect(container.querySelector('[data-work-item-id="feature-25"]')).toHaveFocus())
    expect(window.location.search).toBe('?item=FR-25')
  })

  it('keeps the detail open and shows the existing error when the patch fails', async () => {
    firestore.updateDoc.mockRejectedValueOnce(new Error('Firestore rejected the update.'))
    state.data = [routedItem, nextItem]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /Route → Codex Sol/i }))[0])

    expect(await screen.findByText('Firestore rejected the update.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Current triage item' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Next triage item' })).not.toBeInTheDocument()
  })

  it('keeps the detail open under All and offers the two-second Stay toast', async () => {
    state.data = [routedItem]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await screen.findByRole('heading', { name: 'Current triage item' })
    fireEvent.click(screen.getByRole('button', { name: /^All 1$/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /Route → Codex Sol/i })[0])

    expect(await screen.findByRole('status')).toHaveTextContent('Sent to Sol → back to list')
    expect(screen.getByRole('button', { name: 'Stay' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Current triage item' })).toBeInTheDocument()
  })

  it('returns mobile detail to the list and restores its saved scroll position', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: !query.includes('min-width: 1181px'),
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    state.data = [routedItem]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const list = container.querySelector('.work-list-scroll') as HTMLDivElement
    list.scrollTop = 187
    fireEvent.click(container.querySelector('.work-list-card')!)
    await screen.findByRole('heading', { name: 'Current triage item' })

    fireEvent.click(screen.getAllByRole('button', { name: /Route → Codex Sol/i })[0])

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Current triage item' })).not.toBeInTheDocument())
    await waitFor(() => expect(list.scrollTop).toBe(187))
    expect(container.querySelector('.work-split')).toHaveClass('returning-to-list')
    expect(window.location.search).toBe('')
  })
})

describe('closing without a deployment', () => {
  const noRelease: WorkItem = { ...item, assignedTo: 'fable-agent', status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review', deploymentType: 'none', deploymentTargets: [], prUrl: 'https://github.com/example/project/pull/99' }

  it('lets Project owner mark a no-release item shipped with a note and no deployment timestamps', async () => {
    state.data = [noRelease]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /Mark done \(no deployment\)/i }))[0])
    expect(screen.getByRole('dialog', { name: /Mark FR-1 done without a deployment/i })).toBeInTheDocument()
    expect(screen.queryByText(/skips that release/i)).not.toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Mark shipped' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'Audit findings are in the thread; nothing to release.' } })
    fireEvent.click(submit)
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    const payload = firestore.updateDoc.mock.calls[0][1] as Record<string, unknown>
    expect(payload).toMatchObject({ status: 'shipped', waitingOn: 'done', blockedReason: null, shippedAt: 'server-timestamp', resolution: 'Audit findings are in the thread; nothing to release.', claimedBy: null, leaseExpiresAt: null })
    expect(payload.messages).toEqual({ arrayUnion: [expect.objectContaining({ author: 'Project owner', authorEmail: 'owner@example.com', body: 'Closed without deployment: Audit findings are in the thread; nothing to release.' })] })
    expect(payload).not.toHaveProperty('deployedAt')
    expect(payload).not.toHaveProperty('deploymentVerifiedAt')
    expect(payload).not.toHaveProperty('deploymentAcceptedAt')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes bugs with resolvedAt instead of shippedAt', async () => {
    state.data = [{ ...noRelease, id: 'bug-4', kind: 'bug', number: 4, status: 'investigating' }]
    render(<WorkItems kind="bug" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /Mark done \(no deployment\)/i }))[0])
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'Duplicate of BUG-2, already fixed there.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    const payload = firestore.updateDoc.mock.calls[0][1] as Record<string, unknown>
    expect(payload).toMatchObject({ status: 'closed', waitingOn: 'done', resolvedAt: 'server-timestamp' })
    expect(payload).not.toHaveProperty('shippedAt')
    expect(payload).not.toHaveProperty('deployedAt')
  })

  it('warns and requires an explicit skip when a release scope is still pending', async () => {
    state.data = [{ ...noRelease, deploymentType: 'firebase_hosting', deploymentTargets: ['firebase_hosting'] }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /Mark done \(no deployment\)/i }))[0])
    expect(screen.getByText(/still has a release scope: Firebase Hosting/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip release & mark done' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Mark shipped' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(firestore.updateDoc).not.toHaveBeenCalled()
  })

  it('keeps the evidence-gated acceptance path and hides the action from collaborators and terminal items', async () => {
    state.data = [{ ...noRelease, status: 'shipped', waitingOn: 'done' }]
    window.history.replaceState({}, '', '/admin/features?item=fr-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect(await screen.findAllByRole('button', { name: /Reopen/i })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Mark done \(no deployment\)/i })).not.toBeInTheDocument()
    expect(closeWithoutDeploymentMode({ ...noRelease })).toBe('direct')
    expect(closeWithoutDeploymentMode({ ...noRelease, deploymentTargets: ['none'] })).toBe('direct')
    expect(closeWithoutDeploymentMode({ ...noRelease, status: 'declined' })).toBe('hidden')
    expect(closeWithoutDeploymentMode({ ...noRelease, waitingOn: 'deployer' })).toBe('confirm')
    expect(closeWithoutDeploymentMode({ ...noRelease, deploymentInProgressTarget: 'testflight' })).toBe('confirm')
    expect(closeWithoutDeploymentMode({ ...noRelease, deploymentApprovedAt: 'ts', deploymentApprovedTargets: ['testflight'] })).toBe('confirm')
    expect(closeWithoutDeploymentMode({ ...noRelease, deploymentType: 'vercel' })).toBe('confirm')
  })

  it('never offers the action to collaborators', async () => {
    state.data = [noRelease]
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" actorName="Collaborator User" />)
    await waitFor(() => expect(screen.getByLabelText('Add note')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Mark done \(no deployment\)/i })).not.toBeInTheDocument()
  })
})

describe('work item thread roles', () => {
  it('distinguishes agent notes from human replies', () => {
    expect(messageRole('Codex Sol')).toBe('agent')
    expect(messageRole('Claude Opus')).toBe('agent')
    expect(messageRole('Grok')).toBe('agent')
    expect(messageRole('Project owner')).toBe('human')
    expect(messageRole('Collaborator User')).toBe('human')
  })

  it('groups repeated release retries while preserving their count', () => {
    const groups = groupThreadMessages([
      { author: 'Codex Sol', body: 'TestFlight release blocked: release worktree is missing scripts/upload-testflight.sh. Log: /tmp/testflight-doc-2608311824.log', createdAt: null },
      { author: 'Codex Sol', body: 'TestFlight release blocked: release worktree is missing scripts/upload-testflight.sh. Log: /tmp/testflight-doc-2608311825.log', createdAt: null },
      { author: 'Project owner', body: 'Please retry.', createdAt: null },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].count).toBe(2)
    expect(groups[1].count).toBe(1)
  })

  it('uses the latest grouped message for previews and falls back to the description', () => {
    expect(lastMessagePreview(item)).toBe(item.description)
    expect(lastMessagePreview({ ...item, messages: [{ author: 'Codex Sol', body: 'Implementation is ready for review.', createdAt: null }] })).toBe('Codex Sol: Implementation is ready for review.')
    expect(lastMessagePreview({ ...item, messages: [{ author: 'Project owner', body: 'x'.repeat(180), createdAt: null }] })).toHaveLength(140)
    expect(lastMessagePreview({ ...item, messages: [{ author: 'Project owner', body: 'x'.repeat(180), createdAt: null }] })).toMatch(/…$/)
  })

  it('calculates unread counts defensively and parses stored preferences', () => {
    expect(unreadMessageCount(5, 2)).toBe(3)
    expect(unreadMessageCount(2, 5)).toBe(0)
    expect(parseSeenCounts('{"feature-1":2,"bad":"nope"}')).toEqual({ 'feature-1': 2 })
    expect(parseSeenCounts('not-json')).toEqual({})
  })

  it('marks an opened item seen while preserving an unread divider for that view', async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    window.localStorage.setItem('project-admin:my-project:feature:seen', JSON.stringify({ 'feature-1': 1 }))
    state.data = [{ ...item, messages: [
      { author: 'Project owner', body: 'Already read', createdAt: null },
      { author: 'Codex Sol', body: 'First new note', createdAt: null },
      { author: 'Project owner', body: 'Second new note', createdAt: null },
    ] }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    expect(screen.getByText('+2 new')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Creator-visible feature/i }))
    expect(await screen.findByText('2 new')).toBeInTheDocument()
    expect(screen.queryByText('+2 new')).not.toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('project-admin:my-project:feature:seen') || '{}')).toEqual({ 'feature-1': 3 })
  })
})

describe('plain-text Markdown summaries', () => {
  it('strips common syntax from compact list previews', () => {
    expect(stripMarkdown('## Update\n- **Ready** for [FR-12](/admin/features?item=FR-12) with `npm test`.')).toBe('Update Ready for FR-12 with npm test.')
    expect(stripMarkdown('Deploy firebase_rules_indexes from feature_agent.js.')).toBe('Deploy firebase_rules_indexes from feature_agent.js.')
  })
})

describe('work-item lifecycle gates', () => {
  it('distinguishes plan, PR, deploy, and acceptance reviews', () => {
    expect(effectiveGate({ ...item, status: 'plan_review', assignedTo: 'sol-agent' })).toBe('plan_review')
    expect(effectiveGate({ ...item, status: 'in_review', assignedTo: 'sol-agent', prUrl: 'https://example.com/pr/1' })).toBe('pr_review')
    expect(effectiveGate({ ...item, status: 'ready_for_deploy', assignedTo: 'sol-agent' })).toBe('deploy_approval')
    expect(effectiveGate({ ...item, blockedReason: 'acceptance_review' })).toBe('acceptance_review')
  })

  it('treats an unassigned human item as intake triage', () => {
    expect(effectiveGate(item)).toBe('triage')
  })

  it('matches deep links by friendly reference or document id', () => {
    expect(matchesItemReference({ ...item, number: 9 }, 'fr-9')).toBe(true)
    expect(matchesItemReference(item, 'feature-1')).toBe(true)
    expect(matchesItemReference(item, 'BUG-1')).toBe(false)
  })
})

describe('deployment handoff contract', () => {
  it('summarizes multi-target and legacy deployment scopes', () => {
    expect(deploymentSummary({ deploymentTargets: ['testflight', 'firebase_hosting'] })).toBe('TestFlight + Firebase Hosting')
    expect(deploymentSummary({ deploymentType: 'firebase_hosting' })).toBe('Firebase Hosting')
    expect(deploymentSummary({ deploymentType: 'mixed' })).toBe('Targets need itemizing')
  })

  it('requires all structured note sections before approval', () => {
    expect(deploymentNotesReady('Scope: Release the full affected change with enough detail for the deploy worker.\nCommands: Build and deploy the release in the documented order.\nVerification: Inspect the changed production route and revision.')).toBe(false)
    expect(deploymentNotesReady('Scope: Release the affected admin and backend surfaces in the approved pull request.\nCommands: Build admin, deploy Hosting, then deploy the named function.\nVerification: Open the production route and invoke the production callable.\nAcceptance: Complete the feature workflow and observe the expected saved result.')).toBe(true)
  })

  it('adopts a same-item deploy handoff in clean drafts without writing stale values on blur', async () => {
    const waitingForHandoff: WorkItem = {
      ...approvable,
      status: 'ready_for_deploy',
      blockedReason: 'deploy_approval',
      prUrl: '',
      branchName: '',
      deploymentTargets: ['firebase_hosting'],
      deploymentNotes: '',
    }
    state.data = [waitingForHandoff]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    expect((await screen.findAllByRole('button', { name: /Complete deploy notes/i })).length).toBeGreaterThan(0)

    state.data = [{
      ...waitingForHandoff,
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      branchName: 'sol/bug-147',
      deploymentNotes: validDeploymentNotes,
    }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => {
      expect(screen.getByLabelText('PR URL')).toHaveValue('https://github.com/example/repo/pull/42')
      expect(screen.getByLabelText('Branch')).toHaveValue('sol/bug-147')
      expect(screen.getByLabelText('Deploy notes')).toHaveValue(validDeploymentNotes)
    })
    expect((await screen.findAllByRole('button', { name: /Approve Firebase Hosting → deploy/i })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Complete deploy notes/i })).not.toBeInTheDocument()

    fireEvent.blur(screen.getByLabelText('PR URL'))
    fireEvent.blur(screen.getByLabelText('Branch'))
    fireEvent.blur(screen.getByLabelText('Deploy notes'))
    expect(firestore.updateDoc).not.toHaveBeenCalled()
  })

  it('preserves dirty delivery drafts across same-item server updates', async () => {
    const original: WorkItem = {
      ...approvable,
      status: 'ready_for_deploy',
      blockedReason: 'deploy_approval',
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      branchName: 'sol/original',
      deploymentTargets: ['firebase_hosting'],
      deploymentNotes: validDeploymentNotes,
    }
    state.data = [original]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await screen.findByLabelText('Deploy notes')

    fireEvent.change(screen.getByLabelText('PR URL'), { target: { value: 'https://github.com/example/repo/pull/local' } })
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'sol/local-edit' } })
    fireEvent.change(screen.getByLabelText('Deploy notes'), { target: { value: 'Local deploy-note edit' } })
    firestore.updateDoc.mockClear()

    state.data = [{
      ...original,
      title: 'Server-updated title',
      prUrl: 'https://github.com/example/repo/pull/43',
      branchName: 'sol/server-update',
      deploymentNotes: validDeploymentNotes.replaceAll('42', '43'),
    }]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    await waitFor(() => expect(screen.getAllByText('Server-updated title').length).toBeGreaterThan(0))
    expect(screen.getByLabelText('PR URL')).toHaveValue('https://github.com/example/repo/pull/local')
    expect(screen.getByLabelText('Branch')).toHaveValue('sol/local-edit')
    expect(screen.getByLabelText('Deploy notes')).toHaveValue('Local deploy-note edit')
    expect(firestore.updateDoc).not.toHaveBeenCalled()
  })

  it('turns an incomplete release handoff into an explanatory preparation action', async () => {
    state.data = [{ ...item, deploymentType: undefined, deploymentTargets: [], deploymentNotes: '' }]
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const buttons = await screen.findAllByRole('button', { name: /Select deployment target/i })
    expect(buttons).toHaveLength(2)
    buttons.forEach((button) => expect(button).toBeEnabled())
    expect(screen.getByText('Select at least one explicit deployment target.')).toBeInTheDocument()

    const deliveryCard = container.querySelector<HTMLDetailsElement>('.delivery-card')!
    deliveryCard.open = false
    scrollIntoView.mockClear()
    fireEvent.click(buttons[0])

    expect(deliveryCard).toHaveAttribute('open')
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Firebase Hosting' })).toHaveFocus())
    expect(firestore.updateDoc).not.toHaveBeenCalled()
  })

  it('keeps a complete release handoff as a single approval mutation', async () => {
    state.data = [{
      ...approvable,
      prNumber: 42,
      branchName: 'sol/fr-42',
      deploymentTargets: ['firebase_hosting'],
      deploymentNotes: validDeploymentNotes,
    }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: /Approve & send to deploy/i }))[0])

    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).toMatchObject({
      waitingOn: 'deployer',
      status: 'ready_for_deploy',
      blockedReason: null,
      deploymentApprovedTargets: ['firebase_hosting'],
      deploymentApprovedNotes: validDeploymentNotes,
      deploymentApprovedAt: 'server-timestamp',
      deploymentApprovedBy: 'owner@example.com',
    })
  })

  it('rejects notes for a different or superseded pull request', () => {
    const linked = { ...item, prNumber: 42, prUrl: 'https://github.com/example/repo/pull/42', branchName: 'sol/fr-42' }
    expect(deploymentApprovalIssue(linked, validDeploymentNotes)).toBeUndefined()
    expect(deploymentApprovalIssue(linked, validDeploymentNotes.replace('PR #42', 'PR #30'))).toContain('PR #30')
    expect(deploymentApprovalIssue({ ...linked, deploymentNotes: validDeploymentNotes, deploymentNotesPrNumber: 30 }, validDeploymentNotes)).toContain('PR #30')
    expect(deploymentApprovalIssue({ ...linked, deploymentNotes: validDeploymentNotes, deploymentNotesPrUrl: 'https://github.com/example/repo/pull/30' }, validDeploymentNotes)).toContain('URL changed')
    expect(deploymentApprovalIssue({ ...linked, deploymentNotes: validDeploymentNotes, deploymentNotesBranchName: 'sol/old-branch' }, validDeploymentNotes)).toContain('branch changed')
  })

  it('accepts deploy notes that identify the linked PR alongside an earlier implementation PR', () => {
    const linked = { ...item, prNumber: 43, prUrl: 'https://github.com/example/repo/pull/43', branchName: 'sol/fr-1' }
    expect(deploymentApprovalIssue(linked, multiPrDeploymentNotes)).toBeUndefined()
    expect(deploymentApprovalIssue(linked, multiPrDeploymentNotes.replaceAll('PR #43', 'PR #42'))).toContain('PR #42')
  })

  it('disables both deploy approval buttons when notes name a stale PR', async () => {
    state.data = [{
      ...item,
      assignedTo: 'sol-agent',
      status: 'in_review',
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      branchName: 'sol/fr-42',
      deploymentTargets: ['firebase_hosting'],
      deploymentNotes: validDeploymentNotes.replace('PR #42', 'PR #30'),
    }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const buttons = await screen.findAllByRole('button', { name: /Refresh deploy notes/i })
    expect(buttons).toHaveLength(2)
    buttons.forEach((button) => {
      expect(button).toBeEnabled()
      expect(button).toHaveAttribute('title', expect.stringContaining('PR #30'))
    })
    expect(screen.getByText(/Deploy notes name PR #30/)).toBeInTheDocument()
  })
})

describe('question choice answers', () => {
  const question: WorkItem = {
    ...item, assignedTo: 'sol-agent', status: 'blocked', blockedReason: 'question',
    messages: [{ author: 'Codex Sol', body: 'FR-1 — question: A) Keep the current workflow. B) Add a separate workflow.\nNext: reply A or B.', createdAt: null }],
  }

  it.each(['feature', 'bug'] as const)('records the selected answer and draft context before returning the %s to its agent', async (kind) => {
    if (kind === 'bug') usePhoneDetailLayout()
    state.data = [{ ...question, kind }]
    window.history.replaceState({}, '', `/admin/${kind === 'feature' ? 'features?item=FR' : 'bugs?item=BUG'}-1`)
    render(<WorkItems kind={kind} canManage actorEmail="Owner@example.com" />)
    const choice = kind === 'feature' ? 'A' : 'B'
    const label = choice === 'A' ? 'Keep the current workflow.' : 'Add a separate workflow.'
    fireEvent.change(await screen.findByLabelText('Add note'), { target: { value: '  Keep the existing history.  ' } })
    fireEvent.click(screen.getByRole('button', { name: `Choose ${choice}` }))

    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    const [reference, payload] = firestore.updateDoc.mock.calls[0] as [any, Record<string, any>]
    expect(reference.path).toBe('workItems/feature-1')
    expect(payload).toMatchObject({ waitingOn: 'agent', status: 'in_progress', blockedReason: null, claimedBy: null, leaseExpiresAt: null })
    expect(payload.messages.arrayUnion).toHaveLength(1)
    expect(payload.messages.arrayUnion[0]).toMatchObject({ authorEmail: 'owner@example.com', body: `${choice}) ${label}\n\nKeep the existing history.`, imageUrls: [] })
    expect(payload.messages.arrayUnion[0].createdAt).toBeInstanceOf(Timestamp)
  })

  it('answers a Markdown choice without typing a note or opening phone reply tools', async () => {
    usePhoneDetailLayout()
    state.data = [{ ...question, messages: [{ author: 'Claude Opus', body: 'Options:\n- **A)** Keep the current workflow.\n- **B)** Add a separate workflow.\n- **C)** Pause the work.\nNext: reply A, B, or C.', createdAt: null }] }]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose C' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).toMatchObject({ waitingOn: 'agent', messages: { arrayUnion: [expect.objectContaining({ body: 'C) Pause the work.' })] } })
  })

  it('keeps a human context note from replacing the latest agent choices', async () => {
    state.data = [{ ...question, messages: [...question.messages, { author: 'Owner', body: 'Please preserve older notes.', createdAt: null }] }]
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" actorName="Casey Collaborator" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose B' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).toMatchObject({ waitingOn: 'agent', messages: { arrayUnion: [expect.objectContaining({ author: 'Casey Collaborator', body: 'B) Add a separate workflow.' })] } })
  })

  it('preserves the selected filename when the agent formats an entire choice in bold', async () => {
    state.data = [{ ...question, messages: [{ author: 'Codex Sol', body: '- **A) Use `config.json`.**\n- **B)** Keep the current settings.\nNext: reply A or B.', createdAt: null }] }]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose A' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).toMatchObject({ messages: { arrayUnion: [expect.objectContaining({ body: 'A) Use config.json.' })] } })
  })

  it('does not offer stale, incomplete, or code-example choices', async () => {
    state.data = [question]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect(await screen.findByRole('button', { name: 'Choose A' })).toBeInTheDocument()
    for (const body of [
      'Which season should I use?',
      'A) Keep the current workflow.',
      'A) First choice. A) Duplicate choice. B) Second choice.',
      'Example only: `example A) first B) second`. Which season should I use?',
      'Example only:\n```\nA) Keep the current workflow.\nB) Add a separate workflow.\n```\nWhich season should I use?',
    ]) {
      state.data = [{ ...question, messages: [...question.messages, { author: 'Codex Sol', body, createdAt: null }] }]
      view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
      expect(screen.queryByRole('group', { name: 'Question choices' })).not.toBeInTheDocument()
    }
  })

  it('does not turn options in release, review, unassigned, or completed work into answers', async () => {
    state.data = [question]
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect(await screen.findByRole('button', { name: 'Choose A' })).toBeInTheDocument()
    for (const changes of [
      { blockedReason: 'deploy_approval', status: 'ready_for_deploy' },
      { blockedReason: 'acceptance_review' },
      { blockedReason: 'pr_review', status: 'in_review' },
      { assignedTo: '' },
      { waitingOn: 'agent', status: 'in_progress' },
      { status: 'shipped' },
    ]) {
      state.data = [{ ...question, ...changes }]
      view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
      expect(screen.queryByRole('group', { name: 'Question choices' })).not.toBeInTheDocument()
    }
  })

  it('disables both choices during a write and preserves the draft after a failed answer', async () => {
    let rejectWrite!: (error: Error) => void
    firestore.updateDoc.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { rejectWrite = reject }))
    state.data = [question]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.change(await screen.findByLabelText('Add note'), { target: { value: 'Context to keep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose A' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Choose A' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Choose B' })).toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose B' }))
    expect(firestore.updateDoc).toHaveBeenCalledTimes(1)
    await act(async () => rejectWrite(new Error('Answer could not be saved.')))
    expect(screen.getByText('Answer could not be saved.')).toBeInTheDocument()
    expect(screen.getByLabelText('Add note')).toHaveValue('Context to keep')
    expect(screen.getByRole('button', { name: 'Choose A' })).toBeEnabled()
  })
})

describe('one-tap approval', () => {
  it('offers the approval only on the gates that just need Project owner\'s go-ahead', () => {
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent', status: 'plan_review' })).toBe(true)
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent', status: 'in_review', prUrl: 'https://example.com/pr/1' })).toBe(true)
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent', status: 'blocked', blockedReason: 'question' })).toBe(true)
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent', status: 'ready_for_deploy' })).toBe(false)
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent', blockedReason: 'acceptance_review' })).toBe(false)
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent' })).toBe(false)
    expect(canApproveAndReturn({ ...item, blockedReason: 'question' })).toBe(false)
    expect(canApproveAndReturn({ ...item, assignedTo: 'sol-agent', waitingOn: 'agent', status: 'in_progress' })).toBe(false)
  })

  it('shows the chip in both action bars, not again beside the composer, for a PR review', async () => {
    state.data = [approvable]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: '✓ Approve → return to agent' })).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /Approve PR → Codex/i })).not.toBeInTheDocument()
  })

  it('keeps evidence-gated releases and acceptance away from the one-tap chip', async () => {
    state.data = [{ ...approvable, status: 'ready_for_deploy', blockedReason: 'deploy_approval', prNumber: 42, branchName: 'sol/fr-42', deploymentTargets: ['firebase_hosting'], deploymentNotes: validDeploymentNotes }]
    const { rerender } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /→ deploy/i })).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /Approve → return to agent/ })).not.toBeInTheDocument()

    state.data = [{ ...approvable, blockedReason: 'acceptance_review' }]
    rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    expect(screen.getAllByRole('button', { name: /Accept & mark shipped/i })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Approve → return to agent/ })).not.toBeInTheDocument()
  })

  it('leaves lifecycle approval to Project owner instead of a collaborator', async () => {
    state.data = [approvable]
    render(<WorkItems kind="feature" canManage={false} actorEmail="collaborator@example.com" actorName="Collaborator User" />)
    await waitFor(() => expect(screen.getByLabelText('Add note')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Approve → return to agent/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add & return to agent/i })).toBeInTheDocument()
  })

  it('posts the approval note and routes back to the agent in one write', async () => {
    state.data = [approvable]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: '✓ Approve → return to agent' }))[0])

    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    const payload = firestore.updateDoc.mock.calls[0][1] as Record<string, any>
    expect(payload).toMatchObject({ waitingOn: 'agent', status: 'in_progress', blockedReason: null, leaseExpiresAt: null, claimedBy: null, updatedAt: 'server-timestamp' })
    expect(payload.messages.arrayUnion).toHaveLength(1)
    const [note] = payload.messages.arrayUnion
    expect(note).toMatchObject({ author: 'Project owner', authorEmail: 'owner@example.com', body: APPROVAL_NOTE, imageUrls: [] })
    expect(messageRole(note.author)).toBe('human')
    expect(note.createdAt).toBeInstanceOf(Timestamp)
  })

  it('sends the composer draft with ⌘↵ and ignores the shortcut when empty', async () => {
    state.data = [approvable]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    const composer = await screen.findByLabelText('Add note')
    expect(composer).toHaveAttribute('placeholder', expect.stringContaining('⌘↵'))

    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true })
    expect(firestore.updateDoc).not.toHaveBeenCalled()

    fireEvent.change(composer, { target: { value: 'Looks right, keep going.' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(firestore.updateDoc).not.toHaveBeenCalled()

    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    const payload = firestore.updateDoc.mock.calls[0][1] as Record<string, any>
    expect(payload.messages.arrayUnion[0].body).toBe('Looks right, keep going.')
    expect(payload).toMatchObject({ waitingOn: 'agent', status: 'in_progress', blockedReason: null })
  })

  it('prefills the composer from a quick-reply chip', async () => {
    state.data = [approvable]
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Needs changes:' }))
    expect(screen.getByLabelText('Add note')).toHaveValue('Needs changes: ')

    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }))
    expect(screen.getByLabelText('Add note')).toHaveValue('Ship it')
    expect(quickReplyDraft('Approved, continue')).toBe('Approved, continue')
  })

  it('keeps the phone composer compact and exposes lifecycle actions inside optional tools', async () => {
    usePhoneDetailLayout()
    state.data = [approvable]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    const { container } = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    const composer = await screen.findByLabelText('Add note')
    expect(composer).toHaveAttribute('rows', '1')
    expect(container.querySelectorAll('.action-bar')).toHaveLength(2)
    expect(container.querySelector('.detail-actions-bottom')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '✓ Approve → return to agent' })).toHaveLength(2)
    expect(container.querySelector('.reply-tools')).not.toHaveAttribute('open')
    expect(container.querySelectorAll('.compact-reply-actions .button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Add & return to agent' })).toBeDisabled()
    expect(screen.getByLabelText('Choose attachments')).toBeInTheDocument()

    fireEvent.change(composer, { target: { value: '### Check\n**Ready**' } })
    expect(screen.getByRole('button', { name: 'Add & return to agent' })).toBeEnabled()
    fireEvent.click(screen.getByText('Reply tools', { exact: false }))
    const itemActions = within(screen.getByRole('region', { name: 'Item actions' }))
    expect(itemActions.getByRole('button', { name: '✓ Approve → return to agent' })).toBeInTheDocument()
    expect(itemActions.getByRole('button', { name: /Complete deploy notes/i })).toBeEnabled()
    expect(itemActions.getByRole('button', { name: '⏸ Hold' })).toBeInTheDocument()
    expect(itemActions.getByRole('button', { name: 'Decline' })).toBeInTheDocument()
    fireEvent.click(itemActions.getByRole('button', { name: /Utilities/i }))
    expect(itemActions.getByRole('button', { name: /Mark done \(no deployment\)/i })).toHaveAttribute('type', 'button')
    itemActions.getAllByRole('button').filter((button) => button.tagName === 'BUTTON').forEach((button) => expect(button).toHaveAttribute('type', 'button'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByLabelText('Note preview').querySelector('strong')).toHaveTextContent('Ready')

    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Choose attachments'), { target: { files: [file] } })
    expect(screen.getByText('notes.txt')).toBeInTheDocument()

    fireEvent.click(itemActions.getByRole('button', { name: /Complete deploy notes/i }))
    expect(container.querySelector('.reply-tools')).not.toHaveAttribute('open')
    expect(firestore.updateDoc).not.toHaveBeenCalled()
  })

  it('approves a current-plus-prior PR deploy handoff from the phone action', async () => {
    usePhoneDetailLayout()
    state.data = [{
      ...approvable,
      status: 'ready_for_deploy',
      waitingOn: 'human',
      blockedReason: 'deploy_approval',
      prNumber: 43,
      prUrl: 'https://github.com/example/repo/pull/43',
      branchName: 'sol/fr-1',
      deploymentTargets: ['firebase_hosting'],
      deploymentNotes: multiPrDeploymentNotes,
    }]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    const approvalActions = await screen.findAllByRole('button', { name: /Approve Firebase Hosting → deploy/i })
    expect(approvalActions).toHaveLength(2)
    approvalActions.forEach((button) => expect(button).toBeEnabled())
    expect(screen.queryByRole('button', { name: /Refresh deploy notes/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Reply tools', { exact: false }))
    const itemActions = within(screen.getByRole('region', { name: 'Item actions' }))
    fireEvent.click(itemActions.getByRole('button', { name: /Approve Firebase Hosting → deploy/i }))

    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).toMatchObject({
      waitingOn: 'deployer',
      status: 'ready_for_deploy',
      blockedReason: null,
      deploymentApprovedTargets: ['firebase_hosting'],
      deploymentApprovedNotes: multiPrDeploymentNotes,
      deploymentApprovedAt: 'server-timestamp',
      deploymentApprovedBy: 'owner@example.com',
    })
  })

  it.each([
    ['plan review', { ...item, assignedTo: 'sol-agent', status: 'plan_review', waitingOn: 'human', blockedReason: undefined }, /✓ Approve → return to agent/i],
    ['agent-held work', { ...item, assignedTo: 'sol-agent', status: 'in_progress', waitingOn: 'agent', blockedReason: undefined }, /Move to owner review/i],
    ['deploy-ready work', { ...item, assignedTo: 'sol-agent', status: 'ready_for_deploy', waitingOn: 'human', blockedReason: 'deploy_approval', prNumber: 42, prUrl: 'https://github.com/example/repo/pull/42', branchName: 'sol/fr-42', deploymentTargets: ['firebase_hosting'], deploymentNotes: validDeploymentNotes }, /Approve Firebase Hosting → deploy/i],
  ] as const)('exposes the current primary action at the phone thread bottom for %s', async (_label, currentItem, actionName) => {
    usePhoneDetailLayout()
    state.data = [currentItem]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)

    fireEvent.click(await screen.findByText('Reply tools', { exact: false }))
    expect(within(screen.getByRole('region', { name: 'Item actions' })).getByRole('button', { name: actionName })).toBeInTheDocument()
  })

  it('shares phone action busy state and never submits the reply form during a lifecycle write', async () => {
    usePhoneDetailLayout()
    let finishWrite!: () => void
    firestore.updateDoc.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishWrite = () => resolve(undefined) }))
    state.data = [{ ...approvable, waitingOn: 'agent', status: 'in_progress', blockedReason: undefined }]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.change(await screen.findByLabelText('Add note'), { target: { value: 'Draft must remain unsent' } })
    fireEvent.click(screen.getByText('Reply tools', { exact: false }))
    const itemActions = within(screen.getByRole('region', { name: 'Item actions' }))
    fireEvent.click(itemActions.getByRole('button', { name: '⏸ Hold' }))

    await waitFor(() => screen.getAllByRole('button', { name: '⏸ Hold' }).forEach((button) => expect(button).toBeDisabled()))
    expect(firestore.updateDoc).toHaveBeenCalledTimes(1)
    expect(firestore.updateDoc.mock.calls[0][1]).not.toHaveProperty('messages')
    finishWrite()
    await waitFor(() => screen.getAllByRole('button', { name: '⏸ Hold' }).forEach((button) => expect(button).toBeEnabled()))
  })

  it('uses the single phone composer action for note-only and return-to-agent paths', async () => {
    usePhoneDetailLayout()
    state.data = [{ ...approvable, waitingOn: 'agent', status: 'in_progress', blockedReason: undefined }]
    window.history.replaceState({}, '', '/admin/features?item=FR-1')
    const view = render(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.change(await screen.findByLabelText('Add note'), { target: { value: 'Progress note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).not.toHaveProperty('waitingOn')

    firestore.updateDoc.mockClear()
    state.data = [approvable]
    view.rerender(<WorkItems kind="feature" canManage actorEmail="owner@example.com" />)
    fireEvent.change(await screen.findByLabelText('Add note'), { target: { value: 'Needs one more pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add & return to agent' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    expect(firestore.updateDoc.mock.calls[0][1]).toMatchObject({ waitingOn: 'agent', status: 'in_progress', blockedReason: null })
  })
})

describe('a configured third work kind', () => {
  const task: WorkItem = {
    ...item, id: 'task-3', kind: 'task', number: 3, title: 'Rotate the staging key', status: 'in_review',
    waitingOn: 'human', blockedReason: 'pr_review', assignedTo: 'sol-agent', deploymentType: 'none', deploymentTargets: [],
    prUrl: 'https://github.com/example/project/pull/41', prNumber: 41,
  }
  const feature: WorkItem = { ...item, id: 'feature-9', number: 9, title: 'A feature in the same collection' }

  it('lists only its own kind with configured labels, references, and no deploy handoff', async () => {
    state.data = [task, feature]
    window.history.replaceState({}, '', '/admin/tasks')
    render(<WorkItems kind="task" canManage actorEmail="owner@example.com" />)
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByText('Chores and research')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New task/ })).toBeInTheDocument()
    expect((await screen.findAllByText('TASK-3')).length).toBeGreaterThan(0)
    expect(screen.queryByText('A feature in the same collection')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send to deploy/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Deploy notes')).not.toBeInTheDocument()
    expect(screen.getAllByText('PR handoff').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Decline' }).length).toBeGreaterThan(0)
  })

  it('closes after review through the no-deploy path with the kind\'s done status', async () => {
    state.data = [task]
    window.history.replaceState({}, '', '/admin/tasks?item=TASK-3')
    render(<WorkItems kind="task" canManage actorEmail="owner@example.com" />)
    fireEvent.click((await screen.findAllByRole('button', { name: '✓ Mark closed' }))[0])
    expect(screen.getByRole('dialog', { name: /Mark TASK-3 done without a deployment/i })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'Merged PR #41; nothing to release.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }))
    await waitFor(() => expect(firestore.updateDoc).toHaveBeenCalledTimes(1))
    const payload = firestore.updateDoc.mock.calls[0][1] as Record<string, unknown>
    expect(payload).toMatchObject({ status: 'closed', waitingOn: 'done', resolvedAt: 'server-timestamp' })
    expect(payload).not.toHaveProperty('shippedAt')
  })

  it('creates the item in workItems with its kind, initial status, and own counter', async () => {
    firestore.transactionSets.length = 0
    state.data = []
    render(<WorkItems kind="task" canManage actorEmail="owner@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /New task/ }))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Prune stale branches' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Delete merged agent branches older than 30 days.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create for review' }))
    await waitFor(() => expect(firestore.transactionSets).toHaveLength(2))
    const [counter, created] = firestore.transactionSets
    expect(counter).toMatchObject({ path: 'system/counters', data: { nextTaskNumber: 1 } })
    expect(created.path).toMatch(/^workItems\//)
    expect(created.data).toMatchObject({ kind: 'task', number: 1, status: 'open', waitingOn: 'human', blockedReason: 'triage' })
  })
})
