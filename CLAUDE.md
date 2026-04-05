# IronBee Action

GitHub Action for IronBee CLI — Verify and fix code changes using browser-based testing with Claude Code.

## Project Overview

This is a **composite GitHub Action** that orchestrates [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) and [Claude Code CLI](https://github.com/anthropics/claude-code) to automatically verify code changes in a browser and fix issues found. Supports push, PR, manual (`workflow_dispatch`), and scheduled (`schedule`) triggers.

## How It Works

1. Installs `@ironbee-ai/cli` and `@anthropic-ai/claude-code` globally
2. Runs `ironbee install --client claude` to set up hooks, skills, rules, and MCP config
3. Sets up Playwright Chromium with GitHub Actions cache
4. Enables recording enforcement so the agent must record browser sessions
5. Builds a context-aware verification prompt:
   - **push/PR**: diff-based verification with `/ironbee-verify`
   - **manual/scheduled**: full application verification with `/ironbee-verify full`
6. Runs Claude Code CLI with IronBee hooks + browser-devtools MCP
7. Collects evidence (screenshots, recordings, verdicts) and uploads as artifacts
8. Posts a verification report comment on PRs
9. On non-PR events (push, manual, scheduled), creates a fix PR if issues are found

## Architecture

This is a **composite action** (`runs: using: composite`) — not a JS action. It runs Claude Code CLI directly (not via `claude-code-action`). The only JS code is `scripts/build-report.js` for generating verification report markdown from artifacts.

## Project Structure

```
action.yml                # Composite action definition (the entire action logic)
scripts/
  build-report.js     # Generates verification report markdown from artifacts
.github/workflows/
  build.yml               # CI: validate action.yml
  release.yml             # Release: tag + GitHub Release
CLAUDE.md                 # This file
README.md                 # Usage documentation
LICENSE                   # MIT
```

## Action Inputs

**Auth (one required):** `anthropic_api_key`, `claude_code_oauth_token`
**GitHub:** `github_token`
**Versions:** `ironbee_cli_version`, `claude_code_cli_version`
**App:** `app_url`, `app_start_command`, `app_build_command`, `app_install_command`
**Claude:** `prompt`, `model`, `max_turns`, `claude_args`
**AWS (optional S3 upload):** `aws_iam_role`, `aws_region`, `aws_s3_bucket`
**Options:** `exclude_ironbee_files`, `verbose`, `working_directory`

## Action Outputs

- `verdict` — Verification result (`pass` / `fail` / `unknown`)
- `artifacts_url` — Download URL for verification evidence

## Key Conventions

- No TypeScript, no npm dependencies — pure composite action with shell steps
- Claude Code CLI is called directly with `--output-format stream-json` for live CI logs
- Browser binaries cached at `~/.cache/ms-playwright` using `actions/cache`
- Browser downloads skipped during npm install (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`)
- IronBee hooks enforce verification flow (recording, screenshots, verdicts)
- PR comments are created/updated (not duplicated) using GitHub API
- Evidence uploaded via `actions/upload-artifact@v4` with 30-day retention
- Optional S3 upload via AWS OIDC — enables inline screenshot rendering in PR comments
- User prompt passed via env var to prevent shell command substitution
- No heredocs in action.yml — all content written via echo/printf to avoid YAML parsing issues
- Trigger-aware: adapts prompt and fix behavior based on event type

## Related Projects

- **ironbee-cli** (`@ironbee-ai/cli`): The CLI tool this action uses for verification hooks
- **claude-code** (`@anthropic-ai/claude-code`): Claude Code CLI
- **browser-devtools-mcp**: MCP server for browser automation via Playwright
