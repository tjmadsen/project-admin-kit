// Deterministic backlog data for the screenshot harness. Timestamps are
// relative to page load so "2h ago" labels stay stable between captures.
import type { AgentLoopConfig, AgentLoopRun, AgentLoopUsage, AgentMachine, WorkItem, WorkMessage } from '../src/lib/types'

const NOW_SECONDS = Math.round(Date.now() / 1000)
const MIN = 60
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function ts(secondsAgo: number) {
  const seconds = NOW_SECONDS - secondsAgo
  return { seconds, nanoseconds: 0, toDate: () => new Date(seconds * 1000) }
}

function note(author: string, body: string, secondsAgo: number, extra: Partial<WorkMessage> = {}): WorkMessage {
  return { author, body, createdAt: ts(secondsAgo), imageUrls: [], ...extra }
}

const tj = { authorEmail: 'owner@example.com' }

const featureBase = {
  kind: 'feature' as const,
  thinkingEffort: 'xhigh' as const,
  targetMachine: 'local-mac',
  deploymentType: 'none',
  deploymentTargets: [] as string[],
  imageUrls: [] as string[],
  createdByEmail: 'owner@example.com',
  createdByRole: 'admin' as const,
}

export const features: WorkItem[] = [
  {
    ...featureBase, id: 'fr-25', number: 25, priority: 'high',
    title: 'Mark items done without a deployment',
    description: 'Add a "Mark done (no deployment)" action for audits, research, docs-only changes and duplicates. The close note lands in the thread and the item ships with no deployment timestamps. Refuse while any release scope is planned, approved, queued or in flight.',
    status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review', assignedTo: 'fable-agent',
    prUrl: 'https://github.com/example/project/pull/27', prNumber: 27, branchName: 'fable/fr-25',
    deploymentType: 'firebase_hosting', deploymentTargets: ['firebase_hosting'],
    deploymentNotes: 'Scope: admin console close-without-deploy action plus the feature-agent close-no-deploy command.\nCommands: cd admin-app && npm ci && npm test && npm run build; firebase deploy --only hosting --project example-project\nVerification: https://example.com/admin/features shows "Mark done (no deployment)" under More actions for an item with no release scope.\nAcceptance: Project owner closes a docs-only item and it reads shipped with the note in the thread and no deployment timestamps.',
    createdAt: ts(2 * DAY), updatedAt: ts(25 * MIN),
    messages: [
      note('Claude Fable', 'Created FR-25.', 2 * DAY),
      note('Project owner', '✅ Approved — please continue.', DAY + 6 * HOUR, tj),
      note('Claude Fable', 'Implemented close-no-deploy in scripts/feature-agent.js and the admin action menu. It refuses while any release scope is planned, approved, queued or in flight. 92 admin tests pass and the public/admin bundle is rebuilt. PR #27 is open for review.', 3 * HOUR),
      note('Project owner', 'Looks right. Does the confirm modal explain that the planned release scope will be skipped?', 2 * HOUR, tj),
      note('Claude Fable', 'Yes: when a release scope is still planned the modal switches to "Skip release & mark done" and names the targets, e.g. "Firebase Hosting". Screenshot attached in the PR description.', 25 * MIN),
    ],
  },
  {
    ...featureBase, id: 'fr-21', number: 21, priority: 'medium',
    title: 'Worktree provisioning, roster enforcement, and loop doctrine',
    description: 'Provision fresh .agent-worktrees checkouts with the gitignored local state the primary checkout already has, enforce the agent roster in run-loop.sh, and record the doctrine in the loop README.',
    status: 'ready_for_deploy', waitingOn: 'human', assignedTo: 'sol-agent',
    prUrl: 'https://github.com/example/project/pull/33', prNumber: 33, branchName: 'sol/fr-21',
    deploymentType: 'mixed', deploymentTargets: ['vercel', 'flutter_web'],
    deploymentNotes: 'Scope: loop runner scripts and the Flutter web bundle.\nCommands: ./build_and_deploy.sh on the merged master.\nVerification: Vercel status success on the merge SHA; main.dart.js hash matches.\nAcceptance: run-loop.sh refuses an unknown agent name and the web app still loads the roster tab.',
    createdAt: ts(3 * DAY), updatedAt: ts(52 * MIN),
    messages: [
      note('Codex Sol', 'Created FR-21.', 3 * DAY),
      note('Codex Sol', 'PR #33 ready: provision-worktree.sh, roster-check.js, 12 new node tests.', 4 * HOUR),
      note('Project owner', 'Ship it', 52 * MIN, tj),
    ],
  },
  {
    ...featureBase, id: 'fr-24', number: 24, priority: 'medium',
    title: 'Admin app: pull-to-refresh and notification deep links',
    description: 'Native Project Admin wrapper reloads the console on pull-to-refresh and opens the item referenced by a push notification.',
    status: 'in_review', waitingOn: 'human', blockedReason: 'acceptance_review', assignedTo: 'opus-agent',
    prUrl: 'https://github.com/example/project/pull/30', prNumber: 30, branchName: 'opus/fr-24',
    deploymentType: 'testflight', deploymentTargets: ['testflight'], deploymentApprovedTargets: ['testflight'], deploymentApprovedAt: ts(5 * HOUR), deploymentApprovedBy: 'owner@example.com',
    deploymentBuild: '2026.09.02.1417', deploymentResult: 'TestFlight build 2026.09.02.1417 is VALID',
    deploymentEvidence: { testflight: { proof: 'App Store Connect build 2026.09.02.1417 VALID at 14:31', acceptance: 'Awaiting Project owner hands-on check of pull-to-refresh and a notification tap', verifiedAt: ts(4 * HOUR), verifiedBy: 'sonnet' } },
    createdAt: ts(4 * DAY), updatedAt: ts(4 * HOUR),
    messages: [
      note('Claude Opus', 'Created FR-24.', 4 * DAY),
      note('Claude Sonnet', 'TestFlight build 2026.09.02.1417 uploaded and VALID. Returning for hands-on acceptance.', 4 * HOUR),
    ],
  },
  {
    ...featureBase, id: 'fr-19', number: 19, priority: 'low',
    title: 'Scoreboard: show bye-week teams in a collapsed strip',
    description: 'Teams on bye currently disappear from the scoreboard tab. Show them in a collapsed strip at the bottom with their next opponent.',
    status: 'blocked', waitingOn: 'human', blockedReason: 'question', assignedTo: 'sol-agent',
    createdAt: ts(5 * DAY), updatedAt: ts(7 * HOUR),
    messages: [
      note('Project owner', 'Created FR-19.', 5 * DAY, tj),
      note('Codex Sol', 'Two options for the bye strip: (A) always collapsed with a count badge, or (B) expanded when fewer than three teams are on bye. Which do you prefer?', 7 * HOUR),
    ],
  },
  {
    ...featureBase, id: 'fr-23', number: 23, priority: 'medium',
    title: 'Roster tab: highlight players in the injury report',
    description: 'Pull the ESPN injury designations into the roster list so questionable and out players are flagged before lineups lock.',
    status: 'backlog', waitingOn: 'human', blockedReason: 'triage', assignedTo: '',
    createdByEmail: 'collaborator@example.com', createdByRole: 'collaborator',
    createdAt: ts(9 * HOUR), updatedAt: ts(9 * HOUR),
    messages: [note('Collaborator User', 'Created FR-23.', 9 * HOUR, { authorEmail: 'collaborator@example.com' })],
  },
  {
    ...featureBase, id: 'fr-22', number: 22, priority: 'medium',
    title: 'Project Admin: dark mode (system preference + manual toggle)',
    description: 'Tokenise the admin palette, add a dark palette under data-theme, follow prefers-color-scheme when the stored preference is system, and add a three-way toggle to the sidebar account block.',
    status: 'in_progress', waitingOn: 'agent', assignedTo: 'fable-agent', claimedBy: 'fable', leaseExpiresAt: ts(-40 * MIN),
    deploymentType: 'firebase_hosting', deploymentTargets: ['firebase_hosting'],
    createdAt: ts(DAY), updatedAt: ts(12 * MIN),
    messages: [
      note('Claude Fable', 'Created FR-22.', DAY),
      note('Project owner', '✅ Approved — please continue.', 6 * HOUR, tj),
    ],
  },
  {
    ...featureBase, id: 'fr-20', number: 20, priority: 'high',
    title: 'Matchup tab: live win probability sparkline',
    description: 'Render a small sparkline of the projected margin over the game window using the live scoring feed.',
    status: 'in_progress', waitingOn: 'agent', assignedTo: 'opus-agent',
    createdAt: ts(2 * DAY), updatedAt: ts(3 * HOUR),
    messages: [note('Project owner', 'Created FR-20.', 2 * DAY, tj)],
  },
  {
    ...featureBase, id: 'fr-18', number: 18, priority: 'medium',
    title: 'Admin: advance the work list after a hand-back',
    description: 'After approving or returning an item, select the next item in the filtered list instead of dropping back to the empty state.',
    status: 'ready_for_deploy', waitingOn: 'deployer', assignedTo: 'terra-agent',
    prUrl: 'https://github.com/example/project/pull/29', prNumber: 29, branchName: 'terra/fr-18',
    deploymentType: 'firebase_hosting', deploymentTargets: ['firebase_hosting'], deploymentApprovedTargets: ['firebase_hosting'], deploymentApprovedAt: ts(40 * MIN), deploymentApprovedBy: 'owner@example.com',
    deploymentNotes: 'Scope: admin console list navigation.\nCommands: cd admin-app && npm ci && npm test && npm run build; firebase deploy --only hosting --project example-project\nVerification: https://example.com/admin/features advances to the next card after Approve.\nAcceptance: approving an item selects the next filtered item.',
    createdAt: ts(3 * DAY), updatedAt: ts(40 * MIN),
    messages: [note('Codex Terra', 'PR #29 opened.', 6 * HOUR), note('Project owner', 'Approved for deploy.', 40 * MIN, tj)],
  },
  {
    ...featureBase, id: 'fr-17', number: 17, priority: 'critical',
    title: 'Standings: playoff seeding tie-breakers',
    description: 'Apply the configured tie-breaker rules when ranking launch candidates.',
    status: 'in_progress', waitingOn: 'hold', assignedTo: 'grok-agent',
    createdAt: ts(6 * DAY), updatedAt: ts(DAY),
    messages: [note('Project owner', 'On hold until the playoff bracket format is confirmed.', DAY, tj)],
  },
  {
    ...featureBase, id: 'fr-16', number: 16, priority: 'medium',
    title: 'Deploy loop: record live proof per target',
    description: 'Every approved target records a proof string and acceptance note before the item can be shipped.',
    status: 'shipped', waitingOn: 'done', assignedTo: 'opus-agent',
    prUrl: 'https://github.com/example/project/pull/26', prNumber: 26, branchName: 'opus/fr-16',
    deploymentType: 'none', deploymentTargets: ['none'], resolution: 'Merged commit a5aa163 is present on origin/main; no runtime surface is required.',
    createdAt: ts(7 * DAY), updatedAt: ts(2 * DAY),
    messages: [note('Claude Opus', 'Shipped with merge a5aa163.', 2 * DAY)],
  },
  {
    ...featureBase, id: 'fr-14', number: 14, priority: 'low',
    title: 'Port legacy admin dashboard widgets',
    description: 'Audit of a legacy admin console for widgets worth porting. Superseded by the individual follow-ups filed from the audit.',
    status: 'declined', waitingOn: 'done', assignedTo: 'fable-agent',
    createdAt: ts(8 * DAY), updatedAt: ts(3 * DAY),
    messages: [note('Project owner', 'Declining the umbrella item; the follow-ups carry the work.', 3 * DAY, tj)],
  },
]

