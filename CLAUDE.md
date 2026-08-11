# IronBee Action

GitHub Action for IronBee CLI — Verify and fix code changes using IronBee DevTools (browser, backend, Node.js) with Claude Code.

## Project Overview

This is a **composite GitHub Action** that orchestrates [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) and [Claude Code CLI](https://github.com/anthropics/claude-code) to automatically verify code changes in a browser and fix issues found. Supports push, PR, manual (`workflow_dispatch`), and scheduled (`schedule`) triggers.

## Two verification modes

The verification runs either on the **IronBee platform** (a verification job created through `ironbee verify run web`, followed to a verdict) or **locally** (Claude Code on the runner, as it always did). `verification_mode` picks; `auto` reads repository visibility and whether an Anthropic credential is set.

Everything after the verdict is shared: the fix round, the commit, the PR, the report. That is why the agent no longer commits — where a fix lands depends on the trigger, and a step decides it.

Platform mode skips every local-only setup step (Chromium, DevTools, MCP, `ironbee install`), which is most of the runner time.

## How It Works (local mode)

1. Installs `@ironbee-ai/cli` and `@anthropic-ai/claude-code` globally
2. Writes `.ironbee/config.json` with the collector URL, per-mode DevTools enable flags, and per-mode MCP `LOG_FILE` paths under `.ironbee/artifacts/` so DevTools logs ship with the evidence (the IronBee API key is **never** written to disk — it is passed to `ironbee install` and `claude` as the `IRONBEE_API_KEY` env var, inherited by hooks and MCP subprocesses); `ironbee_extra_config` JSON is deep-merged on top so any IronBee CLI setting can be overridden without a dedicated input
3. Runs `ironbee install --client claude` to set up hooks, skills, rules, and MCP config
4. Sets up Playwright Chromium with GitHub Actions cache
5. Builds a context-aware verification prompt:
   - **push/PR**: diff-based verification with `/ironbee-verify`
   - **manual/scheduled**: full application verification with `/ironbee-verify full`
6. Runs Claude Code CLI with IronBee hooks + IronBee DevTools MCP (`@ironbee-ai/devtools`)
7. Collects evidence (screenshots, recordings, verdicts) and uploads as artifacts
8. Posts a verification report comment on PRs
9. On non-PR events (push, manual, scheduled), creates a fix PR if issues are found

## Architecture

This is a **composite action** (`runs: using: composite`) — not a JS action. It runs Claude Code CLI directly (not via `claude-code-action`).

**Decisions live in `scripts/`, not in YAML-embedded shell.** A decision written in a `run:` block cannot be tested: there is no way to ask "what would this do for a private repository with no Anthropic key" short of pushing a commit and waiting for a runner. Every branch — the mode, the target, the port, the repository binding, the verdict, the report, the fix prompt — is a pure function in a script with a test beside it. The steps invoke commands and wire outputs, and that is all.

## Project Structure

```
action.yml                # Composite action definition — steps only
scripts/
  resolve-plan.js         # mode, target, port, repo binding, CLI flags, budget floor
  read-job.js             # `ironbee verify --json` output -> verdict / job_id / job_url
  build-report.js         # report markdown, from artifacts (local) or a job body (platform)
  build-fix-prompt.js     # fix-only prompt built from a failing verdict
tests/
  *.test.js               # node --test, no dependencies
  action-inputs.test.js   #   the action.yml <-> resolve-plan.js seams: every referenced
                          #   input declared, every read env var exported, every table
                          #   entry's fallback equal to the declared default
.github/workflows/
  build.yml               # CI: validate action.yml + run the script tests
  release.yml             # Release: tag + GitHub Release
CLAUDE.md                 # This file
README.md                 # Usage documentation
LICENSE                   # MIT
```

Run the tests with `node --test tests/*.test.js`.

## Action Inputs

Grouped by area in `action.yml`, in this order, and the README table mirrors it.

**Where it runs:** `verification_mode` (`auto` / `platform` / `local`)
**IronBee — account & endpoints:** `ironbee_api_key` (required), `ironbee_api_url`, `ironbee_collector_url`, `ironbee_console_url`, `ironbee_cli_version`, `ironbee_project`
**IronBee — the job (platform only):** `ironbee_bind_repository`, `ironbee_job_timeout_minutes`
**IronBee — DevTools platforms (local only):** `ironbee_browser_devtools` (default `true`), `ironbee_backend_devtools`, `ironbee_node_devtools`, `ironbee_python_devtools`, `ironbee_terminal_devtools`
**IronBee — config & hygiene:** `ironbee_extra_config` (raw JSON, deep-merged into `.ironbee/config.json`), `ironbee_exclude_files`
**Claude auth (one required):** `anthropic_api_key`, `claude_code_oauth_token`
**Claude Code — install & runtime (local only):** `claude_code_cli_version`, `claude_code_model`, `claude_code_max_turns`, `claude_code_args`
**What to verify:** `verification_prompt`, `verification_apply_fix`
**App:** `app_install_command`, `app_build_command`, `app_start_command`, `app_url`, `app_port`, `app_wait_seconds`, `app_headers`, `app_secret_headers`
**GitHub:** `github_token`
**Options:** `working_directory`, `verbose`

Two naming rules the prefixes encode. `ironbee_*` and `claude_code_*` name the **engine
the input configures**, which is what makes "does nothing in the other mode" readable off
the name; `verification_*` carries neither prefix because those inputs reach whichever engine
runs.

Inputs have **no type** — GitHub validates nothing and `type: choice` / `type: boolean`
exist only for `workflow_dispatch` and `workflow_call`, never for an action. So every
boolean input is parsed in `resolve-plan.js` against one vocabulary
(`true`/`1`/`yes`/`on`, `false`/`0`/`no`/`off`) and an unrecognised value **fails the run
naming the input**. Do not add a bare `== 'true'` comparison in a step: that is a third,
narrower vocabulary, and `verbose: on` would then be on in the generated config and off in
the step. `verbose` and `ironbee_exclude_files` are read back from the plan's own outputs
for exactly that reason.

The repository binding measures the changeset from the first base that says
something: the push event's own `before` (it spans every commit in the push, so
it must keep precedence or a multi-commit push silently narrows to its tip),
then the commit's first parent, then nothing. `before` is skipped both when this
checkout cannot resolve it and when it resolves to a tree identical to the
commit's — an empty changeset is not an answer, it is a rewrite measured against
itself, and the parent is strictly more to review rather than less. The parent step matters more than it looks
— a force-push orphans the SHA the event reports as `before`, so the shape every
"re-push this change and verify it again" loop takes would otherwise bind the
commit and declare nothing changed, leaving the agent reviewing an application
instead of a change. The parent is read with `git cat-file commit` rather than
`rev-parse <sha>^`, because the default checkout is one commit deep and the
graft makes git report the commit as parentless while the object still names it.

