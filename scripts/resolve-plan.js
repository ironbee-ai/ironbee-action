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

/**
 * The boolean vocabulary, written once.
 *
 * The same synonyms the config step's own `toBool` accepts, deliberately: two
 * spellings of "yes" inside one action is how `ironbee_browser_devtools: on`
 * ends up enabled in the generated config and reported as off in a warning.
 */
const BOOLEAN_TRUE = ['true', '1', 'yes', 'on'];
const BOOLEAN_FALSE = ['false', '0', 'no', 'off'];

/** For values GitHub itself produces, which are never mistyped by a human. */
function truthy(value) {
  return BOOLEAN_TRUE.includes(String(value == null ? '' : value).trim().toLowerCase());
}

/**
 * For values a workflow author typed.
 *
 * An action input has no type — GitHub validates nothing and hands the step a
 * string — so an unrecognised one has to be named here or it is not named
 * anywhere. Silently reading it as false is the failure this exists to stop:
 * `fix: flase` would disable fixing on every run, and the only symptom is a
 * feature that never happens.
 */
function parseBoolean(name, value, fallback, errors) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  // Empty is the declared default arriving through an expression that resolved
  // to nothing, not a value someone chose.
  if (raw === '') {
    return fallback;
  }
  if (BOOLEAN_TRUE.includes(raw)) {
    return true;
  }
  if (BOOLEAN_FALSE.includes(raw)) {
    return false;
  }
  errors.push(
    `${name} must be true or false (got '${String(value).trim()}') — `
    + `${BOOLEAN_TRUE.join('/')} and ${BOOLEAN_FALSE.join('/')} are accepted`,
  );
  return fallback;
}

/**
 * Every boolean input, with the default declared in `action.yml`.
 *
 * All of them, not only the ones this file reads: two are consumed directly by
 * a step's own `if:`, and validating them here is what makes a typo fail before
 * anything is installed rather than turn into a step that quietly did not run.
 */
const BOOLEAN_INPUTS = [
  ['verification_apply_fix', 'fix', true],
  ['ironbee_bind_repository', 'bindRepository', true],
  ['ironbee_exclude_files', 'excludeFiles', true],
  ['ironbee_browser_devtools', 'browserDevtools', true],
  ['ironbee_backend_devtools', 'backendDevtools', false],
  ['ironbee_node_devtools', 'nodeDevtools', false],
  ['ironbee_python_devtools', 'pythonDevtools', false],
  ['ironbee_terminal_devtools', 'terminalDevtools', false],
  ['verbose', 'verbose', false],
];

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
    // rather than an error. `app_port` carries no default, so reaching this
    // line means someone wrote both and they disagree — the URL is the more
    // specific statement, and it is the one that also decides the target.
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

// ─── The console the report links into ───────────────────────────────────────

/** The last resort, matching the CLI's own. */
const DEFAULT_CONSOLE_HOST = 'console.ironbee.ai';

/**
 * Where the report's session links point.
 *
 * Derived from the collector when nobody named one, because the two always name
 * the same stage and only one of them has to be configured for the run to work
 * at all. Without the derivation a workflow that sets only its collector — the
 * one setting a non-production stage cannot omit — gets its events written to
 * that stage and its links built into production, so every link in the report
 * 404s and the report looks like the broken thing.
 *
 * The CLI infers its own service domain from an explicit collector URL the same
 * way. This mirrors that rule rather than sharing it, for the reason
 * `isNonRoutableHost` does: this repository has no dependencies.
 */