const bugBase = { ...featureBase, kind: 'bug' as const }

export const bugs: WorkItem[] = [
  {
    ...bugBase, id: 'bug-9', number: 9, priority: 'high',
    title: 'Headless guard blocks quoted destructive tokens in reply text',
    description: 'The PreToolUse guard matches blocked patterns anywhere in the command string, so a reply that merely mentions a forced push is denied.',
    status: 'plan_review', waitingOn: 'human', assignedTo: 'opus-agent',
    createdAt: ts(2 * DAY), updatedAt: ts(5 * HOUR),
    messages: [note('Claude Opus', 'Plan: anchor the patterns at command position and fail open with an explanation. Two regression tests.', 5 * HOUR)],
  },
  {
    ...bugBase, id: 'bug-10', number: 10, priority: 'critical',
    title: 'Live scores stop updating after the app returns from background',
    description: 'On iOS the ESPN polling timer is not restarted after the app resumes, so the matchup tab shows stale scores until a manual refresh.',
    status: 'in_progress', waitingOn: 'agent', assignedTo: 'sonnet-agent',
    createdAt: ts(DAY), updatedAt: ts(2 * HOUR),
    messages: [note('Project owner', 'Created BUG-10.', DAY, tj)],
  },
  {
    ...bugBase, id: 'bug-8', number: 8, priority: 'medium',
    title: 'Overview tab flickers when switching workspaces',
    description: 'Switching workspaces briefly renders the previous workspace before the new data loads.',
    status: 'open', waitingOn: 'human', blockedReason: 'triage', assignedTo: '',
    createdByEmail: 'collaborator@example.com', createdByRole: 'collaborator',
    createdAt: ts(11 * HOUR), updatedAt: ts(11 * HOUR),
    messages: [note('Collaborator User', 'Created BUG-8.', 11 * HOUR, { authorEmail: 'collaborator@example.com' })],
  },
  {
    ...bugBase, id: 'bug-7', number: 7, priority: 'high',
    title: 'Player list fails to load on a slow connection',
    description: 'The player list request times out and the app shows an empty roster instead of retrying.',
    status: 'closed', waitingOn: 'done', assignedTo: 'sol-agent',
    prUrl: 'https://github.com/example/project/pull/24', prNumber: 24, branchName: 'sol/bug-7',
    deploymentType: 'testflight', deploymentTargets: ['testflight'], resolution: 'Accepted by Project owner after deployment verification.',
    createdAt: ts(9 * DAY), updatedAt: ts(4 * DAY),
    messages: [note('Codex Sol', 'Fix shipped in TestFlight build 2026.09.01.0912.', 4 * DAY)],
  },
]

