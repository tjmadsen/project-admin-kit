// Deploy targets as the console sees them. Mirrors scripts/lib/deploy-targets.js:
// `deployments.targets` entries merge over the built-in definition with the same
// id; the legacy boolean map (and an absent block) means every built-in target;
// `none` is reserved and always last.
import builtInTargets from '../../../scripts/lib/deploy-targets.defaults.json'
import { projectConfig, type DeployTargetConfig, type DeploymentsConfig } from './project-config'
import type { WorkItem } from './types'

export interface DeployTargetDefinition {
  id: string
  label: string
  runbook: string
  requiresHumanAcceptance: boolean
  enabled: boolean
}

const builtIns = builtInTargets as Record<string, DeployTargetConfig>
const RESERVED_TARGET = 'none'

function definition(id: string, raw: DeployTargetConfig = {}): DeployTargetDefinition {
  const merged = { ...builtIns[id], ...raw }
  if (!/^[a-z][a-z0-9_]*$/.test(id) || !merged.label || !merged.runbook) throw new Error(`deployments.targets.${id} needs a valid id, label, and runbook`)
  return { id, label: merged.label, runbook: merged.runbook, requiresHumanAcceptance: merged.requiresHumanAcceptance === true, enabled: merged.enabled !== false }
}

export function resolveDeployTargets(deployments?: DeploymentsConfig): DeployTargetDefinition[] {
  const configured = deployments && 'targets' in deployments && deployments.targets && typeof deployments.targets === 'object'
    ? deployments.targets as Record<string, DeployTargetConfig>
    : null
  const targets = configured
    ? Object.entries(configured).filter(([id]) => id !== RESERVED_TARGET).map(([id, raw]) => definition(id, raw))
    : Object.keys(builtIns).filter((id) => id !== RESERVED_TARGET).map((id) => definition(id))
  return [...targets, definition(RESERVED_TARGET)]
}

export const DEPLOY_TARGET_DEFINITIONS = resolveDeployTargets(projectConfig.deployments)
/** Every configured target id, enabled or not, in display order. */
export const DEPLOYMENT_TARGETS = DEPLOY_TARGET_DEFINITIONS.map((target) => target.id)

export function deployTargetDefinition(id: string, targets = DEPLOY_TARGET_DEFINITIONS) {
  return targets.find((target) => target.id === id)
}

/** Targets the picker offers: enabled ones plus any already selected on the item. */
export function pickerDeploymentTargets(selected: string[], targets = DEPLOY_TARGET_DEFINITIONS): DeployTargetDefinition[] {
  return targets.filter((target) => target.enabled || selected.includes(target.id))
}

export function normalizeDeploymentTargets(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : []
  const unique = [...new Set(raw.map((target) => String(target).trim()).filter((target) => DEPLOYMENT_TARGETS.includes(target)))]
  if (unique.includes(RESERVED_TARGET) && unique.length > 1) return [RESERVED_TARGET]
  return DEPLOYMENT_TARGETS.filter((target) => unique.includes(target))
}

export function deploymentTargetsFor(item: Pick<WorkItem, 'deploymentTargets' | 'deploymentType' | 'deploymentApprovedTargets'>, approved = false): string[] {
  if (approved && item.deploymentApprovedTargets?.length) return normalizeDeploymentTargets(item.deploymentApprovedTargets)
  if (item.deploymentTargets?.length) return normalizeDeploymentTargets(item.deploymentTargets)
  if (item.deploymentType && item.deploymentType !== 'mixed') return normalizeDeploymentTargets([item.deploymentType])
  return []
}

export function legacyDeploymentType(targets: string[]): string {
  const normalized = normalizeDeploymentTargets(targets)
  if (normalized.length === 0) return 'none'
  return normalized.length === 1 ? normalized[0] : 'mixed'
}
