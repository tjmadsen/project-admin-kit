import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_TARGETS, deploymentTargetsFor, legacyDeploymentType, normalizeDeploymentTargets, pickerDeploymentTargets, resolveDeployTargets } from './deployment'
import { deploymentLabel } from './format'

const BUILT_IN_ORDER = ['testflight', 'firebase_hosting', 'firebase_functions', 'firebase_rules_indexes', 'vercel', 'flutter_web', 'cloud_run', 'none']

describe('deploy target resolution', () => {
  it('uses every built-in target for an absent or legacy boolean deployments block', () => {
    expect(resolveDeployTargets(undefined).map((target) => target.id)).toEqual(BUILT_IN_ORDER)
    const legacy = resolveDeployTargets({ firebaseHosting: true, testflight: false, cloudRun: false })
    expect(legacy.map((target) => target.id)).toEqual(BUILT_IN_ORDER)
    expect(legacy.every((target) => target.enabled)).toBe(true)
    expect(legacy.find((target) => target.id === 'testflight')?.requiresHumanAcceptance).toBe(true)
  })

  it('merges configured targets over built-ins, keeps their order, and appends none', () => {
    const targets = resolveDeployTargets({ targets: {
      fly: { label: 'Fly.io', runbook: 'docs/deploy-targets/fly.md' },
      firebase_hosting: { label: 'Website' },
      testflight: { enabled: false },
    } })
    expect(targets.map((target) => [target.id, target.label, target.enabled])).toEqual([
      ['fly', 'Fly.io', true],
      ['firebase_hosting', 'Website', true],
      ['testflight', 'TestFlight', false],
      ['none', 'No deploy', true],
    ])
    expect(() => resolveDeployTargets({ targets: { fly: { label: 'Fly.io' } } })).toThrow(/fly needs a valid id, label, and runbook/)
  })

  it('offers enabled targets in the picker plus any disabled one the item already selected', () => {
    const targets = resolveDeployTargets({ targets: { fly: { label: 'Fly.io', runbook: 'fly.md' }, vercel: { enabled: false } } })
    expect(pickerDeploymentTargets([], targets).map((target) => target.id)).toEqual(['fly', 'none'])
    expect(pickerDeploymentTargets(['vercel'], targets).map((target) => target.id)).toEqual(['fly', 'vercel', 'none'])
  })
})

describe('the console reads the sample configuration', () => {
  it('lists the configured targets, including disabled ones, so recorded scopes still render', () => {
    expect(DEPLOYMENT_TARGETS).toEqual(BUILT_IN_ORDER)
    expect(pickerDeploymentTargets([]).map((target) => target.id)).toEqual(['firebase_hosting', 'firebase_functions', 'firebase_rules_indexes', 'none'])
    expect(deploymentTargetsFor({ deploymentApprovedTargets: ['testflight', 'firebase_hosting'] }, true)).toEqual(['testflight', 'firebase_hosting'])
  })

  it('normalizes scopes against configured ids and labels them from config', () => {
    expect(normalizeDeploymentTargets(['firebase_functions', 'bogus', 'firebase_hosting'])).toEqual(['firebase_hosting', 'firebase_functions'])
    expect(normalizeDeploymentTargets(['none', 'firebase_hosting'])).toEqual(['none'])
    expect(legacyDeploymentType(['firebase_hosting', 'firebase_functions'])).toBe('mixed')
    expect(deploymentLabel('firebase_rules_indexes')).toBe('Rules & indexes')
    expect(deploymentLabel('mixed')).toBe('Mixed release')
    expect(deploymentLabel('npm_publish')).toBe('npm publish')
  })
})