export const runs: AgentLoopRun[] = [
  { id: 'run-1', agent: 'fable', queue: 'feature', machineId: 'local-mac', status: 'running', activeItem: 'FR-22', activeItemId: 'feature-22', activeCollection: 'featureRequests', thinkingEffort: 'high', startedAt: ts(90 * MIN), heartbeatAt: ts(40), progressAt: ts(2 * MIN), progressSummary: 'Implementation is complete. Running the focused Flutter widget tests before the PR handoff.' },
  { id: 'run-2', agent: 'sonnet', queue: 'deploy', machineId: 'local-mac', status: 'completed', activeItem: 'FR-18', startedAt: ts(55 * MIN), heartbeatAt: ts(41 * MIN), finishedAt: ts(41 * MIN), durationSeconds: 840, exitCode: 0, summary: 'Merged PR #29, deployed firebase_hosting, live proof recorded, FR-18 shipped.' },
  { id: 'run-3', agent: 'sol', queue: 'feature', machineId: 'local-mac', status: 'completed', activeItem: 'FR-21', startedAt: ts(4 * HOUR), heartbeatAt: ts(3 * HOUR), finishedAt: ts(3 * HOUR), durationSeconds: 2460, exitCode: 0, summary: 'PR #33 opened and recorded; item handed to pr_review.' },
  { id: 'run-4', agent: 'opus', queue: 'bug', machineId: 'local-mac', status: 'completed', activeItem: 'BUG-9', startedAt: ts(6 * HOUR), heartbeatAt: ts(5 * HOUR), finishedAt: ts(5 * HOUR), durationSeconds: 1120, exitCode: 0, summary: 'Investigation complete; plan posted for review.' },
  { id: 'run-5', agent: 'grok', queue: 'feature', machineId: 'local-mac', status: 'failed', activeItem: 'FR-17', startedAt: ts(8 * HOUR), heartbeatAt: ts(8 * HOUR - 300), finishedAt: ts(8 * HOUR - 300), durationSeconds: 300, exitCode: 1, summary: 'Provider rate limit reached before the worktree was provisioned.' },
  { id: 'run-6', agent: 'terra', queue: 'feature', machineId: 'local-mac', status: 'completed', startedAt: ts(10 * HOUR), heartbeatAt: ts(10 * HOUR - 90), finishedAt: ts(10 * HOUR - 90), durationSeconds: 90, exitCode: 0, summary: 'No claimable feature work; exiting.' },
  { id: 'run-7', agent: 'luna', queue: 'bug', machineId: 'local-mac', status: 'completed', startedAt: ts(12 * HOUR), heartbeatAt: ts(12 * HOUR - 70), finishedAt: ts(12 * HOUR - 70), durationSeconds: 70, exitCode: 0, summary: 'No claimable bug work; exiting.' },
  { id: 'run-8', agent: 'sonnet', queue: 'deploy', machineId: 'local-mac', status: 'completed', activeItem: 'FR-24', startedAt: ts(DAY), heartbeatAt: ts(DAY - 1500), finishedAt: ts(DAY - 1500), durationSeconds: 1500, exitCode: 0, summary: 'TestFlight upload complete; build VALID; returned to acceptance_review.' },
]

export const machines: AgentMachine[] = [
  { id: 'local-mac', label: 'Local Mac', hostname: 'project-mac.local', status: 'online', repoRoot: '/Users/example/Development/project', agents: ['sol', 'terra', 'luna', 'opus', 'sonnet', 'fable', 'grok'], lastSeenAt: ts(45) },
]

export const loopConfig: AgentLoopConfig = { deployAgent: 'sonnet', updatedAt: ts(3 * DAY) }

export const usage: AgentLoopUsage = {
  claude: { usedPercent: 74, capturedAt: ts(9 * MIN), lastAttemptAt: ts(9 * MIN), resetsLabel: 'Sat 9:00 AM', captureStatus: 'available', captureCliVersion: '2.1.0' },
  codex: { usedPercent: 31, capturedAt: ts(4 * MIN), lastAttemptAt: ts(4 * MIN), resetsLabel: 'Sun 12:00 AM', captureStatus: 'available' },
}
