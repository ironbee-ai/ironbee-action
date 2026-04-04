# IronBee Action

GitHub Action for [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) — Verify and fix code changes using browser-based testing with Claude Code.

## What It Does

IronBee Action automatically verifies code changes in a real browser and fixes issues found. It orchestrates [Claude Code CLI](https://github.com/anthropics/claude-code) with [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) to:

1. Review code changes (PR diff or push diff)
2. Build and start your application
3. Navigate to affected pages, take screenshots, test functionality
4. Record browser sessions as evidence
5. Fix any issues found and re-verify
6. Post a verification report on the PR with evidence artifacts

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
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Permissions

The action requires these GitHub token permissions:

| Permission | Required | Purpose |
|------------|----------|---------|
| `contents: write` | Yes | Commit fixes to PR branches, create fix branches for push events |
| `pull-requests: write` | Yes | Post verification report comments on PRs, create fix PRs |
| `issues: write` | Yes | Update PR comments via GitHub API |

## Usage Examples

### With Application Configuration

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    app_build_command: 'npm run build'
    app_start_command: 'npm run dev'
    app_url: 'http://localhost:3000'
```

### With Custom Instructions

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: 'Focus on the checkout flow and payment form validation'
    max_turns: '30'
```

### With OAuth Token

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Keep IronBee Config in Repo

By default, IronBee config files are committed to the repo so they can be used in local development. To exclude them:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    exclude_ironbee_files: 'true'
```

### Verbose Logging

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    verbose: 'true'
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic_api_key` | Yes* | | Anthropic API key for Claude Code |
| `claude_code_oauth_token` | No* | | Claude Code OAuth token (alternative auth) |
| `github_token` | No | `github.token` | GitHub token for PR operations |
| `ironbee_cli_version` | No | `latest` | IronBee CLI version to install |
| `claude_code_cli_version` | No | `latest` | Claude Code CLI version to install |
| `app_url` | No | | Application URL for verification |
| `app_start_command` | No | | Command to start the application |
| `app_build_command` | No | | Command to build the application |
| `app_install_command` | No | | Command to install dependencies |
| `prompt` | No | | Additional instructions for the agent |
| `model` | No | | Claude model override |
| `max_turns` | No | `100` | Maximum conversation turns |
| `claude_args` | No | | Additional Claude Code CLI arguments |
| `exclude_ironbee_files` | No | `false` | Exclude IronBee config files from commits |
| `verbose` | No | `false` | Enable verbose CI logging |
| `working_directory` | No | `.` | Working directory for verification |

*One of `anthropic_api_key` or `claude_code_oauth_token` is required.

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | Verification result: `pass`, `fail`, or `unknown` |
| `artifacts_url` | Download URL for verification evidence (screenshots, recordings) |

## How It Works

### Verification Flow

1. **Setup** — Installs IronBee CLI, Claude Code CLI, and Playwright Chromium (cached across runs)
2. **Configure** — Runs `ironbee install --client claude` to set up hooks, skills, rules, and MCP config
3. **Verify** — Claude Code runs `/ironbee-verify` which:
   - Reviews the code diff
   - Builds and starts the application
   - Records browser sessions and takes screenshots
   - Tests functionality and checks for errors
   - Submits a verdict (pass/fail)
4. **Fix** — If verification fails, Claude Code fixes the issues and re-verifies
5. **Report** — Posts a verification report on the PR with per-cycle breakdown and evidence

### Fix Behavior

- **PR trigger** — Fixes are committed directly to the PR branch
- **Push to main** — If verification fails, a fix PR is created automatically

### Evidence Collection

Screenshots and recordings are organized by verification cycle:

```
.ironbee/artifacts/
  cycle-1-fail/
    screenshots/homepage-missing-button.png
    recordings/form-validation.webm
  cycle-2-pass/
    screenshots/homepage-fixed.png
    recordings/form-validation-fixed.webm
```

Evidence is uploaded as GitHub Actions artifacts (30-day retention) and linked in the PR comment.

### Caching

Playwright Chromium binaries (~200MB) are cached using `actions/cache` to speed up subsequent runs. The cache key is based on the runner OS. Browser downloads during `npm install` are skipped (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`) and installed separately with system dependencies.

## License

MIT
