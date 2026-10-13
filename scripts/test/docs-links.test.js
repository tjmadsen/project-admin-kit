'use strict';

// Every relative link, image, and inline HTML src/srcset/href in the
// repository's markdown resolves: the target file (or directory) exists, and a
// `#fragment` into a markdown file names one of its headings. External links
// (http, mailto) are not fetched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT } = require('../lib/project-config');

function markdownFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean).filter((file) => fs.existsSync(path.join(ROOT, file)));
  } catch {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (['node_modules', '.git', '.agent-worktrees', '.project-admin'].includes(entry.name)) continue;
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(relative);
        else if (entry.name.endsWith('.md')) found.push(relative);
      }
    };
    walk('.');
    return found;
  }
}

// Prose only: fenced blocks and inline code spans are examples, not links.
const withoutFences = (text) => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
function prose(text) {
  return withoutFences(text).replace(/`[^`\n]*`/g, '');
}

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens,
// duplicates suffixed -1, -2, ...
function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function linksIn(text) {
  const links = [];
  for (const match of prose(text).matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push(match[1]);
  for (const match of prose(text).matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)) links.push(match[1]);
  // Inline HTML such as <img src> and <picture><source srcset>.
  for (const match of prose(text).matchAll(/\b(?:src|srcset|href)="([^"\s]+)"/g)) links.push(match[1]);
  return links;
}

test('relative markdown links resolve to existing files and headings', () => {
  const files = markdownFiles();
  assert.ok(files.length > 10, 'found the repository markdown');
  const broken = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const link of linksIn(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // http:, https:, mailto:, ...
      const [rawTarget, fragment] = link.split('#');
      const target = decodeURIComponent(rawTarget);
      const resolved = target ? path.resolve(path.dirname(path.join(ROOT, file)), target) : path.join(ROOT, file);
      if (!resolved.startsWith(ROOT) || !fs.existsSync(resolved)) {
        broken.push(`${file}: ${link} (no such file)`);
        continue;
      }
      if (fragment && resolved.endsWith('.md') && !anchorsOf(fs.readFileSync(resolved, 'utf8')).has(fragment.toLowerCase())) {
        broken.push(`${file}: ${link} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('heading anchors follow GitHub slugs', () => {
  const anchors = anchorsOf('# Hello, World!\n## From `a`/b to c\n## Hello, World\n```\n# not a heading\n```\n');
  assert.deepEqual([...anchors], ['hello-world', 'from-ab-to-c', 'hello-world-1']);
});
