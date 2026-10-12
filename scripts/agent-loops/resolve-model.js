#!/usr/bin/env node
'use strict';

// The loops run the newest model in each tier rather than a pinned version,
// and every run records the exact model it used so the admin console can name
// the version (BUG-173). Claude resolves its alias (`opus`) itself and writes
// the resolved ID into the session transcript. Grok runs its CLI default.
// Codex has no "latest" alias, so pick the highest-versioned listed slug for
// the tier (gpt-6.1-sol over gpt-6-sol and gpt-5.6-sol) from its catalog.
//
//   resolve-model.js codex <tier> <codex-bin> <fallback-model> <effort>
//     prints "<model>\t<effort>", clamping the effort to the model's menu
//   resolve-model.js claude-session <session-id>
//   resolve-model.js grok <grok-bin>
//     print the model ID, or nothing when it cannot be read yet

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const TIER_SLUG = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function newestCodexModel(tier, catalog) {
  let best = null;
  for (const model of catalog?.models || []) {
    if (model.visibility !== 'list') continue;
    const match = TIER_SLUG.exec(model.slug || '');
    if (!match || match[2] !== tier) continue;
    if (best && compareVersions(match[1], best.version) <= 0) continue;
    const efforts = (model.supported_reasoning_levels || [])
      .map((level) => (typeof level === 'string' ? level : level?.effort))
      .filter(Boolean);
    best = { slug: model.slug, version: match[1], efforts };
  }
  return best;
}

// A newer model can drop a tier from its menu (gpt-6-luna has no "ultra"), so
// step down to the nearest effort it accepts instead of failing the launch.
function clampEffort(effort, supported) {
  if (!supported.length || supported.includes(effort)) return effort;
  const rank = EFFORT_ORDER.indexOf(effort);
  const below = supported.filter((level) => EFFORT_ORDER.indexOf(level) <= rank);
  return below.length ? below[below.length - 1] : supported[0];
}

function claudeSessionModel(sessionId, configDir) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) return null;
  const projects = path.join(configDir, 'projects');
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const dir of dirs) {
    let transcript;
    try { transcript = fs.readFileSync(path.join(projects, dir, `${sessionId}.jsonl`), 'utf8'); } catch { continue; }
    return /"model":"(claude-[^"]+)"/.exec(transcript)?.[1] || null;
  }
  return null;
}

function grokDefaultModel(listing) {
  return /^Default model:\s*(\S+)/m.exec(listing || '')?.[1] || null;
}

function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function main([command, ...args]) {
  if (command === 'codex') {
    const [tier, codexBin, fallback, effort] = args;
    let newest = null;
    try { newest = newestCodexModel(tier, JSON.parse(run(codexBin, ['debug', 'models']))); } catch { newest = null; }
    const model = newest ? newest.slug : fallback;
    return `${model}\t${newest ? clampEffort(effort, newest.efforts) : effort}`;
  }
  if (command === 'claude-session') {
    return claudeSessionModel(args[0], process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) || '';
  }
  if (command === 'grok') {
    try { return grokDefaultModel(run(args[0], ['models'])) || ''; } catch { return ''; }
  }
  throw new Error('Usage: resolve-model.js <codex|claude-session|grok> ...');
}

if (require.main === module) {
  process.stdout.write(main(process.argv.slice(2)));
}

module.exports = { newestCodexModel, clampEffort, claudeSessionModel, grokDefaultModel };
