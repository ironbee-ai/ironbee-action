# IronBee Action

GitHub Action for [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) — Verify and fix code changes using IronBee DevTools (browser, backend, and Node.js modes) with Claude Code.

## Demo

https://github.com/user-attachments/assets/4015258a-a6d5-45dd-8ddf-5d736d489436

## What It Does

IronBee Action verifies your code changes against a running application, fixes what it finds, and reports on the pull request.

## Two ways to verify

The verification itself can run in one of two places. Everything after it — the verdict, the fix, the commit, the report — is the same either way.

| | **Platform** | **Local** |
|---|---|---|
| Where the agent runs | IronBee's infrastructure | this runner |
| Model cost | IronBee's | your Anthropic account |
| Runner setup | none — no Chromium, no DevTools install | Chromium, DevTools, MCP, ~2 minutes |
| Needs an Anthropic credential | only to fix what it finds | yes |
| Evidence | in the IronBee Console | Console **and** a workflow artifact |
| Private repositories | needs the IronBee GitHub App installed | works with any checkout |

`verification_mode` picks between them and defaults to `auto`:

- the repository is **public** → **platform**. A public repository can be checked out without the GitHub App.
- the repository is **private** and an Anthropic credential is set → **local**. A private repository needs the App, and whether it is installed is the one thing the action cannot check for free — so it uses the engine it knows can run. **If the App does cover your repository, set `verification_mode: platform`.**
- the repository is **private** with no Anthropic credential → **platform**, because it is the only engine available. If the App is missing the run fails saying so — set `ironbee_bind_repository: false` to verify the application without a checkout instead.

## What a run does

1. Resolve the plan — mode, target, changeset — and refuse anything that cannot work, before installing anything
2. Verify: start a platform job and follow it, or run the agent here
3. Fix what a failing verdict reported, when `fix` is on and an Anthropic credential is set
4. Commit the fixes — to the PR branch on a pull request, as a new PR otherwise
5. Report on the pull request, with a link to the run in the IronBee Console

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
| `issue_comment` | Diff-based — verifies the pull request the comment is on | Commits fixes to the PR branch **only when the comment asks**, posts the report comment |

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

### On Demand, From a Comment

```yaml
on:
  issue_comment:
    types: [created]

concurrency:
  group: ironbee-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  verify:
    # WHO may run it is decided here, not by the action. An `issue_comment`
    # event fires for anyone who can leave a comment and runs in the BASE
    # repository with its secrets — so this condition is the security boundary.
    if: >-
      github.event.issue.pull_request &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association) &&
      startsWith(github.event.comment.body, '/ironbee-verify')
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      # `issue_comment` runs on the DEFAULT branch and `github.sha` points there,
      # not at the pull request — the head has to be checked out explicitly.
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.issue.number }}/head
          fetch-depth: 0
      - uses: ironbee-ai/ironbee-action@v0
        with:
          ...
```

Then, on any pull request:

```
/ironbee-verify
/ironbee-verify --fix
/ironbee-verify check the coupon flow end to end
/ironbee-verify --fix the totals are wrong when a coupon is applied
```

Options are marked with `--`, so scanning stops at the first token that is not
one and everything after it is the instruction for the agent. That is what makes
`/ironbee-verify fix the cart total` a prompt rather than a run that commits: a
bare `fix` is an ordinary English verb, and reading it as a flag would apply
changes nobody asked for. A multi-line comment works too — the whole body below
the command line is the prompt.

The command must be the first non-quoted line of the comment, so a comment that
merely discusses it, or a reply that quotes it, starts nothing.

`--fix` is opt-in per comment and bounded by `verification_apply_fix`: a
repository that switched fixing off cannot have it switched back on from a
comment. Unknown options are answered with a usage reply rather than read as
prose, and that run ends red — a composite action cannot stop halfway, so the
alternative would be verifying something other than what was asked for.

The comment gets an 👀 reaction when the run starts and 👍 / 👎 when it ends —
an `issue_comment` run does not appear in the pull request's checks, so without
them there is nothing to tell "it started" from "nothing listened".

**Fork pull requests are refused on this event**, and for the opposite reason to
the usual one: a comment run holds the base repository's secrets, so building
and starting a fork's code under it would hand them to whoever opened it.

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
| `issues: write` | Yes | Update PR comments, and add reactions on a comment-triggered run |

A pull request from a **fork** receives no secrets, so neither verification mode
can run there. The action detects it and says so rather than failing on an empty
key.

## Give the job enough time

