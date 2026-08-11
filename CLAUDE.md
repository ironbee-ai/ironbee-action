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
.github/workflows/
  build.yml               # CI: validate action.yml + run the script tests
  release.yml             # Release: tag + GitHub Release
CLAUDE.md                 # This file
README.md                 # Usage documentation
LICENSE                   # MIT
```

Run the tests with `node --test tests/*.test.js`.

## Action Inputs

**IronBee (required):** `ironbee_api_key`
**IronBee (optional):** `ironbee_collector_url`, `ironbee_console_url`, `ironbee_exclude_files`
**IronBee DevTools toggles:** `ironbee_browser_devtools` (default `true`), `ironbee_backend_devtools`, `ironbee_node_devtools`
**IronBee config escape hatch:** `ironbee_extra_config` (raw JSON, deep-merged into `.ironbee/config.json`)
**Claude auth (one required):** `anthropic_api_key`, `claude_code_oauth_token`
**GitHub:** `github_token`
**Versions:** `ironbee_cli_version`, `claude_code_cli_version`
**App:** `app_url`, `app_start_command`, `app_build_command`, `app_install_command`
**Claude:** `prompt`, `model`, `max_turns`, `claude_args`
**Options:** `verbose`, `working_directory`

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
- PR comment includes a session-level IronBee Console link (above the verdict badge) and a per-cycle verification link (`?activityId=…&verificationId=…`) under each cycle heading; host configurable via `ironbee_console_url`
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
