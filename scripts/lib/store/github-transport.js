'use strict';

// GitHub REST over Node's built-in fetch. One small surface -
// request(method, route, body) and paginate(route) - so tests swap in an
// in-memory fake (test/support/fake-github.js) and never touch the network.
//
// Token: GITHUB_TOKEN, then GH_TOKEN, then `gh auth token` (the GitHub CLI's
// stored login). It needs `repo` scope (classic) or Issues read/write +
// Metadata read (fine-grained) on the backlog repository.

const { spawnSync } = require('node:child_process');

function resolveGitHubToken(env = process.env, run = spawnSync) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  const result = run('gh', ['auth', 'token'], { encoding: 'utf8' });
  const token = result.status === 0 ? String(result.stdout || '').trim() : '';
  if (!token) throw new Error('The github backend needs GITHUB_TOKEN (or GH_TOKEN) or a `gh auth login` session');
  return token;
}

function createGitHubTransport({ token, fetchImpl = fetch, apiUrl = 'https://api.github.com' } = {}) {
  let cachedToken = token;
  const authToken = () => (cachedToken ||= resolveGitHubToken());

  async function request(method, route, body) {
    const response = await fetchImpl(`${apiUrl}${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${authToken()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'project-admin-kit',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${route} failed: ${response.status} ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  // Follows ?page= until a short page; GitHub caps per_page at 100.
  async function paginate(route, { max = Infinity } = {}) {
    const results = [];
    const separator = route.includes('?') ? '&' : '?';
    for (let page = 1; results.length < max; page += 1) {
      const batch = await request('GET', `${route}${separator}per_page=100&page=${page}`);
      results.push(...batch);
      if (batch.length < 100) break;
    }
    return results.slice(0, max);
  }

  return { request, paginate };
}

module.exports = { createGitHubTransport, resolveGitHubToken };
