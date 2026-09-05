// Stand-in for src/hooks/useLoopData.ts: fixture runs, machines, config, usage.
import { loopConfig, machines, runs, usage } from '../fixtures'

const slices = new Map<number, typeof runs>()

export function useLoopRuns(max = 100) {
  if (!slices.has(max)) slices.set(max, runs.slice(0, max))
  return { runs: slices.get(max)!, error: '' }
}

export function useMachines() {
  return { machines, error: '' }
}

export function useLoopConfig() {
  return { config: loopConfig, error: '' }
}

export function useLoopUsage() {
  return { usage, error: '' }
}