The service endpoints resolve as a set, not one at a time. `ironbee_collector_url`
is the CLI's own stage-inference key, so the generated config **omits**
`collector.url` when nobody named one rather than writing a guess — a written
value pins the CLI's api/console derivation to whatever stage this action
picked. `ironbee_console_url` is the action's own (the report builder uses it,
not the CLI), so `resolve-plan.js` derives it from the collector when it is
unset and publishes it as the `console_url` step output. Report steps read that
output, never the raw input.

Each mode ignores the other's inputs, and `resolve-plan.js` warns in **both** directions
from two tables (`LOCAL_ONLY_INPUTS`, `PLATFORM_ONLY_INPUTS`). Membership is compared
against the input's declared default, not tested for presence — an input with a default is
always present, so presence would put every defaulted input in every warning. A new input
that only one mode reads belongs in one of those tables, with its `action.yml` default
copied into `fallback`.

## Action Outputs

- `verdict` — `pass` / `fail` / `not_applicable` / `unknown`
- `mode` — where the verification ran (`platform` / `local`)
- `job_id`, `job_url` — platform mode only
- `artifacts_url` — local mode only; platform evidence lives in the Console

## Key Conventions

- No TypeScript, no npm dependencies — including the tests, which use Node's built-in runner
- Decision logic goes in `scripts/` with a test beside it, never in a `run:` block
- Claude Code CLI is called directly with `--output-format stream-json` for live CI logs
- Browser binaries cached at `~/.cache/ms-playwright` using `actions/cache`
- Browser downloads skipped during npm install (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`)
- IronBee hooks enforce verification flow (recording, screenshots, verdicts)
- PR comments are created/updated (not duplicated) using GitHub API
- Evidence uploaded via `actions/upload-artifact@v4` with 30-day retention
- PR comment includes a session-level IronBee Console link (above the verdict badge) and a per-cycle verification link (`?activityId=…&verificationId=…`) under each cycle heading; host from `ironbee_console_url`, or derived from the collector's stage when that is unset
- User prompt passed via env var to prevent shell command substitution
- IronBee API key never written to `.ironbee/config.json`; provided as `IRONBEE_API_KEY` env on the `ironbee install` and `claude` steps so hooks and MCP subprocesses inherit it
- No heredocs in action.yml — all content written via echo/printf to avoid YAML parsing issues
- Trigger-aware: adapts prompt and fix behavior based on event type
- **NEVER update the `v1` tag** — it is published on GitHub Marketplace and used by external users. Use `v0` tag for development and testing
- The action performs the commit and the push; the agent only edits files
- The last step in `action.yml` is the gate that exits with the verification's result. Nothing may be added after it

## Related Projects

- **ironbee-cli** (`@ironbee-ai/cli`): The CLI tool this action uses for verification hooks
- **claude-code** (`@anthropic-ai/claude-code`): Claude Code CLI
- **ironbee-devtools** (`@ironbee-ai/devtools`): MCP server for IronBee verification, with browser (Playwright), backend, and Node.js modes