The action prints the `timeout-minutes` its configuration needs, at the top of
the run. Set at least that much on the job:

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 90
```

It cannot check this for you — GitHub exposes a job's own timeout to nothing
running inside it. When the step is killed mid-run the verification job is
cancelled and the run reads as a platform failure, which is the one failure mode
worth spending a line of configuration to avoid.

## Protected deployments

A preview deployment behind SSO or a protection bypass answers 401 or 403 to the
verification, and the run would report on the login page. The action refuses that
case in preflight, by name.

An SSO redirect that answers **200** with a login page cannot be told apart from
an application by a status code, so it is not caught — the verdict will describe
the login page.

Two ways past it:

- **`app_secret_headers`** — if the protection can be bypassed with a header,
  put it there. The value is encrypted before it is stored and is never returned
  by the API. It is readable inside the run itself, which is the caller's own
  verification of the caller's own deployment; do not use this field for
  anything that protects more than the target.
- **Verify on the runner instead** — set `app_start_command` and `app_port`, and
  leave `app_url` empty. This verifies the application rather than the
  deployment: edge configuration, rewrites and the built artifact are not
  exercised.

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
    verification_prompt: 'Focus on the checkout flow and payment form validation'
    claude_code_max_turns: '30'
```

### With OAuth Token

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Commit the IronBee Config to the Repo

The files IronBee generates (`.ironbee/`, `.claude/`, `.mcp.json`, `.gitignore`) are kept out of the commits this action makes, because they are its working files rather than the change being verified. Turn that off to let a run commit the setup it generated — useful if you want it available for local development:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_exclude_files: 'false'
```

### With Custom IronBee Console URL

The PR comment includes a link to the IronBee Console for the verification session. The host is derived from `ironbee_collector_url`'s stage, falling back to `console.ironbee.ai`. Name it explicitly if you self-host:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_console_url: 'console.example.com'
```

### Enable Additional DevTools Platforms

By default only the browser platform runs. Opt into the others when you want IronBee to verify those layers too. They apply to **local mode** — a platform run uses the platforms its harness declares:

