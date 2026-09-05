import { useEffect, useState } from 'react'
import { collection, doc, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { DEFAULT_DEPLOY_AGENT } from '../lib/agents'
import type { AgentLoopConfig, AgentLoopRun, AgentLoopUsage, AgentMachine } from '../lib/types'

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
  const [usage, setUsage] = useState<AgentLoopUsage>({ claude: null, codex: null })
  const [error, setError] = useState('')
  useEffect(() => onSnapshot(doc(db, 'system', 'agentLoopUsage'),
    (snapshot) => {
      const value = snapshot.data() as Partial<AgentLoopUsage> | undefined
      setUsage({ claude: value?.claude || null, codex: value?.codex || null })
      setError('')
    },
    (err) => setError(err.message),
  ), [])
  return { usage, error }
}
