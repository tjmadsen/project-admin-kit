import type { NotificationChannel, NotificationEventType, NotificationPreferences } from './types'

// Mirrors extras/functions/lib/preferences.js: the server resolves the same
// defaults when a user record has no stored preference, so the console shows
// exactly what will be delivered.
export const NOTIFICATION_EVENT_TYPES: NotificationEventType[] = [
  'action_required', 'deployment_failure', 'deployment_progress', 'final_outcome',
]
export const NOTIFICATION_CHANNELS: NotificationChannel[] = ['email', 'push']

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  action_required: 'Needs your action',
  deployment_failure: 'Deploy failed',
  deployment_progress: 'Deploy progress',
  final_outcome: 'Completed',
}
export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: 'Email',
  push: 'Push',
}

export type ResolvedNotificationPreferences = Record<NotificationChannel, Record<NotificationEventType, boolean>>

export const DEFAULT_NOTIFICATION_PREFERENCES: ResolvedNotificationPreferences = {
  email: { action_required: true, deployment_failure: false, deployment_progress: false, final_outcome: true },
  push: { action_required: true, deployment_failure: true, deployment_progress: true, final_outcome: true },
}

export function resolveNotificationPreferences(stored: NotificationPreferences | null | undefined): ResolvedNotificationPreferences {
  const resolved = {} as ResolvedNotificationPreferences
  for (const channel of NOTIFICATION_CHANNELS) {
    const channelStored = stored?.[channel]
    resolved[channel] = {} as Record<NotificationEventType, boolean>
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const value = channelStored?.[type]
      resolved[channel][type] = typeof value === 'boolean' ? value : DEFAULT_NOTIFICATION_PREFERENCES[channel][type]
    }
  }
  return resolved
}

export function withNotificationPreference(
  stored: NotificationPreferences | null | undefined,
  channel: NotificationChannel,
  type: NotificationEventType,
  enabled: boolean,
): ResolvedNotificationPreferences {
  const resolved = resolveNotificationPreferences(stored)
  return { ...resolved, [channel]: { ...resolved[channel], [type]: enabled } }
}

export function summarizeNotificationPreferences(stored: NotificationPreferences | null | undefined) {
  const resolved = resolveNotificationPreferences(stored)
  return NOTIFICATION_CHANNELS.map((channel) => {
    const enabled = NOTIFICATION_EVENT_TYPES.filter((type) => resolved[channel][type]).length
    return `${NOTIFICATION_CHANNEL_LABELS[channel]} ${enabled}/${NOTIFICATION_EVENT_TYPES.length}`
  }).join(' · ')
}
