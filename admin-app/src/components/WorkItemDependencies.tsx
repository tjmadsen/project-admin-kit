import { useMemo, useState } from 'react'
import { itemRef } from '../lib/format'
import type { WorkItem } from '../lib/types'
import { WORK_KINDS, workKind } from '../lib/work-kinds'

export interface DependencyView {
  id: string
  item?: WorkItem
}

function dependencyIds(item: WorkItem) {
  return [...new Set((item.dependsOn || []).filter(Boolean))]
}

function workItemIndex(items: WorkItem[]) {
  return new Map(items.map((item) => [item.id, item]))
}

export function dependencyIsComplete(item?: WorkItem) {
  // Only the kind's done status (shipped, closed) satisfies a prerequisite.
  const kind = workKind(item?.kind)
  return Boolean(item && kind && item.status === kind.statuses.done)
}

export function blockingDependencies(item: WorkItem, allItems: WorkItem[]): DependencyView[] {
  const byId = workItemIndex(allItems)
  return dependencyIds(item)
    .map((id) => ({ id, item: byId.get(id) }))
    .filter((dependency) => !dependencyIsComplete(dependency.item))
}

export function wouldCreateDependencyCycle(itemId: string, candidateId: string, allItems: WorkItem[]) {
  const byId = workItemIndex(allItems)
  const visited = new Set<string>()
  const reachesItem = (id: string): boolean => {
    if (id === itemId) return true
    if (visited.has(id)) return false
    visited.add(id)
    const candidate = byId.get(id)
    return candidate ? dependencyIds(candidate).some(reachesItem) : false
  }
  return reachesItem(candidateId)
}

function reference(dependency: DependencyView) {
  return dependency.item ? itemRef(dependency.item.kind, dependency.item.number) : 'Missing item'
}

export function dependencyWaitLabel(item: WorkItem, allItems: WorkItem[]) {
  const blockers = blockingDependencies(item, allItems)
  return blockers.length > 0 ? `Waiting on ${blockers.map(reference).join(', ')}` : ''
}

function statusLabel(item?: WorkItem) {
  return item ? item.status.replaceAll('_', ' ') : 'not found'
}

function DependencyChip({ dependency, removable, disabled, onRemove, onSelectItem }: { dependency: DependencyView; removable: boolean; disabled: boolean; onRemove: () => void; onSelectItem?: (item: WorkItem) => void }) {
  const complete = dependencyIsComplete(dependency.item)
  return <li className={`dependency-chip ${complete ? 'complete' : 'pending'} ${dependency.item ? '' : 'missing'}`}>
    <span>
      {dependency.item && onSelectItem
        ? <button type="button" className="chip-ref-button" onClick={() => onSelectItem(dependency.item!)}><strong>{reference(dependency)}</strong></button>
        : <strong>{reference(dependency)}</strong>}
      <small>{dependency.item?.title || dependency.id}</small>
    </span>
    <em>{statusLabel(dependency.item)}</em>
    {removable && <button type="button" aria-label={`Remove ${reference(dependency)} dependency`} disabled={disabled} onClick={onRemove}>×</button>}
  </li>
}

export default function WorkItemDependencies({ item, allItems, canManage, disabled, onChange, onSelectItem }: {
  item: WorkItem
  allItems: WorkItem[]
  canManage: boolean
  disabled: boolean
  onChange: (dependsOn: string[]) => void
  onSelectItem?: (item: WorkItem) => void
}) {
  const [query, setQuery] = useState('')
  const [warning, setWarning] = useState('')
  const byId = useMemo(() => workItemIndex(allItems), [allItems])
  const dependencies = dependencyIds(item).map((id) => ({ id, item: byId.get(id) }))
  const blockers = dependencies.filter((dependency) => !dependencyIsComplete(dependency.item))
  const dependents = allItems
    .filter((candidate) => candidate.id !== item.id && dependencyIds(candidate).includes(item.id))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number)
  const normalizedQuery = query.trim().toLowerCase()
  const matches = normalizedQuery ? allItems
    .filter((candidate) => candidate.id !== item.id && !dependencyIds(item).includes(candidate.id))
    .filter((candidate) => `${itemRef(candidate.kind, candidate.number)} ${candidate.title}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number)
    .slice(0, 8) : []

  const addDependency = (candidate: WorkItem) => {
    if (wouldCreateDependencyCycle(item.id, candidate.id, allItems)) {
      setWarning(`${itemRef(candidate.kind, candidate.number)} already leads back to ${itemRef(item.kind, item.number)}. Adding it would create a dependency cycle.`)
      setQuery('')
      return
    }
    setWarning('')
    setQuery('')
    onChange([...dependencyIds(item), candidate.id])
  }
  const removeDependency = (id: string) => {
    setWarning('')
    onChange(dependencyIds(item).filter((candidateId) => candidateId !== id))
  }

  return <section className="dependency-card">
    <div className="dependency-heading"><div><p className="eyebrow">Scheduling</p><h3>Dependencies</h3></div>{blockers.length > 0 ? <strong>{dependencyWaitLabel(item, allItems)}</strong> : dependencies.length > 0 ? <strong className="ready">Prerequisites complete</strong> : null}</div>
    {dependencies.length > 0 ? <ul className="dependency-list">{dependencies.map((dependency) => <DependencyChip key={dependency.id} dependency={dependency} removable={canManage} disabled={disabled} onRemove={() => removeDependency(dependency.id)} onSelectItem={onSelectItem} />)}</ul> : <p className="muted">No prerequisites. This item can enter an agent queue immediately.</p>}
    {canManage && <div className="dependency-picker">
      <label>Find a prerequisite<input aria-label="Find a prerequisite" placeholder={`Search ${WORK_KINDS.slice(0, 2).map((kind, index) => `${kind.prefix}-${index === 0 ? 7 : 2}`).join(', ')}, or a title…`} value={query} disabled={disabled} onChange={(event) => { setQuery(event.target.value); setWarning('') }} /></label>
      {matches.length > 0 && <div className="dependency-results">{matches.map((candidate) => {
        const createsCycle = wouldCreateDependencyCycle(item.id, candidate.id, allItems)
        return <button type="button" key={candidate.id} disabled={disabled} onClick={() => addDependency(candidate)}><span><strong>{itemRef(candidate.kind, candidate.number)}</strong>{candidate.title}</span><small>{createsCycle ? 'Creates cycle' : statusLabel(candidate)}</small></button>
      })}</div>}
      {normalizedQuery && matches.length === 0 && <p className="muted">No matching work items.</p>}
      {warning && <p className="dependency-warning" role="alert">{warning}</p>}
    </div>}
    <div className="dependent-items"><h4>Items that depend on this</h4>{dependents.length > 0 ? <div>{dependents.map((dependent) => onSelectItem
      ? <button type="button" key={dependent.id} onClick={() => onSelectItem(dependent)}><strong>{itemRef(dependent.kind, dependent.number)}</strong>{dependent.title}</button>
      : <span key={dependent.id}><strong>{itemRef(dependent.kind, dependent.number)}</strong>{dependent.title}</span>)}</div> : <p className="muted">No items depend on this one.</p>}</div>
  </section>
}
