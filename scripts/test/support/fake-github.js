'use strict';

// In-memory GitHub REST for the github store: issues (with label filters and
// `since`), comments with monotonically increasing ids, label events, and
// collaborator permissions. Implements the transport surface
// (request/paginate) so no test touches the network. Helpers act as a human
// in the GitHub UI.

function createFakeGitHub({ repository = 'acme/app', permissions = {}, clock = () => Date.now() } = {}) {
  const issues = new Map();
  const comments = [];
  const events = [];
  const calls = [];
  let nextNumber = 1;
  let nextCommentId = 1000;
  let tick = 0;
  // Strictly increasing timestamps so `since` filtering is deterministic.
  const stamp = () => new Date(clock() + (tick += 1)).toISOString();
  const base = `/repos/${repository}`;
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const touch = (issue) => { issue.updated_at = stamp(); };
  const label = (name) => ({ name });
  const view = (issue) => JSON.parse(JSON.stringify({ ...issue, comments: comments.filter((comment) => comment.issue === issue.number).length }));

  function createIssue({ title, body = '', labels = [] }, login = 'store-bot') {
    const now = stamp();
    const issue = {
      number: nextNumber++, title, body, labels: labels.map(label), state: 'open', state_reason: null,
      created_at: now, updated_at: now, user: { login },
    };
    issues.set(issue.number, issue);
    return issue;
  }
  function addComment(number, body, login = 'store-bot') {
    const issue = issues.get(number);
    if (!issue) throw notFound();
    const comment = { id: nextCommentId++, issue: number, body, user: { login }, created_at: stamp() };
    comments.push(comment);
    touch(issue);
    return comment;
  }

  async function request(method, route, body) {
    calls.push({ method, route, body });
    const [pathPart, queryPart = ''] = route.split('?');
    const query = new URLSearchParams(queryPart);
    if (!pathPart.startsWith(base)) throw notFound();
    const rest = pathPart.slice(base.length);
    let match;
    if (method === 'GET' && rest === '/issues') {
      const state = query.get('state') || 'open';
      const wanted = (query.get('labels') || '').split(',').filter(Boolean);
      const since = query.get('since');
      return [...issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .filter((issue) => wanted.every((name) => issue.labels.some((entry) => entry.name === name)))
        .filter((issue) => !since || issue.updated_at >= since)
        .map(view);
    }
    if (method === 'POST' && rest === '/issues') return view(createIssue(body));
    if ((match = rest.match(/^\/issues\/(\d+)$/))) {
      const issue = issues.get(Number(match[1]));
      if (!issue) throw notFound();
      if (method === 'GET') return view(issue);
      if (method === 'PATCH') {
        if (body.title !== undefined) issue.title = body.title;
        if (body.body !== undefined) issue.body = body.body;
        if (body.labels !== undefined) issue.labels = body.labels.map(label);
        if (body.state !== undefined) { issue.state = body.state; issue.state_reason = body.state === 'closed' ? (body.state_reason || 'completed') : null; }
        touch(issue);
        return view(issue);
      }
    }
    if ((match = rest.match(/^\/issues\/(\d+)\/comments$/))) {
      const number = Number(match[1]);
      if (!issues.has(number)) throw notFound();
      if (method === 'GET') return comments.filter((comment) => comment.issue === number).map((comment) => ({ ...comment }));
      if (method === 'POST') return { ...addComment(number, body.body) };
    }
    if (method === 'DELETE' && (match = rest.match(/^\/issues\/comments\/(\d+)$/))) {
      const index = comments.findIndex((comment) => comment.id === Number(match[1]));
      if (index === -1) throw notFound();
      comments.splice(index, 1);
      return null;
    }
    if (method === 'GET' && (match = rest.match(/^\/issues\/(\d+)\/events$/))) {
      return events.filter((entry) => entry.issue === Number(match[1])).map((entry) => ({ ...entry }));
    }
    if (method === 'GET' && (match = rest.match(/^\/collaborators\/([^/]+)\/permission$/))) {
      const login = decodeURIComponent(match[1]);
      if (!(login in permissions)) throw notFound();
      return { permission: permissions[login] };
    }
    throw Object.assign(new Error(`fake github: unsupported ${method} ${route}`), { status: 501 });
  }

  async function paginate(route, { max = Infinity } = {}) {
    const results = await request('GET', route);
    return results.slice(0, max);
  }

  return {
    request,
    paginate,
    calls,
    issue: (number) => view(issues.get(Number(number))),
    comments: (number) => comments.filter((comment) => comment.issue === Number(number)).map((comment) => ({ ...comment })),
    // A person acting in the GitHub UI.
    human: {
      openIssue: (login, fields) => view(createIssue(fields, login)),
      comment: (number, login, body) => ({ ...addComment(Number(number), body, login) }),
      addLabel(number, login, name) {
        const issue = issues.get(Number(number));
        issue.labels.push(label(name));
        events.push({ id: events.length + 1, issue: issue.number, event: 'labeled', label: label(name), actor: { login } });
        touch(issue);
      },
      close(number, reason = 'completed') {
        const issue = issues.get(Number(number));
        Object.assign(issue, { state: 'closed', state_reason: reason });
        touch(issue);
      },
    },
  };
}

module.exports = { createFakeGitHub };
