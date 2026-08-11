#!/usr/bin/env node

// Every decision the action makes before it runs anything.
//
// It lives here rather than in the composite step that consumes it because a
// decision written in YAML-embedded shell cannot be tested: there is no way to
// ask "what would this do for a private repository with no Anthropic key" short
// of pushing a commit and waiting for a runner. Everything below is a pure
// function of its input — no filesystem, no network, no process.exit — so the
// test file can ask exactly that, for every combination.
//
// The shell entry point at the bottom is the only impure part, and it does
// nothing but read the environment, call `resolvePlan`, and write outputs.

'use strict';

const fs = require('fs');

/**
 * Hostnames and addresses the platform cannot reach.
 *
 * Mirrors the API's own rule rather than sharing it: this repository has no
 * dependencies and will not grow one for a predicate. The two can drift, and
 * the direction of the drift is safe — a host this calls routable and the API
 * does not is rejected at create time with a clear message, where the reverse
 * (calling a reachable host private) would only ever send a job through the
 * tunnel that could have used a URL.
 */
function isNonRoutableHost(host) {
  if (!host) {
    return true;
  }
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();

  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    return true;
  }
  // IPv6: loopback, unspecified, link-local (fe80::/10) and unique-local
  // (fc00::/7). Written as prefixes because the alternative is parsing IPv6,
  // and the set of prefixes that matter here is closed.
  if (bare.includes(':')) {
    return bare === '::1' || bare === '::'
      || bare.startsWith('fe8') || bare.startsWith('fe9')
      || bare.startsWith('fea') || bare.startsWith('feb')
      || bare.startsWith('fc') || bare.startsWith('fd');
  }
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127 || a === 0 || a === 10) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    return false;
  }
  // A name with no dot in it resolves only inside whatever network the runner
  // is on — a service alias, a container name, a bare host. The platform is on
  // a different network and would resolve it to nothing, or to something else.
  return !bare.includes('.');
}

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function truthy(value) {
  return /^(true|1|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

function present(value) {
  return String(value == null ? '' : value).trim().length > 0;
}

function positiveInt(value) {
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── The mode ladder ─────────────────────────────────────────────────────────

const MODE_AUTO = 'auto';
const MODE_LOCAL = 'local';
const MODE_PLATFORM = 'platform';

/**
 * Picks where the verification runs, and says why in a sentence the step logs.
 *
 * Reads two things, both free: whether the repository is private (the event
 * payload says) and whether an Anthropic credential was supplied (the action's
 * own configuration). Nothing is asked of the platform, so the decision costs
 * no round trip and no quota.
 *
 * The asymmetry it turns on: platform mode verifies a PUBLIC repository whether
 * or not the IronBee GitHub App is installed, because the run clones
 * unauthenticated when no installation covers the owner. A private repository
 * is the case that needs the App, and whether the App is there is the one thing
 * that cannot be checked for free — so a private repository goes to the engine
 * this action knows can run, when there is one.
 */
function resolveMode({ verificationMode, hasAnthropicCredential, repositoryPrivate }) {
  const requested = String(verificationMode || MODE_AUTO).trim().toLowerCase();

  if (requested === MODE_LOCAL || requested === MODE_PLATFORM) {
    return { mode: requested, reason: `verification_mode: ${requested}` };
  }
  if (requested !== MODE_AUTO) {
    return {
      mode: null,
      reason: null,
      error: `verification_mode must be one of auto, local, platform (got '${requested}')`,
    };
  }
  if (!repositoryPrivate) {
    return {
      mode: MODE_PLATFORM,
      reason: 'auto: the repository is public, so the platform can check it out',
    };
  }
  if (hasAnthropicCredential) {
    return {
      mode: MODE_LOCAL,
      reason: 'auto: the repository is private and an Anthropic credential is set — '
        + 'set verification_mode: platform if the IronBee GitHub App covers this repository',
    };
  }
  return {
    mode: MODE_PLATFORM,
    reason: 'auto: the repository is private and no Anthropic credential is set, '
      + 'so the platform is the only engine available',
  };
}

// ─── The target ──────────────────────────────────────────────────────────────

/**
 * Decides what gets verified, from the inputs a user already writes.
 *
 * A publicly routable `app_url` is verified directly. Anything else — a
 * loopback URL, or no URL at all with a start command — is an application that
 * exists only on this runner and is reached through the reverse tunnel.
 */
function resolveTarget({ appUrl, appStartCommand, appPort }) {
  const errors = [];
  const warnings = [];
  const declaredPort = present(appPort) ? positiveInt(appPort) : null;

  if (present(appPort) && declaredPort === null) {
    errors.push(`app_port must be a positive integer (got '${String(appPort).trim()}')`);
  }

  if (present(appUrl)) {
    const url = parseUrl(String(appUrl).trim());
    if (url === null) {
      errors.push(`app_url is not a URL: '${String(appUrl).trim()}'`);
      return { target: null, errors, warnings };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`app_url must be http or https (got '${url.protocol}')`);
      return { target: null, errors, warnings };
    }
    if (!isNonRoutableHost(url.hostname)) {
      return { target: { kind: 'url', url: url.href }, errors, warnings };
    }

    // A tunnel, whose port comes from the URL when the URL names one. When it
    // does not, `app_port` is used rather than the scheme's default: a
    // `http://localhost` written without a port means "the app", not "port 80",
    // and starting the tunnel on 80 fails with a connection refused that points
    // nowhere.
    //
    // The URL wins when both name a port, and a disagreement is a warning
    // rather than an error. `app_port` carries a default, so "the user set it"
    // and "nobody set it" are indistinguishable here — refusing the pair would
    // reject `app_url: http://localhost:4000` written next to a default nobody
    // typed. What the user did write is the URL.
    const urlPort = url.port === '' ? null : Number(url.port);
    if (urlPort !== null && declaredPort !== null && urlPort !== declaredPort) {
      warnings.push(
        `app_url names port ${String(urlPort)} and app_port is ${String(declaredPort)}; `
        + `tunnelling to ${String(urlPort)}, the one in the URL`,
      );
    }
    const port = urlPort !== null ? urlPort : declaredPort;
    if (port === null) {
      errors.push('app_url has no port and app_port is not set, so there is nothing to tunnel to');
      return { target: null, errors, warnings };
    }
    if (urlPort === null) {
      warnings.push(
        `app_url '${url.href}' names no port; tunnelling to app_port ${String(port)}`,
      );
    }
    return { target: { kind: 'tunnel', port }, errors, warnings };
  }

  if (present(appStartCommand)) {
    if (declaredPort === null) {
      errors.push('app_start_command is set but app_port is not, so there is nothing to tunnel to');
      return { target: null, errors, warnings };
    }
    return { target: { kind: 'tunnel', port: declaredPort }, errors, warnings };
  }

  errors.push(
    'no target: set app_url to a deployed URL, or app_start_command (with app_port) '
    + 'to start the application on this runner and verify it through a tunnel',
  );
  return { target: null, errors, warnings };
}

// ─── The repository binding ──────────────────────────────────────────────────

/**
 * Binds the run to what changed, from the event rather than from the checkout.
 *
 * The CLI can derive a binding itself and, on a GitHub Actions checkout, is
 * right to decline: a `pull_request` run sits on a merge commit no remote has
 * seen. Deriving would leave the run with no changeset while the prompt asks
 * the agent to read one, so the event's own numbers are passed instead.
 *
 * `baseUsable` is decided by the caller (a `git cat-file -e` on the base SHA),
 * because the first push of a branch reports an all-zero SHA and a force-push
 * can report one this checkout does not have — both of which are forty hex
 * characters and pass every shape check on the way to failing at the checkout.
 */
function resolveRepoBinding({ eventName, prNumber, sha, beforeSha, baseUsable }) {
  if (eventName === 'pull_request' && present(prNumber)) {
    return ['--pr', String(prNumber).trim()];
  }
  if (eventName === 'push' && present(sha)) {
    if (baseUsable && present(beforeSha)) {
      return ['--commit', String(sha).trim(), '--base', String(beforeSha).trim()];
    }
    return ['--commit', String(sha).trim(), '--no-diff'];
  }
  if (present(sha)) {
    return ['--commit', String(sha).trim(), '--no-diff'];
  }
  return [];
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

/** The CLI's own default, mirrored so the floor is computed from real numbers. */
const DEFAULT_QUEUE_WAIT_MINUTES = 15;
/** What a run needs beyond its budgets: installs, the report, the fix round. */
const OVERHEAD_MINUTES = 10;

/**
 * The `timeout-minutes` this configuration needs.
 *
 * Printed, never enforced: a composite action cannot read the job's own
 * timeout — GitHub exposes it in no context and no environment variable — so
 * the only thing that can be done about the failure mode (the step killed
 * mid-run, the job cancelled, and a platform failure blamed for it) is to say
 * the number up front, where it is visible before the failure rather than after.
 */
function timeoutFloorMinutes({ jobTimeoutMinutes }) {
  const job = positiveInt(jobTimeoutMinutes);
  return DEFAULT_QUEUE_WAIT_MINUTES + (job === null ? 60 : job) + OVERHEAD_MINUTES;
}

// ─── Inputs that describe an agent that is not running ───────────────────────

const LOCAL_ONLY_INPUTS = [
  ['model', 'model'],
  ['max_turns', 'maxTurns'],
  ['claude_args', 'claudeArgs'],
  ['ironbee_browser_devtools', 'browserDevtools'],
  ['ironbee_backend_devtools', 'backendDevtools'],
  ['ironbee_node_devtools', 'nodeDevtools'],
];

/**
 * Warns rather than ignoring. These configure the agent that runs on the
 * runner; in platform mode the agent runs elsewhere with the platform's own
 * settings, so a workflow carrying them is describing something that is not
 * happening — and silence would let it believe otherwise.
 */
function unusedInputWarnings(input) {
  const named = LOCAL_ONLY_INPUTS
    .filter(([, key]) => present(input[key]))
    .map(([name]) => name);
  if (named.length === 0) {
    return [];
  }
  return [
    `these inputs configure the local agent and do nothing in platform mode: ${named.join(', ')}`,
  ];
}

/**
 * `Name: value` per line, blanks and comments dropped.
 *
 * Lines rather than a JSON object because a workflow author writes these by
 * hand in YAML, where a nested JSON string is a quoting problem and a list of
 * lines is not. The CLI takes the same `Name: value` shape, so nothing is
 * reformatted on the way through.
 */
function parseHeaders(raw) {
  return String(raw == null ? '' : raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes(':'));
}

// ─── The plan ────────────────────────────────────────────────────────────────

function resolvePlan(input) {
  const errors = [];
  const warnings = [];

  const hasAnthropicCredential = present(input.anthropicApiKey) || present(input.claudeCodeOauthToken);
  const repositoryPrivate = truthy(input.repositoryPrivate);

  if (!present(input.ironbeeApiKey)) {
    errors.push('ironbee_api_key is required');
  }

  // A fork PR carries no secrets at all, so neither engine has a credential to
  // run with. Said as its own cause, because the alternative is an empty API
  // key surfacing as "ironbee_api_key is required" on a workflow that sets it.
  if (truthy(input.isFork)) {
    errors.push(
      'this is a pull request from a fork, which receives no secrets — '
      + 'neither verification mode can run',
    );
  }

  const { mode, reason, error: modeError } = resolveMode({
    verificationMode: input.verificationMode,
    hasAnthropicCredential,
    repositoryPrivate,
  });
  if (modeError) {
    errors.push(modeError);
  }

  if (mode === MODE_LOCAL && !hasAnthropicCredential) {
    errors.push('local verification needs anthropic_api_key or claude_code_oauth_token');
  }

  const { target, errors: targetErrors, warnings: targetWarnings } = resolveTarget({
    appUrl: input.appUrl,
    appStartCommand: input.appStartCommand,
    appPort: input.appPort,
  });
  errors.push(...targetErrors);
  warnings.push(...targetWarnings);

  if (mode === MODE_PLATFORM) {
    warnings.push(...unusedInputWarnings(input));
  }

  // A tunnel target's traffic reaches the application over a pipe from this
  // runner; nothing in that path could apply a header, so accepting one would
  // store a value that is never sent.
  if (mode === MODE_PLATFORM && target !== null && target.kind === 'tunnel'
      && (present(input.headers) || present(input.secretHeaders))) {
    errors.push('headers apply to a deployed URL only; a tunnel target passes no layer that could add them');
  }

  const fix = truthy(input.fix);
  // Gate-only is a legitimate configuration, not a failure: the verification
  // still runs and still decides the merge. Saying so is what stops it reading
  // as a broken setup.
  const canFix = fix && hasAnthropicCredential;
  if (mode === MODE_PLATFORM && fix && !hasAnthropicCredential) {
    warnings.push(
      'fix is enabled but no Anthropic credential is set — the run will verify and report, and fix nothing',
    );
  }

  const cliArgs = [];
  if (mode === MODE_PLATFORM && target !== null) {
    if (target.kind === 'url') {
      cliArgs.push('--url', target.url);
    } else {
      cliArgs.push('--port', String(target.port));
      if (positiveInt(input.appWaitSeconds) !== null) {
        cliArgs.push('--app-wait', String(positiveInt(input.appWaitSeconds)));
      }
    }
    for (const header of parseHeaders(input.headers)) {
      cliArgs.push('--header', header);
    }
    if (present(input.project)) {
      cliArgs.push('--project', String(input.project).trim());
    }
    if (positiveInt(input.jobTimeoutMinutes) !== null) {
      cliArgs.push('--timeout', String(positiveInt(input.jobTimeoutMinutes) * 60));
    }
    cliArgs.push(...resolveRepoBinding({
      eventName: input.eventName,
      prNumber: input.prNumber,
      sha: input.sha,
      beforeSha: input.beforeSha,
      baseUsable: truthy(input.baseUsable),
    }));
    cliArgs.push('--json');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    mode,
    modeReason: reason,
    target,
    cliArgs,
    canFix,
    // Started by this action only for a platform tunnel run. A deployed URL was
    // started by whoever deployed it, and in local mode the agent starts the
    // application itself from `app_start_command` in its prompt — starting it
    // here too would put two of them on one port.
    needsApp: mode === MODE_PLATFORM && target !== null && target.kind === 'tunnel',
    timeoutFloorMinutes: timeoutFloorMinutes({ jobTimeoutMinutes: input.jobTimeoutMinutes }),
  };
}

// ─── The shell entry point ───────────────────────────────────────────────────

function readInput() {
  return {
    verificationMode: process.env.INPUT_VERIFICATION_MODE,
    anthropicApiKey: process.env.INPUT_ANTHROPIC_API_KEY,
    claudeCodeOauthToken: process.env.INPUT_CLAUDE_CODE_OAUTH_TOKEN,
    ironbeeApiKey: process.env.INPUT_IRONBEE_API_KEY,
    repositoryPrivate: process.env.REPOSITORY_PRIVATE,
    isFork: process.env.IS_FORK,
    eventName: process.env.EVENT_NAME,
    prNumber: process.env.PR_NUMBER,
    sha: process.env.COMMIT_SHA,
    beforeSha: process.env.BEFORE_SHA,
    baseUsable: process.env.BASE_USABLE,
    appUrl: process.env.INPUT_APP_URL,
    appStartCommand: process.env.INPUT_APP_START_COMMAND,
    appPort: process.env.INPUT_APP_PORT,
    appWaitSeconds: process.env.INPUT_APP_WAIT_SECONDS,
    project: process.env.INPUT_IRONBEE_PROJECT,
    jobTimeoutMinutes: process.env.INPUT_JOB_TIMEOUT_MINUTES,
    headers: process.env.INPUT_APP_HEADERS,
    secretHeaders: process.env.INPUT_APP_SECRET_HEADERS,
    fix: process.env.INPUT_FIX,
    model: process.env.INPUT_MODEL,
    maxTurns: process.env.INPUT_MAX_TURNS,
    claudeArgs: process.env.INPUT_CLAUDE_ARGS,
    browserDevtools: process.env.INPUT_IRONBEE_BROWSER_DEVTOOLS,
    backendDevtools: process.env.INPUT_IRONBEE_BACKEND_DEVTOOLS,
    nodeDevtools: process.env.INPUT_IRONBEE_NODE_DEVTOOLS,
  };
}

/**
 * Multi-line values use the delimiter form. `cli_args` is written one argument
 * per line rather than as a single string: an argument can contain a space (a
 * project name, a URL with one), and re-splitting a joined string in shell is
 * how such a value silently becomes two arguments.
 *
 * `--secret-header` is deliberately NOT in here. A step output is written to a
 * file on the runner and survives the step, and a secret has no business in
 * one — so those arguments are emitted on demand instead, straight into the
 * step that runs the command ({@link emitSecretHeaderArgs}).
 */
function writeOutputs(plan) {
  const outputs = [
    ['mode', plan.mode || ''],
    ['target_kind', plan.target ? plan.target.kind : ''],
    ['target_port', plan.target && plan.target.kind === 'tunnel' ? String(plan.target.port) : ''],
    ['needs_app', plan.needsApp ? 'true' : 'false'],
    ['can_fix', plan.canFix ? 'true' : 'false'],
    ['timeout_floor_minutes', String(plan.timeoutFloorMinutes)],
  ];
  let body = outputs.map(([key, value]) => `${key}=${value}\n`).join('');
  body += `cli_args<<IRONBEE_EOF\n${plan.cliArgs.join('\n')}\nIRONBEE_EOF\n`;

  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    fs.appendFileSync(file, body);
  } else {
    process.stdout.write(body);
  }
}

/**
 * The `--secret-header` arguments, one per line, on stdout.
 *
 * A second entry point rather than part of the plan: this output carries the
 * caller's secret, so it goes directly into the step that consumes it and is
 * never written to a step output, where it would outlive the step in a file on
 * the runner.
 */
function emitSecretHeaderArgs() {
  const lines = [];
  for (const header of parseHeaders(process.env.INPUT_APP_SECRET_HEADERS)) {
    lines.push('--secret-header', header);
  }
  if (lines.length > 0) {
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

function main() {
  if (process.argv.includes('--secret-header-args')) {
    emitSecretHeaderArgs();
    return;
  }

  const plan = resolvePlan(readInput());

  for (const warning of plan.warnings) {
    console.log(`::warning::${warning}`);
  }
  for (const error of plan.errors) {
    console.log(`::error::${error}`);
  }
  if (!plan.ok) {
    process.exitCode = 1;
    return;
  }

  console.log(`IronBee verification mode: ${plan.mode} — ${plan.modeReason}`);
  if (plan.target.kind === 'url') {
    console.log(`Target: ${plan.target.url}`);
  } else {
    console.log(`Target: the application on port ${String(plan.target.port)}, through a reverse tunnel`);
  }
  console.log(
    `This configuration needs timeout-minutes of at least ${String(plan.timeoutFloorMinutes)} `
    + 'on the job that runs it.',
  );

  writeOutputs(plan);
}

module.exports = {
  resolvePlan,
  parseHeaders,
  emitSecretHeaderArgs,
  resolveMode,
  resolveTarget,
  resolveRepoBinding,
  isNonRoutableHost,
  timeoutFloorMinutes,
};

if (require.main === module) {
  main();
}
