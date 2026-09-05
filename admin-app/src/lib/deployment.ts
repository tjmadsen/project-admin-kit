import type { WorkItem } from './types'

export const DEPLOYMENT_TARGETS = [
  'testflight',
  'firebase_hosting',
  'firebase_functions',
  'firebase_rules_indexes',
  'vercel',
  'flutter_web',
  'cloud_run',
  'none',
] as const

export function normalizeDeploymentTargets(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : []
  const unique = [...new Set(raw.map((target) => String(target).trim()).filter((target) => DEPLOYMENT_TARGETS.includes(target as typeof DEPLOYMENT_TARGETS[number])))]
  if (unique.includes('none') && unique.length > 1) return ['none']
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