```yaml
- uses: ironbee-ai/ironbee-action@v1
  with:
    ironbee_api_key: ${{ secrets.IRONBEE_API_KEY }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    ironbee_browser_devtools: 'true'
    ironbee_backend_devtools: 'true'
    ironbee_node_devtools: 'false'
    ironbee_python_devtools: 'false'
    # A PTY on the runner — enable it only when the CLI is what you are verifying.
    ironbee_terminal_devtools: 'false'
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
| **Where the verification runs** | | | |
| `verification_mode` | No | `auto` | `auto`, `platform`, or `local` — see [Two ways to verify](#two-ways-to-verify) |
| **IronBee — account & endpoints** | | | |
| `ironbee_api_key` | Yes | | IronBee API key. Authenticates the collector, and the platform API in platform mode |
| `ironbee_api_url` | No | | IronBee API base URL. Empty uses the CLI default |
| `ironbee_collector_url` | No | | IronBee collector endpoint URL. Empty uses the CLI default — and leaving it empty is what lets the CLI resolve every other service URL to the same stage, since an explicit one here is how it infers which stage that is |
| `ironbee_console_url` | No | | IronBee Console hostname (no scheme) for session links in the report. Empty derives it from `ironbee_collector_url`, so a non-production collector does not produce production links |
| `ironbee_cli_version` | No | `latest` | IronBee CLI version to install. Empty means `latest`, so an `inputs.x \|\| vars.X` chain that resolves to nothing still works |
| `ironbee_project` | No | | Project the results attach to. Empty derives it from the git remote |
| **IronBee — the verification job** (platform mode only) | | | |
| `ironbee_bind_repository` | No | `true` | Bind the run to the repository so the agent reads the changeset. Turn it off to verify the application without repository context — what a private repository the IronBee GitHub App does not cover needs |
| `ironbee_job_timeout_minutes` | No | | Run timeout for the verification job. Empty uses the API default |
| **IronBee — DevTools platforms** (local mode only) | | | |
| `ironbee_browser_devtools` | No | `true` | Web UI, DOM, console, a11y, screenshots, recording |
| `ironbee_backend_devtools` | No | `false` | HTTP, gRPC, GraphQL, WebSocket, DB, logs |
| `ironbee_node_devtools` | No | `false` | Node.js runtime — tracepoints, exceptions, variables, HTTP capture |
| `ironbee_python_devtools` | No | `false` | Python runtime (debugpy) — tracepoints, exceptions, logs, thread dumps |
| `ironbee_terminal_devtools` | No | `false` | CLI, REPL and TUI verification by driving a PTY. **This gives the agent a shell on the runner** — enable it only where that is the thing being verified |
| **IronBee — config & repo hygiene** | | | |
| `ironbee_extra_config` | No | | Raw IronBee config (JSON) deep-merged into `.ironbee/config.json`; user keys win |
| `ironbee_exclude_files` | No | `true` | Keep IronBee-generated files (`.ironbee/`, `.claude/`, `.mcp.json`, `.gitignore`) out of the commits this action makes. Turn it off to let a run commit the IronBee setup it generated |
| **Claude Code — auth** | | | |
| `anthropic_api_key` | Yes* | | Anthropic API key for Claude Code |
| `claude_code_oauth_token` | No* | | Claude Code OAuth token (alternative auth) |
| **Claude Code — install & runtime** (local mode only) | | | |
| `claude_code_cli_version` | No | `latest` | Claude Code CLI version to install. Empty means `latest` |
| `claude_code_model` | No | | Claude model for the agent that runs on this runner. Platform mode uses the platform default |
| `claude_code_max_turns` | No | `100` | Maximum conversation turns for the agent that runs on this runner |
| `claude_code_args` | No | | Additional Claude Code CLI arguments |
| **What to verify, and what to do about it** | | | |
| `verification_prompt` | No | | Additional instructions for the verification agent. Reaches whichever engine runs |
| `verification_apply_fix` | No | `true` | Apply fixes for the issues a failing verification reports. Needs an Anthropic credential; without one the run verifies and reports only |
| **Application under test** | | | |
| `app_install_command` | No | | Command to install dependencies |
| `app_build_command` | No | | Command to build the application |
| `app_start_command` | No | | Command to start the application |
| `app_url` | No | | Application URL for verification. A **routable** URL is verified as a deployment; a `localhost` one means the application runs on this runner and is reached through a reverse tunnel |
| `app_port` | No | | Local port the application listens on, for a tunnelled target. Required when `app_start_command` is set without an `app_url`, or when `app_url` points at localhost without a port. No default — a guessed port tunnels to nothing. The port in `app_url` wins when both name one |
| `app_restart_command` | No | | Command that restarts the application so it picks up the fixes, run between the fix round and the re-verification. Empty stops the process this action started and re-runs `app_start_command` — right only when that command runs the application itself. One that hands off (docker compose, a process manager) leaves the pre-fix code running, and the re-verification then reports a confident result about code that no longer exists. For a compose project: `docker compose up -d --build` |
| `app_logs_command` | No | | Command that prints the application's own logs, captured into the evidence artifact. Needed whenever `app_start_command` hands off — what the action captures then is lifecycle chatter, not the application, so a service that died or stopped consuming leaves no trace. For compose: `docker compose logs --no-color --tail=2000` |
| `app_wait_seconds` | No | | How long to wait for the local application to accept connections. Empty uses the CLI default (60s) |
| `app_headers` | No | | Request headers for a deployed URL, one `Name: value` per line. **Non-secret values only** — they are stored in the clear and readable by anyone with any of the account's credentials |
| `app_secret_headers` | No | | Request headers whose values are secret — a deployment-protection bypass, an environment token. Same `Name: value` per line, from a GitHub secret. Encrypted before storage and never read back |
| **GitHub** | | | |
| `github_token` | No | `github.token` | GitHub token for PR operations |
| **Action — general behaviour** | | | |
| `working_directory` | No | `.` | Working directory for verification |
| `verbose` | No | `false` | Log tool responses, the prompt, the artifact list and verdict details |

Every `true`/`false` input also accepts `1`/`0`, `yes`/`no` and `on`/`off`. Anything else
fails the run naming the input — GitHub does not type-check action inputs, so a value
nobody validates is a setting that silently did not apply.

*Required for local mode, and for fixing in platform mode. A platform run that only verifies needs neither.

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | `pass`, `fail`, `not_applicable`, or `unknown` |
| `mode` | Where the verification ran: `platform` or `local` |
| `job_id` | Verification job id — platform mode only |
| `job_url` | IronBee Console link for the run — platform mode only, once the job has started |
| `artifacts_url` | Download URL for verification evidence — **local mode only**. In platform mode the evidence is captured on the platform and lives in the Console; this output is empty |

## How It Works

### Verification Flow

1. **Setup** — Installs `@ironbee-ai/cli`, `@anthropic-ai/claude-code`, `@ironbee-ai/devtools`, and Playwright Chromium (cached across runs)
2. **Configure** — Writes `.ironbee/config.json` with the collector URL, the DevTools platform enable flags, and the MCP `LOG_FILE` paths under `.ironbee/artifacts/` (deep-merging `ironbee_extra_config` on top), then runs `ironbee install --client claude` to set up hooks, skills, rules, and MCP config. The IronBee API key is passed via the `IRONBEE_API_KEY` env var (not written to disk) and inherited by hooks and MCP subprocesses
3. **Verify** — Claude Code runs `/ironbee-verify` (or `/ironbee-verify full` for manual/scheduled) which:
   - Reviews the code diff (push/PR) or tests the full app (manual/scheduled)
   - Builds and starts the application
   - Records sessions via the enabled DevTools modes and takes screenshots
   - Tests functionality and checks for errors
   - Submits a verdict (pass/fail)
4. **Fix** — If verification fails, Claude Code fixes the issues and re-verifies
5. **Report** — Posts a verification report on the PR with a session-level IronBee Console link, per-cycle verification links (`activityId` + `verificationId`), and a downloadable evidence artifact

### Fix Behavior

- **PR trigger** — fixes are committed and pushed to the PR branch
- **Push / Manual / Scheduled** — fixes go to a new branch and a PR is opened

The action performs the commit and the push itself. The agent only edits files.

### Re-verification after a fix

One fix round per run, and a re-verification only where it can mean something.

A **tunnelled** target is re-verified: the application is restarted with the fixed code and a second verification runs. A **deployed URL** is not — the deployment still serves the code that was deployed, so a second run would verify the same bytes and report a result unrelated to the fix. There the loop closes when the fix is deployed and the workflow runs again.

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
