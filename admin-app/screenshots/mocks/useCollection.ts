// Stand-in for src/hooks/useCollection.ts: fixture data, never loading.
import { bugs, features } from '../fixtures'

const collections: Record<string, unknown[]> = { featureRequests: features, bugs }

export function useCollection<T extends { id: string }>(path: string, _max = 250) {
  return { data: (collections[path] || []) as T[], loading: false, error: '' }
}
