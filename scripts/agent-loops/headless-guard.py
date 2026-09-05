#!/usr/bin/env python3
"""PreToolUse guard for the HEADLESS run-loop.sh Claude agents.

The headless loops run with `--dangerously-skip-permissions` — there is NO human
to approve anything (see run-loop.sh). This hook is the seatbelt: it hard-blocks a
small set of CATASTROPHIC, irreversible shell commands that a helpful-but-overeager
agent might run by accident, and allows everything else through untouched.

Scope is deliberately narrow — DESTRUCTION and PRIVILEGE/RCE only, NOT ships or
secrets. Deliberately NOT blocked, because the deploy loop needs every one of
them: `./build_and_deploy.sh`, `firebase deploy --only ...`, Vercel deploys,
`gcloud run deploy`, `scripts/upload-testflight.sh` and the TestFlight autoship
poller, ordinary `git push` (including build-number bumps), and reading the App
Store Connect `.p8` key.

This is a seatbelt against ACCIDENTS, not a security sandbox against an adversary
(a determined `bash -c "..."` wrapper can still evade the invocation-anchored
patterns). For true isolation, use OS sandboxing instead.

Contract: read the PreToolUse JSON on stdin; exit 2 to BLOCK (stderr is shown to
the model as the reason); exit 0 to ALLOW. Fail OPEN on any of our own errors so a
guard bug never wedges the loop.
"""
import sys
import json
import re

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # can't parse our own input -> don't block

try:
    cmd = ((data.get("tool_input") or {}).get("command") or "")
    if not cmd.strip():
        sys.exit(0)

    # A command "invocation" starts at string start or right after a shell separator
    # (; & | newline ( ` and && ||). Anchoring here means a pattern only fires on a
    # command actually being run, not the same word buried in a quoted argument --
    # the backlog CLIs write long prose into -m / --description / --notes / --proof
    # and that prose regularly quotes the very tokens listed below.
    INVOKE = r"(?:^|[;&|`(\n])\s*"

    PATTERNS = [
        (INVOKE + r"sudo\b",
         "sudo - privilege escalation",
         "drop the escalation and run the command as your own user"),
        (INVOKE + r"rm\s+-[a-zA-Z]*r",
         "recursive file deletion - irreversible",
         "use `git worktree remove <path> --force` for worktree cleanup, or delete "
         "named files without the recursive flag"),
        (INVOKE + r"mkfs\b",
         "mkfs - formats a filesystem",
         "no loop task needs to format a device"),
        (INVOKE + r"dd\s+if=",
         "dd if=... - raw device write",
         "use `cp` or `cat` for ordinary file copies"),
        (INVOKE + r"git\b[^;&|]*\bpush\b[^;&|]*(?:--force|--force-with-lease|\s-f\b)",
         "git force-push - rewrites or destroys remote history",
         "push a normal fast-forward commit, or open a fresh branch"),
        (INVOKE + r"git\b[^;&|]*\breset\s+--hard\b",
         "git hard reset - discards uncommitted work",
         "use `git stash` or `git restore <path>` to undo specific changes"),
        (INVOKE + r"git\b[^;&|]*\bclean\s+-[a-zA-Z]*[dfx]",
         "git clean with force/dirs/ignored - deletes untracked files",
         "run `git clean -n` first, or remove the specific files you meant"),
        (r"\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b",
         "pipe-to-shell install - remote code execution",
         "download the script, read it, then run it explicitly"),
        (r">\s*/(?:etc|System|Library|usr|bin|sbin|var)/",
         "redirect overwrite of a system path",
         "write inside the repository or a temp directory instead"),
    ]

    for pat, why, alternative in PATTERNS:
        if re.search(pat, cmd, re.IGNORECASE):
            sys.stderr.write(
                "headless-guard: BLOCKED - " + why + ".\n"
                "This catastrophic command is denied for unattended run-loop agents "
                "(no human is present to approve it).\n"
                "Try instead: " + alternative + ".\n"
                "Command: " + cmd[:300] + "\n"
            )
            sys.exit(2)
except SystemExit:
    raise
except Exception:
    sys.exit(0)  # a guard bug must never wedge the loop

sys.exit(0)
