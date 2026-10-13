# Contributing

Thanks for helping. Bug reports, documentation fixes, new runner adapters,
deploy-target runbooks, and backend improvements are all welcome. For a large
change, open an issue first so the design can be agreed before you write it.

## Development setup

Node 20 or later (`.nvmrc` pins 20; CI also runs 22).

```bash
npm run install:all      # admin-app/ and scripts/
npm run install:extras   # optional: extras/functions
npm run demo             # the console against fixture data on 127.0.0.1:4318
npm --prefix admin-app run dev
```

Nothing in the core test suites needs Firebase, GitHub, or an agent CLI: the
Firestore store runs against an in-memory fake, the github store against a
fake transport, and the local store in a temp directory. The rules suite needs
the Firebase CLI and Java 21.

## Test matrix

Run every suite your change touches; CI runs all of them.
[AGENTS.md](AGENTS.md#build-and-test) carries the same matrix for agents.

| Suite | Command | When |
|---|---|---|
| Admin console | `npm --prefix admin-app test` | any change under `admin-app/` |
| Console build | `npm run build` | console, config, or schema changes (writes `public/admin/`; do not commit the rebuilt bundle unless the change is a release) |
| Agent tooling | `npm --prefix scripts test` | anything under `scripts/`, runbooks, docs links, config |
| Store contract | `cd scripts && node --test test/store-contract.test.js` | store or backlog CLI changes; one scenario set runs on firestore, local, and github |
| Firestore + Storage rules | `npm run test:rules` | `firestore.rules`, `storage.rules`, work kinds |
| Extras | `npm run test:extras` | anything under `extras/` |
| Work-kind sync | `node scripts/lib/work-kinds.js check` | `workKinds` changes; fix drift with `npm run sync:work-kinds` |
| Deploy-target runbooks | `node scripts/lib/deploy-targets.js check` | `deployments.targets` or runbook changes |

`scripts/test/docs-links.test.js` (part of the agent tooling suite) fails on
any relative markdown link, image, or heading anchor that does not resolve.

For a visible console change, attach before/after screenshots from the fixture
harness ([admin-app/screenshots/README.md](admin-app/screenshots/README.md)):

```bash
cd admin-app
node screenshots/capture.mjs shoot /tmp/before --themes light,dark   # on main
node screenshots/capture.mjs shoot /tmp/after --themes light,dark    # on your branch
node screenshots/capture.mjs compare /tmp/before /tmp/after /tmp/diff
```

## Runbooks and prompt lint

Loop behavior lives in markdown, not code. The canonical runbooks are
`.claude/commands/<kind>-loop.md` and `.claude/commands/deploy-loop.md`; the
files in `scripts/agent-loops/*-loop-prompt.md` are short shims that point the
headless agent at them. Each deploy target's procedure is its own runbook in
`docs/deploy-targets/`.

`scripts/test/prompt-lint.test.js` holds these files to their contracts: every
configured kind has a shim that names its runbook; build runbooks carry the
worktree pre-flight, branch reuse, and note throttle; release handoffs keep the
durable approval scope; non-deploying kinds never hand off to the deploy loop;
runbooks reach kit scripts through `$KIT_ROOT` and put worktrees under
`$PRODUCT_ROOT`; and every deploy-target runbook names preconditions, a
time-bounded (`gtimeout`) command block, live proof, and known failures. When a
lint fails after a runbook edit, fix the runbook rather than loosening the
lint, unless the contract itself is what you are changing.

## Commits and pull requests

- Keep each PR to one concern, with tests for behavior changes and doc updates
  in the same PR. Note breaking changes and migrations in `CHANGELOG.md`.
- Write commit subjects in the imperative ("Add a Gemini runner example"),
  under about 72 characters, with a body that explains why.
- Do not commit `public/admin/` rebuilds, `.project-admin/demo/`, logs, or
  anything under `.agent-worktrees/`.
- Fill in the pull request template, including which suites you ran.

## No secrets or personal data

Fixtures, tests, docs, and screenshots use `example.com` addresses, placeholder
project ids (`replace-with-...`, `demo-...`), and `owner/repository`-style
slugs. Never commit credentials, real project ids, real email addresses, or
absolute paths from your machine. [SECURITY.md](SECURITY.md) lists the secrets
the kit uses and how to report a vulnerability.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
