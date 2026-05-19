# IronBee Action

GitHub Action for [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) — Verify and fix code changes using IronBee DevTools (browser, backend, and Node.js modes) with Claude Code.

## Demo

https://github.com/user-attachments/assets/4015258a-a6d5-45dd-8ddf-5d736d489436

## What It Does

IronBee Action automatically verifies code changes via IronBee DevTools and fixes issues found. It orchestrates [Claude Code CLI](https://github.com/anthropics/claude-code) with [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) to:

1. Review code changes (PR diff or push diff)
2. Build and start your application
3. Drive verification through the enabled DevTools modes (browser by default, plus optional backend / Node.js)
4. Record sessions and evidence to the IronBee collector
5. Fix any issues found and re-verify
6. Post a verification report on the PR with per-cycle Console links and downloadable evidence

## Quick Start

```yaml
name: IronBee Verification

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      - uses: ironbee-ai/ironbee-action@v1
        with:
          ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Trigger Modes

The action adapts its behavior based on the trigger event:

| Trigger | Verification Mode | Fix Behavior |
|---------|-------------------|-------------|
| `pull_request` | Diff-based — verifies changed pages | Commits fixes to PR branch, posts verification report comment |
| `push` (main/master) | Diff-based — verifies changed pages | Creates fix PR automatically if issues found |
| `workflow_dispatch` | Full — verifies entire application | Creates fix PR automatically if issues found |
| `schedule` | Full — verifies entire application | Creates fix PR automatically if issues found |

### PR Verification

```yaml
on:
  pull_request:
    types: [opened, synchronize]
```

Reviews the PR diff, verifies affected pages, and posts a verification report comment. Fixes are committed directly to the PR branch.

### Push to Main

```yaml
on:
  push:
    branches: [main]
```

Reviews the pushed commit diff and verifies affected pages. If issues are found, creates a new branch with fixes and opens a PR.

### Scheduled Smoke Test

```yaml
on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 09:00 UTC
```

Runs a full application verification on a schedule. No diff — tests the entire application. Creates a fix PR if issues are found.

### Manual Verification

```yaml
on:
  workflow_dispatch:
```

Trigger a full verification manually from the GitHub Actions UI. Creates a fix PR if issues are found.

## Permissions

The action requires these GitHub token permissions:

| Permission | Required | Purpose |
|------------|----------|---------|
| `contents: write` | Yes | Commit fixes to PR branches, create fix branches |
| `pull-requests: write` | Yes | Post verification report comments on PRs, create fix PRs |
| `issues: write` | Yes | Update PR comments via GitHub API |

## Usage Examples

### With Application Configuration

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    app_build_command: 'npm run build'
    app_start_command: 'npm run dev'
    app_url: 'http://localhost:3000'
```

### With Custom Instructions

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: 'Focus on the checkout flow and payment form validation'
    max_turns: '30'
```

### With OAuth Token

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Keep IronBee Config in Repo

By default, IronBee config files are committed to the repo so they can be used in local development. To exclude them:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_exclude_files: 'true'
```

### With Custom IronBee Console URL

The PR comment includes a link to the IronBee Console for the verification session. Override the default host (`console.ironbee.ai`) if you self-host:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_console_url: 'console.example.com'
```

### Enable Additional DevTools Platforms

By default only the browser DevTools mode runs. Opt into backend or Node.js modes when you want IronBee to verify those layers too:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_browser_devtools: 'true'
    ironbee_backend_devtools: 'true'
    ironbee_node_devtools: 'false'
```

### Raw Config Overrides

For any IronBee CLI setting not exposed as a dedicated input, pass a JSON object via `ironbee_extra_config`. It is deep-merged into the generated `.ironbee/config.json` and user keys win:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_extra_config: |
      {
        "verification": { "enable": true },
        "browserDevTools": { "env": { "LOG_FILE": "/tmp/browser-devtools.log" } }
      }
```

### Verbose Logging

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    verbose: 'true'
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| **IronBee — auth & collector** | | | |
| `ironbee_api_key` | Yes | | IronBee API key used to authenticate the collector |
| `ironbee_collector_url` | No | `https://collector.service.ironbee.ai` | IronBee collector endpoint URL |
| **IronBee — Console report links** | | | |
| `ironbee_console_url` | No | `console.ironbee.ai` | IronBee Console hostname (no scheme) for session links in the report |
| **IronBee — DevTools modes** | | | |
| `ironbee_browser_devtools` | No | `true` | Enable browser DevTools verification |
| `ironbee_backend_devtools` | No | `false` | Enable backend DevTools verification |
| `ironbee_node_devtools` | No | `false` | Enable Node.js DevTools verification |
| **IronBee — raw config escape hatch** | | | |
| `ironbee_extra_config` | No | | Raw IronBee config (JSON) deep-merged into `.ironbee/config.json`; user keys win |
| **IronBee — CLI install / repo behavior** | | | |
| `ironbee_cli_version` | No | `latest` | IronBee CLI version to install |
| `ironbee_exclude_files` | No | `false` | Exclude IronBee config files from commits |
| **Claude Code — auth** | | | |
| `anthropic_api_key` | Yes* | | Anthropic API key for Claude Code |
| `claude_code_oauth_token` | No* | | Claude Code OAuth token (alternative auth) |
| **Claude Code — install & runtime** | | | |
| `claude_code_cli_version` | No | `latest` | Claude Code CLI version to install |
| `model` | No | | Claude model override |
| `max_turns` | No | `100` | Maximum conversation turns |
| `prompt` | No | | Additional instructions for the agent |
| `claude_args` | No | | Additional Claude Code CLI arguments |
| **Application under test** | | | |
| `app_install_command` | No | | Command to install dependencies |
| `app_build_command` | No | | Command to build the application |
| `app_start_command` | No | | Command to start the application |
| `app_url` | No | | Application URL for verification |
| **GitHub** | | | |
| `github_token` | No | `github.token` | GitHub token for PR operations |
| **Action — general behavior** | | | |
| `working_directory` | No | `.` | Working directory for verification |
| `verbose` | No | `false` | Enable verbose CI logging |

*One of `anthropic_api_key` or `claude_code_oauth_token` is required.

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | Verification result: `pass`, `fail`, or `unknown` |
| `artifacts_url` | Download URL for verification evidence (screenshots, recordings) |

## How It Works

### Verification Flow

1. **Setup** — Installs `@ironbee-ai/cli`, `@anthropic-ai/claude-code`, `@ironbee-ai/devtools`, and Playwright Chromium (cached across runs)
2. **Configure** — Writes `.ironbee/config.json` with the collector URL, per-mode DevTools enable flags, and per-mode MCP `LOG_FILE` paths under `.ironbee/artifacts/` (deep-merging `ironbee_extra_config` on top), then runs `ironbee install --client claude` to set up hooks, skills, rules, and MCP config. The IronBee API key is passed via the `IRONBEE_API_KEY` env var (not written to disk) and inherited by hooks and MCP subprocesses
3. **Verify** — Claude Code runs `/ironbee-verify` (or `/ironbee-verify full` for manual/scheduled) which:
   - Reviews the code diff (push/PR) or tests the full app (manual/scheduled)
   - Builds and starts the application
   - Records sessions via the enabled DevTools modes and takes screenshots
   - Tests functionality and checks for errors
   - Submits a verdict (pass/fail)
4. **Fix** — If verification fails, Claude Code fixes the issues and re-verifies
5. **Report** — Posts a verification report on the PR with a session-level IronBee Console link, per-cycle verification links (`activityId` + `verificationId`), and a downloadable evidence artifact

### Fix Behavior

- **PR trigger** — Fixes are committed directly to the PR branch
- **Push / Manual / Scheduled** — If issues are found, a fix PR is created automatically

### Evidence Collection

Screenshots and recordings are organized by verification cycle:

```
.ironbee/artifacts/
  cycle-1/
    screenshots/homepage-before-fix.png
    recordings/verification.webm
  cycle-2/
    screenshots/homepage-after-fix.png
    recordings/verification.webm
```

Evidence is uploaded as GitHub Actions artifacts (30-day retention) and linked in the PR comment.

### Caching

Playwright Chromium binaries (~200MB) are cached using `actions/cache` to speed up subsequent runs. The cache key is based on the runner OS. Browser downloads during `npm install` are skipped (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`) and installed separately with system dependencies.

## License

MIT
