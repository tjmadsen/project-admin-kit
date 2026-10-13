# Security

Project Admin Kit runs coding-agent CLIs unattended. Read this before you
install the loops on a machine that holds anything you care about.

## Threat model

### Loops act with the machine user's full authority

A loop launches a headless agent CLI with no human present to approve tool
calls:

- the `claude` runner passes `--dangerously-skip-permissions`;
- the `codex` runner passes `--sandbox danger-full-access` unless the agent sets
  `sandbox` to `workspace-write` or `read-only`;
- the `grok` runner and any `command` runner run with whatever approval mode
  their flags select (the sample Gemini entry uses `--yolo`).

The agent therefore runs as the operating-system user that owns the loop and
can use everything that user can: SSH keys and `gh` credentials (`git push`,
PR merges), Application Default Credentials (`firebase deploy`, `gcloud`), the
App Store Connect API key, CLI sessions for every provider, and any file in the
home directory. Prompt injection from an issue body, a thread message, a
dependency, or a web page is in scope: treat every loop as able to do anything
that user can do.

### `headless-guard.py` is a seatbelt, not a sandbox

`scripts/agent-loops/headless-guard.py` is a PreToolUse hook. Only the `claude`
runner wires it in (an agent is `guarded` only then); `codex`, `grok`, and
`command` agents are unguarded and are flagged in the loop log, by
`provision-machine.sh check`, and on the Agent Loops page.

It blocks, at command position in a Bash tool call: `sudo`, recursive `rm`,
`mkfs`, `dd if=`, `git push --force` / `--force-with-lease` / `-f`,
`git reset --hard`, `git clean` with `-d`/`-f`/`-x`, piping into a shell
(`| sh`, `| bash`), and redirects that overwrite system paths.

It does not block: ordinary `git push`, merges, `firebase deploy`, Vercel and
Cloud Run deploys, TestFlight uploads, reading credentials or keys, network
access, or file writes and edits through the CLI's own (non-Bash) tools. A
wrapper such as `bash -c "..."` can evade its patterns, and it fails open on
its own errors. It exists to stop an over-eager agent's accidents, not an
adversary.

### Recommended isolation

- Run loops on a dedicated machine, VM, or container
  (`Dockerfile.loops` is a starting point), under a user that has nothing else.
- Give that user least-privilege credentials: a fine-grained GitHub token
  limited to the product repository (contents, pull requests, issues), a
  Google service account or ADC identity with only the Firebase roles your
  deploy targets need, and an App Store Connect key with the narrowest role
  that uploads builds.
- Protect the default branch: require PR reviews and status checks, and
  forbid force pushes. Build loops open PRs; they never need to push to the
  default branch directly.
- Prefer a guarded runner, or a Codex `sandbox` narrower than
  `danger-full-access`, wherever a loop does not need full access.
- Keep `machine-roster.json` minimal: a machine runs only the agent and queue
  pairs it lists, and `run-loop.sh` refuses everything else.

### Human gates are the trust boundary

Agents cannot approve their own work. Plan review, PR review, deploy approval,
and acceptance are human actions in the console (or, on the github backend,
slash commands and labels from authorized collaborators). A deploy approval is
an immutable snapshot of the PR, branch, targets, commands, verification, and
acceptance notes the agent proposed; the deploy loop executes only that scope,
the backlog CLI rejects closure until every approved target has recorded proof,
and targets with `requiresHumanAcceptance` (TestFlight by default) always
return to a person. These gates constrain what the workflow does; they do not
constrain what a compromised agent process can do with the machine's
credentials, which is why the isolation above matters.

### Backend-specific notes

- **firestore.** Google sign-in proves identity, `adminUsers/{email}` grants a
  role, and `firestore.rules` / `storage.rules` enforce it for every browser
  request; deploy rules only after the emulator suite passes. The CLIs use
  server credentials and bypass the rules, so run them only on trusted
  machines. The Firebase web configuration in `project-admin.config.json`
  (API key, app id, sender id) is public client configuration by design;
  access is enforced by Authentication and the rules, not by keeping it secret.
- **local.** `npm run local` has no authentication: every request is the
  configured owner with admin rights. It binds to 127.0.0.1, refuses requests
  whose `Host` is not a loopback name (DNS rebinding), and refuses writes
  without an `X-Project-Admin: local` header (cross-site forms). Anything that
  can reach the port, including other users of the machine, has full access.
  Never expose it through `0.0.0.0`, port forwarding, a tunnel, or a reverse
  proxy. `npm run demo` serves only throwaway fixture data the same way.
- **github.** Slash commands and approval labels are honored only from users
  with `write`, `maintain`, or `admin` permission on the repository, so anyone
  with write access can approve a plan, a PR, or a deployment: keep that list
  short. Claims are best effort (GitHub has no compare-and-swap); two pollers
  can rarely claim the same issue, which shows as two "Claimed by" comments.
  Run one poller per queue per repository. Plain comments never move an item,
  but agents read them, so comments from outside collaborators on a public
  repository are untrusted input.

### Secrets that must never be committed

Service-account keys and ADC files, `auth.env`, `admin-app/.env.local`, Gmail
or SMTP app passwords (store them with `firebase functions:secrets:set`), App
Store Connect `.p8` keys and the `PROJECT_ADMIN_ASC_*` values,
`extras/native-ios/GoogleService-Info.plist`, `GITHUB_TOKEN` / `GH_TOKEN`,
provider API keys and CLI sessions (`ANTHROPIC_API_KEY`, `~/.codex/auth.json`),
and notification webhook URLs (keep them in `~/.project-admin/loops.env`).
`.gitignore` covers the in-repository paths. Test fixtures use `example.com`
addresses and placeholder ids only.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for a security problem. Include the
affected version or commit, the backend and runner involved, and steps to
reproduce. Maintainers will acknowledge the report, agree on a fix and
disclosure timeline with you, and credit you in the release notes unless you
prefer otherwise.

Supported versions: the latest release on the default branch.
