#!/usr/bin/env node
'use strict';

const { stripVTControlCharacters } = require('node:util');

function cleanTerminalOutput(output) {
  return stripVTControlCharacters(String(output || ''))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function parseClaudeUsage(output) {
  const clean = cleanTerminalOutput(output);
  const sectionPattern = /Current\s+week\s*\(\s*all\s+models\s*\)\s*:?[ \t]*([\s\S]*?)(?=\n\s*Current\s+(?:session|week)\b|\n\s*What's\s+contributing\b|$)/gi;
  let parsed = null;

  for (const section of clean.matchAll(sectionPattern)) {
    const body = section[1].slice(0, 1000);
    const percentMatch = body.match(/(?<![-\d.])(\d+(?:\.\d+)?)\s*%\s*used\b/i);
    if (!percentMatch) continue;
    const usedPercent = Number(percentMatch[1]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const resetMatch = body.slice(percentMatch.index + percentMatch[0].length).match(/\bresets?\s+([^\n]+)/i);
    parsed = { usedPercent, resetsLabel: resetMatch?.[1]?.trim() || null };
  }
  return parsed;
}

function diagnoseClaudeUsage(output) {
  const clean = cleanTerminalOutput(output);
  const hasTargetLabel = /Current\s+week\s*\(\s*all\s+models\s*\)/i.test(clean);
  const usage = parseClaudeUsage(clean);
  if (usage) return { usage, error: null };
  return { usage: null, error: hasTargetLabel ? 'parse_error' : 'missing_label' };
}

if (require.main === module) {
  const result = diagnoseClaudeUsage(require('node:fs').readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(result));
  if (!result.usage) process.exitCode = 1;
}

module.exports = { cleanTerminalOutput, diagnoseClaudeUsage, parseClaudeUsage };