function resolveConsoleUrl({ consoleUrl, collectorUrl }) {
  if (present(consoleUrl)) {
    return String(consoleUrl).trim();
  }
  const url = parseUrl(String(collectorUrl == null ? '' : collectorUrl).trim());
  const host = url === null ? '' : url.hostname.toLowerCase();
  if (host.startsWith('collector.service.')) {
    return `console.${host.slice('collector.service.'.length)}`;
  }
  return DEFAULT_CONSOLE_HOST;
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
 *
 * `parentSha` is the commit's own first parent, and it is what stands between a
 * base that says nothing and no changeset at all. Two things send a push there,
 * and both are the same loop: re-pushing a rewritten commit. Either the old tip
 * is orphaned and this checkout cannot resolve it (`baseUsable` false), or some
 * other ref still holds it and it resolves to a tree identical to the commit's
 * (`baseEmpty`) — a rewrite that changed no content, where "what this push
 * changed" is honestly nothing and binding it would leave the agent reviewing an
 * application instead of a change.
 *
 * `baseEmpty` is why this needs no input asking which base to use. An empty
 * changeset is not an answer, it is the base being the wrong one, and the parent
 * is strictly more to review rather than less — so nothing is traded away by
 * falling back on it, and nobody has to know to ask.
 */
function resolveRepoBinding({ eventName, prNumber, sha, beforeSha, baseUsable, baseEmpty, parentSha, bind }) {
  // Off means the run verifies the application and nothing else — no changeset,
  // no checkout. The case it exists for is a private repository the IronBee
  // GitHub App does not cover, where binding it fails the run at the agent's
  // front door with nothing verified.
  if (bind === false) {
    return ['--no-repo'];
  }
  if (eventName === 'pull_request' && present(prNumber)) {
    return ['--pr', String(prNumber).trim()];
  }
  if (eventName === 'push' && present(sha)) {
    // The event's own base first: a push can carry several commits, and only
    // `before` spans all of them. The parent spans the tip alone, so preferring
    // it would silently narrow a multi-commit push to its last commit — a gate
    // that reviews the last change and waves the ones before it through.
    if (baseUsable && !baseEmpty && present(beforeSha)) {
      return ['--commit', String(sha).trim(), '--base', String(beforeSha).trim()];
    }
    if (present(parentSha)) {
      return ['--commit', String(sha).trim(), '--base', String(parentSha).trim()];
    }
    return ['--commit', String(sha).trim(), '--no-diff'];
  }
  // Every other event — a manual dispatch, a schedule — gets the commit and no
  // changeset. The parent is available here too and is deliberately not used:
  // "the tip commit" is what a push is about, while a dispatch is about the
  // branch as it stands, and guessing its last commit was the interesting one
  // would point the agent at a change nobody asked about.
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
 *
 * `verifications` is how many platform jobs the run can hold, not how many it
 * will. A configuration that can fix runs a second one against the repaired
 * application, and counting only the first understated the floor by a whole job
 * timeout — the printed number was below what the run needed, on exactly the
 * path that needs the most.
 */
function timeoutFloorMinutes({ jobTimeoutMinutes, verifications }) {
  const job = positiveInt(jobTimeoutMinutes);
  const runs = positiveInt(verifications) ?? 1;
  return DEFAULT_QUEUE_WAIT_MINUTES + runs * (job === null ? 60 : job) + OVERHEAD_MINUTES;
}

// ─── Inputs that describe an agent that is not running ───────────────────────

const LOCAL_ONLY_INPUTS = [
  { name: 'claude_code_model', key: 'model', fallback: '' },
  { name: 'claude_code_max_turns', key: 'maxTurns', fallback: '100' },
  { name: 'claude_code_args', key: 'claudeArgs', fallback: '' },
  { name: 'ironbee_browser_devtools', key: 'browserDevtools', fallback: 'true' },
  { name: 'ironbee_backend_devtools', key: 'backendDevtools', fallback: 'false' },
  { name: 'ironbee_node_devtools', key: 'nodeDevtools', fallback: 'false' },
  { name: 'ironbee_python_devtools', key: 'pythonDevtools', fallback: 'false' },
  { name: 'ironbee_terminal_devtools', key: 'terminalDevtools', fallback: 'false' },
  { name: 'ironbee_extra_config', key: 'extraConfig', fallback: '' },
];

// ─── Inputs that describe a job that is not being created ────────────────────

const PLATFORM_ONLY_INPUTS = [
  { name: 'ironbee_bind_repository', key: 'bindRepository', fallback: 'true' },
  { name: 'ironbee_job_timeout_minutes', key: 'jobTimeoutMinutes', fallback: '' },
  { name: 'ironbee_project', key: 'project', fallback: '' },
  { name: 'app_restart_command', key: 'appRestartCommand', fallback: '' },
  { name: 'app_logs_command', key: 'appLogsCommand', fallback: '' },
  { name: 'app_wait_seconds', key: 'appWaitSeconds', fallback: '' },
  { name: 'app_headers', key: 'headers', fallback: '' },
  { name: 'app_secret_headers', key: 'secretHeaders', fallback: '' },
];

/**
 * Whether a workflow author actually chose this value.
 *
 * Compared against the declared default rather than tested for presence,
 * because an input with a default is *always* present: a step reads `'100'` for
 * `claude_code_max_turns` whether the workflow named it or not. Presence alone
 * would put every defaulted input in every warning, which trains the reader to
 * ignore the line the one time it names something they typed.
 */
function chosen(input, entry) {
  const raw = String(input[entry.key] == null ? '' : input[entry.key]).trim();
  return raw.length > 0 && raw.toLowerCase() !== entry.fallback;
}

/**
 * Warns rather than ignoring, in both directions.
 *
 * Each mode runs one engine and reads one half of these inputs. A workflow
 * carrying the other half is describing something that is not happening — and
 * the two halves are worth the same warning, because "I set a job timeout and
 * the run ignored it" is exactly as confusing as "I set a model and the run
 * ignored it".
 */
function unusedInputWarnings(mode, input) {
  const [entries, sentence] = mode === MODE_PLATFORM
    ? [LOCAL_ONLY_INPUTS, 'configure the agent that runs on this runner and do nothing in platform mode']
    : [PLATFORM_ONLY_INPUTS, 'configure the platform verification job and do nothing in local mode'];
  const named = entries.filter((entry) => chosen(input, entry)).map((entry) => entry.name);
  if (named.length === 0) {
    return [];
  }
  return [`these inputs ${sentence}: ${named.join(', ')}`];
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

  // Parsed before anything reads one, so a typo in any of them is named in the
  // same run as every other error rather than one deploy at a time.
  const flags = {};
  for (const [name, key, fallback] of BOOLEAN_INPUTS) {
    flags[key] = parseBoolean(name, input[key], fallback, errors);
  }

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

  if (mode !== null) {
    warnings.push(...unusedInputWarnings(mode, input));
  }

  // A tunnel target's traffic reaches the application over a pipe from this
  // runner; nothing in that path could apply a header, so accepting one would
  // store a value that is never sent.
  if (mode === MODE_PLATFORM && target !== null && target.kind === 'tunnel'
      && (present(input.headers) || present(input.secretHeaders))) {
    errors.push('headers apply to a deployed URL only; a tunnel target passes no layer that could add them');
  }

  const fix = flags.fix;
  // Gate-only is a legitimate configuration, not a failure: the verification
  // still runs and still decides the merge. Saying so is what stops it reading
  // as a broken setup.
  const canFix = fix && hasAnthropicCredential;
  if (mode === MODE_PLATFORM && fix && !hasAnthropicCredential) {
    warnings.push(
      'fix is enabled but no Anthropic credential is set — the run will verify and report, and fix nothing',
    );
  }

  // Started by this action only for a platform tunnel run. A deployed URL was
  // started by whoever deployed it, and in local mode the agent starts the
  // application itself from `app_start_command` in its prompt — starting it
  // here too would put two of them on one port.
  const needsApp = mode === MODE_PLATFORM && target !== null && target.kind === 'tunnel';

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
      bind: flags.bindRepository,
      eventName: input.eventName,
      prNumber: input.prNumber,
      sha: input.sha,
      beforeSha: input.beforeSha,
      baseUsable: truthy(input.baseUsable),
      baseEmpty: truthy(input.baseEmpty),
      parentSha: input.parentSha,
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
    needsApp,
    // Two verifications whenever a fix round can run and there is something to
    // restart: the first, then one against the repaired application.
    timeoutFloorMinutes: timeoutFloorMinutes({
      jobTimeoutMinutes: input.jobTimeoutMinutes,
      verifications: canFix && needsApp ? 2 : 1,
    }),
    // Normalised here and read back as step outputs, rather than compared
    // against `'true'` in each step's own `if:`. The comparison is a third
    // boolean vocabulary — narrower than this file's and narrower than the
    // config step's — so `verbose: on` would enable the flag in one place and
    // not the other, with nothing anywhere saying why.
    verbose: flags.verbose,
    excludeFiles: flags.excludeFiles,
    consoleUrl: resolveConsoleUrl({ consoleUrl: input.consoleUrl, collectorUrl: input.collectorUrl }),
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
    baseEmpty: process.env.BASE_EMPTY,
    parentSha: process.env.PARENT_SHA,
    appUrl: process.env.INPUT_APP_URL,
    appStartCommand: process.env.INPUT_APP_START_COMMAND,
    appPort: process.env.INPUT_APP_PORT,
    appRestartCommand: process.env.INPUT_APP_RESTART_COMMAND,
    appLogsCommand: process.env.INPUT_APP_LOGS_COMMAND,
    appWaitSeconds: process.env.INPUT_APP_WAIT_SECONDS,
    project: process.env.INPUT_IRONBEE_PROJECT,
    consoleUrl: process.env.INPUT_IRONBEE_CONSOLE_URL,
    collectorUrl: process.env.INPUT_IRONBEE_COLLECTOR_URL,
    bindRepository: process.env.INPUT_IRONBEE_BIND_REPOSITORY,
    jobTimeoutMinutes: process.env.INPUT_IRONBEE_JOB_TIMEOUT_MINUTES,
    headers: process.env.INPUT_APP_HEADERS,
    secretHeaders: process.env.INPUT_APP_SECRET_HEADERS,
    fix: process.env.INPUT_VERIFICATION_APPLY_FIX,
    model: process.env.INPUT_CLAUDE_CODE_MODEL,
    maxTurns: process.env.INPUT_CLAUDE_CODE_MAX_TURNS,
    claudeArgs: process.env.INPUT_CLAUDE_CODE_ARGS,
    browserDevtools: process.env.INPUT_IRONBEE_BROWSER_DEVTOOLS,
    backendDevtools: process.env.INPUT_IRONBEE_BACKEND_DEVTOOLS,
    nodeDevtools: process.env.INPUT_IRONBEE_NODE_DEVTOOLS,
    pythonDevtools: process.env.INPUT_IRONBEE_PYTHON_DEVTOOLS,
    terminalDevtools: process.env.INPUT_IRONBEE_TERMINAL_DEVTOOLS,
    excludeFiles: process.env.INPUT_IRONBEE_EXCLUDE_FILES,
    extraConfig: process.env.INPUT_IRONBEE_EXTRA_CONFIG,
    verbose: process.env.INPUT_VERBOSE,
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
    ['verbose', plan.verbose ? 'true' : 'false'],
    ['exclude_files', plan.excludeFiles ? 'true' : 'false'],
    ['console_url', plan.consoleUrl],
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
  parseBoolean,
  resolveConsoleUrl,
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
