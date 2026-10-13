import { useEffect, useState } from 'react'
import { collection, doc, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { DEFAULT_DEPLOY_AGENT } from '../lib/agents'
import type { AgentLoopConfig, AgentLoopRun, AgentLoopUsage, AgentLoopUsageEntry, AgentMachine } from '../lib/types'

/** Usage by provider: claude and codex today, plus any configured usage hook. */
export type LoopUsage = AgentLoopUsage & Record<string, AgentLoopUsageEntry | null>

export function useLoopRuns(max = 100) {
  const [runs, setRuns] = useState<AgentLoopRun[]>([])
  const [error, setError] = useState('')
  useEffect(() => onSnapshot(
    query(collection(db, 'agentLoopRuns'), orderBy('startedAt', 'desc'), limit(max)),
    (snapshot) => { setRuns(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as AgentLoopRun)); setError('') },
    (err) => setError(err.message),
  ), [max])
  return { runs, error }
}

export function useMachines() {
  const [machines, setMachines] = useState<AgentMachine[]>([])
  const [error, setError] = useState('')
  useEffect(() => onSnapshot(collection(db, 'agentMachines'),
    (snapshot) => { setMachines(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as AgentMachine)); setError('') },
    (err) => setError(err.message),
  ), [])
  return { machines, error }
}

export function useLoopConfig() {
  const [config, setConfig] = useState<AgentLoopConfig>({ deployAgent: DEFAULT_DEPLOY_AGENT })
  const [error, setError] = useState('')
  useEffect(() => onSnapshot(doc(db, 'system', 'agentLoopConfig'),
    (snapshot) => {
      const value = snapshot.data() as Partial<AgentLoopConfig> | undefined
      setConfig({ deployAgent: value?.deployAgent || DEFAULT_DEPLOY_AGENT, updatedAt: value?.updatedAt })
      setError('')
    },
    (err) => setError(err.message),
  ), [])
  return { config, error }
}

export function useLoopUsage() {
  const [usage, setUsage] = useState<LoopUsage>({ claude: null, codex: null })
  const [error, setError] = useState('')
  useEffect(() => onSnapshot(doc(db, 'system', 'agentLoopUsage'),
    (snapshot) => {
      const value = snapshot.data() as Partial<LoopUsage> | undefined
      setUsage({ ...value, claude: value?.claude || null, codex: value?.codex || null })
      setError('')
    },
    (err) => setError(err.message),
  ), [])
  return { usage, error }
}
