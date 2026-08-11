'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePlan,
  resolveMode,
  resolveTarget,
  resolveRepoBinding,
  isNonRoutableHost,
  timeoutFloorMinutes,
  parseHeaders,
  emitSecretHeaderArgs,
  parseBoolean,
  resolveConsoleUrl,
} = require('../scripts/resolve-plan.js');

/** A configuration that resolves cleanly, so each test changes one thing. */
function input(overrides) {
  return {
    ironbeeApiKey: 'ib-key',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    verificationMode: 'auto',
    repositoryPrivate: 'false',
    isFork: 'false',
    eventName: 'pull_request',
    prNumber: '42',
    sha: 'a'.repeat(40),
    beforeSha: '',
    baseUsable: 'false',
    appUrl: 'https://shop.example.com',
    appStartCommand: '',
    appPort: '3000',
    fix: 'true',
    ...overrides,
  };
}

// ─── Routability ─────────────────────────────────────────────────────────────
//
// The predicate decides whether a URL is verified directly or tunnelled, so a
// wrong answer either sends the platform at an address it cannot resolve or
// tunnels a deployment that did not need it.

test('routability: loopback and unspecified addresses are not routable', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', '0.0.0.0', '::1', '::', '[::1]']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: private IPv4 ranges are not routable', () => {
  for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.1.1']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: addresses just outside the private ranges are routable', () => {
  for (const host of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '169.253.0.1']) {
    assert.equal(isNonRoutableHost(host), false, host);
  }
});

test('routability: IPv6 link-local and unique-local are not routable', () => {
  for (const host of ['fe80::1', 'fd00::1', 'fc00::1', 'FE80::1']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: a global IPv6 address is routable', () => {
  assert.equal(isNonRoutableHost('2606:4700::1111'), false);
});

test('routability: localhost and any .localhost name are not routable', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

// A container name, a service alias, a bare host — all resolve only inside the
// runner's own network, and the platform is on a different one.
test('routability: a hostname with no dot is not routable', () => {
  for (const host of ['web', 'app-under-test']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: an ordinary domain is routable', () => {
  for (const host of ['shop.example.com', 'preview-abc.vercel.app']) {
    assert.equal(isNonRoutableHost(host), false, host);
  }
});

test('routability: an empty host is treated as unreachable', () => {
  assert.equal(isNonRoutableHost(''), true);
  assert.equal(isNonRoutableHost(undefined), true);
});

// ─── The mode ladder ─────────────────────────────────────────────────────────

test('mode: an explicit choice wins over every signal', () => {
  for (const mode of ['local', 'platform']) {
    const resolved = resolveMode({
      verificationMode: mode,
      hasAnthropicCredential: false,
      repositoryPrivate: true,
    });
    assert.equal(resolved.mode, mode);
  }
});

test('mode: a public repository goes to the platform', () => {
  const resolved = resolveMode({
    verificationMode: 'auto',
    hasAnthropicCredential: true,
    repositoryPrivate: false,
  });
  assert.equal(resolved.mode, 'platform');
  assert.match(resolved.reason, /public/);
});

// The one case that cannot be checked for free: a private repository needs the
// GitHub App, so auto prefers the engine it knows can run.
test('mode: a private repository with a credential goes local', () => {
  const resolved = resolveMode({
    verificationMode: 'auto',
    hasAnthropicCredential: true,
    repositoryPrivate: true,
  });
  assert.equal(resolved.mode, 'local');
  assert.match(resolved.reason, /verification_mode: platform/);
});

test('mode: a private repository with no credential goes to the platform anyway', () => {
  const resolved = resolveMode({
    verificationMode: 'auto',
    hasAnthropicCredential: false,
    repositoryPrivate: true,
  });
  assert.equal(resolved.mode, 'platform');
  assert.match(resolved.reason, /only engine/);
});

test('mode: an unknown value is an error, not a silent default', () => {
  const resolved = resolveMode({
    verificationMode: 'cloud',
    hasAnthropicCredential: true,
    repositoryPrivate: false,
  });
  assert.equal(resolved.mode, null);
  assert.match(resolved.error, /auto, local, platform/);
});

test('mode: an OAuth token counts as an Anthropic credential', () => {
  const plan = resolvePlan(input({
    repositoryPrivate: 'true',
    claudeCodeOauthToken: 'oat-token',
  }));
  assert.equal(plan.mode, 'local');
});

// ─── Targets ─────────────────────────────────────────────────────────────────

test('target: a routable app_url is verified directly', () => {
  const { target, errors } = resolveTarget({ appUrl: 'https://shop.example.com/', appPort: '3000' });
  assert.deepEqual(errors, []);
  assert.equal(target.kind, 'url');
  assert.equal(target.url, 'https://shop.example.com/');
});

test('target: a loopback app_url becomes a tunnel on the URL\'s port', () => {
  const { target } = resolveTarget({ appUrl: 'http://localhost:4000', appPort: '3000' });
  assert.equal(target.kind, 'tunnel');
  assert.equal(target.port, 4000);
});

// Writing http://localhost means "the app", not "port 80" — starting the tunnel
// on 80 fails with a connection refused that points at nothing.
test('target: a portless loopback app_url falls back to app_port and says so', () => {
  const { target, warnings } = resolveTarget({ appUrl: 'http://localhost', appPort: '3000' });
  assert.equal(target.kind, 'tunnel');
  assert.equal(target.port, 3000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /names no port/);
});

test('target: a start command with a port is a tunnel', () => {
  const { target } = resolveTarget({ appStartCommand: 'npm run dev', appPort: '3000' });
  assert.equal(target.kind, 'tunnel');
  assert.equal(target.port, 3000);
});

// `app_port` carries a default, so "the user set it" and "nobody set it" are
// indistinguishable — refusing the pair would reject a URL written next to a
// default nobody typed. What the user did write is the URL.
test('target: when both name a port the URL wins, with a warning', () => {
  const { target, errors, warnings } = resolveTarget({
    appUrl: 'http://127.0.0.1:4000', appPort: '3001',
  });
  assert.deepEqual(errors, []);
  assert.equal(target.port, 4000);
  assert.match(warnings[0], /4000/);
  assert.match(warnings[0], /3001/);
});

test('target: two ports that agree is fine', () => {
  const { target, errors } = resolveTarget({ appUrl: 'http://localhost:3000', appPort: '3000' });
  assert.deepEqual(errors, []);
  assert.equal(target.port, 3000);
});

test('target: a portless loopback URL with no app_port has nothing to tunnel to', () => {
  const { target, errors } = resolveTarget({ appUrl: 'http://localhost', appPort: '' });
  assert.equal(target, null);
  assert.match(errors[0], /nothing to tunnel to/);
});

test('target: a start command with no app_port has nothing to tunnel to', () => {
  const { target, errors } = resolveTarget({ appStartCommand: 'npm run dev', appPort: '' });
  assert.equal(target, null);
  assert.match(errors[0], /nothing to tunnel to/);
});

test('target: neither input is an error that names both ways forward', () => {
  const { target, errors } = resolveTarget({ appUrl: '', appStartCommand: '', appPort: '3000' });
  assert.equal(target, null);
  assert.match(errors[0], /app_url/);
  assert.match(errors[0], /app_start_command/);
});

test('target: a malformed URL is rejected as one', () => {
  const { target, errors } = resolveTarget({ appUrl: 'not a url', appPort: '3000' });
  assert.equal(target, null);
  assert.match(errors[0], /not a URL/);
});

test('target: a non-http scheme is rejected', () => {
  const { target, errors } = resolveTarget({ appUrl: 'ftp://shop.example.com', appPort: '3000' });
  assert.equal(target, null);
  assert.match(errors[0], /http or https/);
});

test('target: a non-numeric app_port is rejected', () => {
  const { errors } = resolveTarget({ appStartCommand: 'npm run dev', appPort: 'three thousand' });
  assert.match(errors[0], /positive integer/);
});

// ─── Repository binding ──────────────────────────────────────────────────────

test('binding: a pull request binds by number', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'pull_request', prNumber: '42', sha: 'a'.repeat(40) }),
    ['--pr', '42'],
  );
});

// The comment's own event carries no commit, and `github.sha` on it points at
// the default branch rather than at anything under review — so the number is
// the only honest binding, and it is the same one the pull request itself uses.
test('binding: a comment binds to the pull request it was left on', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'issue_comment', prNumber: '42', sha: 'a'.repeat(40) }),
    ['--pr', '42'],
  );
});

test('binding: a comment with no pull request number falls back rather than guessing', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'issue_comment', prNumber: '', sha: 'a'.repeat(40), parentSha: 'c'.repeat(40) }),
    ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
  );
});

test('binding: a push with a usable base measures from it', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push', sha: 'a'.repeat(40), beforeSha: 'b'.repeat(40), baseUsable: true,
    }),
    ['--commit', 'a'.repeat(40), '--base', 'b'.repeat(40)],
  );
});

// The first push of a branch reports an all-zero SHA, and a force-push can name
// one this checkout does not have. Both are forty hex characters and would pass
// every shape check on the way to failing at the platform's own checkout.
test('binding: a push with an unusable base falls back to the commit parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: '0'.repeat(40),
      baseUsable: false,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
  );
});

// Only with nothing left to measure from — a repository's first commit.
test('binding: a push with no usable base and no parent declares no changeset', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push', sha: 'a'.repeat(40), beforeSha: '0'.repeat(40), baseUsable: false, parentSha: '',
    }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

// A push can carry several commits and only `before` spans all of them, so the
// parent must never win over a usable base — it would silently narrow the
// changeset to the last commit of the push.
test('binding: a usable base outranks the parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'b'.repeat(40)],
  );
});

// A dispatch is nearly always a push being re-run — with fixing off, in local
// mode, after a configuration change — and a run with no changeset answers a
// different question than the one it repeats, invisibly.
test('binding: a manual or scheduled run measures from the commit parent', () => {
  for (const eventName of ['workflow_dispatch', 'schedule']) {
    assert.deepEqual(
      resolveRepoBinding({ eventName, sha: 'a'.repeat(40), parentSha: 'c'.repeat(40) }),
      ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
    );
  }
});

test('binding: a manual run with no parent still binds the commit', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'workflow_dispatch', sha: 'a'.repeat(40), parentSha: '' }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

// A private repository the App does not cover fails at the agent's front door
// with nothing verified; unbinding it verifies the application instead.
test('binding: turning it off declares no repository at all', () => {
  assert.deepEqual(
    resolveRepoBinding({ bind: false, eventName: 'pull_request', prNumber: '42', sha: 'a'.repeat(40) }),
    ['--no-repo'],
  );
});

test('plan: bind_repository=false reaches the CLI', () => {
  const plan = resolvePlan(input({ bindRepository: 'false' }));
  assert.equal(plan.ok, true);
  assert.ok(plan.cliArgs.includes('--no-repo'));
  assert.equal(plan.cliArgs.includes('--pr'), false);
});

test('plan: bind_repository defaults to binding', () => {
  assert.ok(resolvePlan(input()).cliArgs.includes('--pr'));
});

test('binding: nothing to bind produces no flags', () => {
  assert.deepEqual(resolveRepoBinding({ eventName: 'push', sha: '' }), []);
});

// ─── The whole plan ──────────────────────────────────────────────────────────

test('plan: a public repo with a URL resolves to a platform run', () => {
  const plan = resolvePlan(input());
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'platform');
  assert.equal(plan.needsApp, false);
  assert.deepEqual(plan.cliArgs.slice(0, 2), ['--url', 'https://shop.example.com/']);
  assert.ok(plan.cliArgs.includes('--json'));
  assert.deepEqual(plan.cliArgs.slice(-3, -1), ['--pr', '42']);
});

test('plan: a missing IronBee key is an error', () => {
  const plan = resolvePlan(input({ ironbeeApiKey: '' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /ironbee_api_key is required/);
});

// A fork PR receives no secrets, so neither engine has a credential. Naming the
// fork is what stops it reading as a workflow that forgot to set its key.
test('plan: a fork pull request is refused by its own cause', () => {
  const plan = resolvePlan(input({ isFork: 'true' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /fork/);
});

test('plan: local mode without an Anthropic credential is an error', () => {
  const plan = resolvePlan(input({ verificationMode: 'local' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /anthropic_api_key or claude_code_oauth_token/);
});

test('plan: local mode with a credential is fine and starts no CLI run', () => {
  const plan = resolvePlan(input({ verificationMode: 'local', anthropicApiKey: 'sk-ant' }));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.cliArgs, []);
});

test('plan: a tunnel target asks for the application to be started', () => {
  const plan = resolvePlan(input({ appUrl: '', appStartCommand: 'npm run dev', appPort: '3000' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.needsApp, true);
  assert.deepEqual(plan.cliArgs.slice(0, 2), ['--port', '3000']);
});

// In local mode the agent starts the application itself, from the start command
// in its prompt. Starting it here too would put two of them on one port.
test('plan: local mode never asks the action to start the application', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local',
    anthropicApiKey: 'sk-ant',
    appUrl: 'http://localhost:3000',
    appStartCommand: 'npm run dev',
  }));
  assert.equal(plan.ok, true);
  assert.equal(plan.needsApp, false);
});

test('plan: app_wait_seconds reaches the CLI only when set', () => {
  const withWait = resolvePlan(input({
    appUrl: '', appStartCommand: 'npm run dev', appPort: '3000', appWaitSeconds: '180',
  }));
  assert.ok(withWait.cliArgs.includes('--app-wait'));
  assert.equal(withWait.cliArgs[withWait.cliArgs.indexOf('--app-wait') + 1], '180');

  const withoutWait = resolvePlan(input({ appUrl: '', appStartCommand: 'npm run dev', appPort: '3000' }));
  assert.equal(withoutWait.cliArgs.includes('--app-wait'), false);
});

test('plan: headers are refused for a tunnel target', () => {
  const plan = resolvePlan(input({
    appUrl: '', appStartCommand: 'npm run dev', appPort: '3000', headers: 'X-E2E: 1',
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /deployed URL only/);
});

test('plan: the job timeout reaches the CLI in seconds', () => {
  const plan = resolvePlan(input({ jobTimeoutMinutes: '30' }));
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--timeout') + 1], '1800');
});

test('plan: an explicit project overrides the derived one', () => {
  const plan = resolvePlan(input({ project: 'shop' }));
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--project') + 1], 'shop');
});

// These configure the agent that runs on the runner. In platform mode it does
// not run, so a workflow carrying them is describing something that is not
// happening — and silence would let it keep believing so.
test('plan: local-only inputs warn in platform mode', () => {
  const plan = resolvePlan(input({ model: 'claude-sonnet-5', maxTurns: '50' }));
  assert.equal(plan.ok, true);
  assert.match(plan.warnings.join(' '), /claude_code_model/);
  assert.match(plan.warnings.join(' '), /claude_code_max_turns/);
});

test('plan: local-only inputs are silent in local mode', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local', anthropicApiKey: 'sk-ant', model: 'claude-sonnet-5',
  }));
  assert.deepEqual(plan.warnings, []);
});

// An input with a default is always present, so presence cannot mean "the
// author chose it". Testing presence put every defaulted input in the warning
// on every platform run, which trains the reader to skip the line the one time
// it names something they typed.
test('plan: an input left at its declared default warns about nothing', () => {
  const plan = resolvePlan(input({
    maxTurns: '100',
    browserDevtools: 'true',
    backendDevtools: 'false',
    nodeDevtools: 'false',
    pythonDevtools: 'false',
    terminalDevtools: 'false',
  }));
  assert.equal(plan.mode, 'platform');
  assert.equal(plan.warnings.join(' ').includes('do nothing in platform mode'), false);
});

test('plan: a devtools flag moved off its default warns in platform mode', () => {
  const plan = resolvePlan(input({ pythonDevtools: 'true', terminalDevtools: 'true' }));
  assert.match(plan.warnings.join(' '), /ironbee_python_devtools/);
  assert.match(plan.warnings.join(' '), /ironbee_terminal_devtools/);
});

// The mirror image, and worth the same warning: "I set a job timeout and the
// run ignored it" is exactly as confusing as "I set a model and the run
// ignored it".
test('plan: platform-only inputs warn in local mode', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local',
    anthropicApiKey: 'sk-ant',
    jobTimeoutMinutes: '30',
    project: 'shop',
    headers: 'X-Marker: one',
    bindRepository: 'false',
    appRestartCommand: 'docker compose up -d --build',
    appLogsCommand: 'docker compose logs',
  }));
  assert.equal(plan.ok, true);
  const text = plan.warnings.join(' ');
  assert.match(text, /do nothing in local mode/);
  assert.match(text, /ironbee_job_timeout_minutes/);
  assert.match(text, /ironbee_project/);
  assert.match(text, /app_headers/);
  assert.match(text, /ironbee_bind_repository/);
  assert.match(text, /app_restart_command/);
  assert.match(text, /app_logs_command/);
});

test('plan: platform-only inputs are silent in platform mode', () => {
  const plan = resolvePlan(input({ jobTimeoutMinutes: '30', project: 'shop' }));
  assert.equal(plan.warnings.join(' ').includes('do nothing in local mode'), false);
});

// ─── Booleans ────────────────────────────────────────────────────────────────
//
// An action input has no type — GitHub validates nothing and hands the step a
// string — so an unrecognised one is named here or it is named nowhere.

test('boolean: the accepted spellings all resolve', () => {
  const errors = [];
  for (const yes of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
    assert.equal(parseBoolean('flag', yes, false, errors), true, yes);
  }
  for (const no of ['false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(parseBoolean('flag', no, true, errors), false, no);
  }
  assert.deepEqual(errors, []);
});

// Empty is the declared default arriving through an expression that resolved to
// nothing, not a value someone chose.
test('boolean: empty takes the declared default without complaining', () => {
  const errors = [];
  assert.equal(parseBoolean('flag', '', true, errors), true);
  assert.equal(parseBoolean('flag', undefined, false, errors), false);
  assert.deepEqual(errors, []);
});

test('boolean: an unrecognised value is named, not read as false', () => {
  const errors = [];
  parseBoolean('fix', 'flase', true, errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /fix must be true or false/);
  assert.match(errors[0], /flase/);
  assert.match(errors[0], /yes/);
});

// The failure this exists to stop: fixing silently off on every run, with no
// symptom but a feature that never happens.
test('plan: a mistyped fix fails the run instead of disabling fixing', () => {
  const plan = resolvePlan(input({ anthropicApiKey: 'sk-ant', fix: 'flase' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /verification_apply_fix must be true or false/);
});

test('plan: a mistyped boolean is named for every input that takes one', () => {
  const plan = resolvePlan(input({
    bindRepository: 'nope',
    nodeDevtools: 'enable',
    verbose: 'loud',
    excludeFiles: 'sure',
  }));
  assert.equal(plan.ok, false);
  const text = plan.errors.join(' ');
  for (const name of ['ironbee_bind_repository', 'ironbee_node_devtools', 'verbose', 'ironbee_exclude_files']) {
    assert.match(text, new RegExp(name));
  }
});

test('plan: a synonym reaches the decision it configures', () => {
  const off = resolvePlan(input({ verificationMode: 'platform', bindRepository: 'off' }));
  assert.equal(off.cliArgs.includes('--no-repo'), true);
  const on = resolvePlan(input({ verificationMode: 'platform', bindRepository: 'on' }));
  assert.equal(on.cliArgs.includes('--no-repo'), false);
});

// Normalised once here and read back as step outputs, so a step's own `if:`
// cannot apply a narrower vocabulary than the one this file accepts.
test('plan: verbose and exclude_files come back normalised', () => {
  const on = resolvePlan(input({ verbose: 'yes', excludeFiles: 'ON' }));
  assert.equal(on.verbose, true);
  assert.equal(on.excludeFiles, true);

  const off = resolvePlan(input({ verbose: 'NO', excludeFiles: 'off' }));
  assert.equal(off.verbose, false);
  assert.equal(off.excludeFiles, false);

  // Unset lands on each one's own declared default, which they do not share.
  const unset = resolvePlan(input({}));
  assert.equal(unset.verbose, false);
  assert.equal(unset.excludeFiles, true);
});

// Gate-only is a legitimate configuration: the verification still runs and
// still decides the merge. Saying so is what stops it reading as broken.
test('plan: fix without a credential degrades to gate-only with a warning', () => {
  const plan = resolvePlan(input({ fix: 'true' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.canFix, false);
  assert.match(plan.warnings.join(' '), /fix nothing/);
});

test('plan: fix with a credential is allowed in platform mode', () => {
  const plan = resolvePlan(input({ anthropicApiKey: 'sk-ant', repositoryPrivate: 'false' }));
  assert.equal(plan.mode, 'platform');
  assert.equal(plan.canFix, true);
});

test('plan: fix disabled turns the fix round off', () => {
  const plan = resolvePlan(input({ anthropicApiKey: 'sk-ant', fix: 'false' }));
  assert.equal(plan.canFix, false);
});

// ─── The comment command's fix ───────────────────────────────────────────────
//
// Two rules, and they compose in one direction only: the command has to ask,
// and the setting has to allow. A comment can decline a fix the repository
// permits; it cannot permit one the repository declined.

function comment(overrides) {
  return input({ eventName: 'issue_comment', anthropicApiKey: 'sk-ant', ...overrides });
}

test('plan: a comment without --fix verifies only, whatever the setting says', () => {
  assert.equal(resolvePlan(comment({ fix: 'true', commandFix: '' })).canFix, false);
});

test('plan: a comment with --fix fixes when the setting allows it', () => {
  assert.equal(resolvePlan(comment({ fix: 'true', commandFix: 'true' })).canFix, true);
});

// The ceiling. A repository that switched fixing off decided something about
// commits landing on its branches, and a comment is not where that is reversed.
test('plan: --fix cannot turn fixing on where the repository switched it off', () => {
  const plan = resolvePlan(comment({ fix: 'false', commandFix: 'true' }));

  assert.equal(plan.canFix, false);
  assert.equal(plan.ok, true);
  assert.match(plan.warnings.join(' '), /switched off for this repository/);
});

// Silence would leave the author waiting for commits that are never coming.
test('plan: a repository-permitted fix says nothing about a ceiling', () => {
  const plan = resolvePlan(comment({ fix: 'true', commandFix: 'true' }));
  assert.doesNotMatch(plan.warnings.join(' '), /switched off/);
});

// A comment run holds the base repository's secrets, so this is the one refusal
// whose reason differs from the `pull_request` one — and saying the wrong one
// would tell an operator the opposite of what is true.
test('plan: a comment on a fork pull request is refused for holding secrets', () => {
  const plan = resolvePlan(comment({ isFork: 'true' }));

  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /holds this repository's secrets/);
});

// ─── The budget floor ────────────────────────────────────────────────────────

test('floor: the default job timeout produces a floor above the queue wait', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '' }), 15 + 60 + 10);
});

// A fix round runs a second verification against the repaired application, and
// counting only the first understated the floor by a whole job timeout — on the
// one path that needs the most.
test('floor: a run that can fix budgets for both verifications', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '45', verifications: 1 }), 15 + 45 + 10);
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '45', verifications: 2 }), 15 + 90 + 10);
});

test('plan: the floor covers the re-verification when one can happen', () => {
  const canFix = resolvePlan(input({
    verificationMode: 'platform',
    anthropicApiKey: 'sk-ant',
    appUrl: '',
    appStartCommand: 'npm start',
    appPort: '4000',
    jobTimeoutMinutes: '45',
  }));
  assert.equal(canFix.needsApp, true);
  assert.equal(canFix.timeoutFloorMinutes, 15 + 90 + 10);

  // A deployed URL is never restarted, so no second verification is possible.
  const deployed = resolvePlan(input({
    verificationMode: 'platform',
    anthropicApiKey: 'sk-ant',
    jobTimeoutMinutes: '45',
  }));
  assert.equal(deployed.needsApp, false);
  assert.equal(deployed.timeoutFloorMinutes, 15 + 45 + 10);
});

test('floor: an explicit job timeout is what the floor is built from', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '30' }), 15 + 30 + 10);
});

test('floor: a nonsense timeout falls back rather than producing a nonsense floor', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '-5' }), 15 + 60 + 10);
});

// ─── Headers ─────────────────────────────────────────────────────────────────

test('headers: one per line, in the shape the CLI takes', () => {
  assert.deepEqual(parseHeaders('X-E2E: 1\nX-Trace: abc'), ['X-E2E: 1', 'X-Trace: abc']);
});

test('headers: blank lines, comments and lines without a colon are dropped', () => {
  assert.deepEqual(
    parseHeaders('\n  \n# a comment\nnot-a-header\nX-E2E: 1\n'),
    ['X-E2E: 1'],
  );
});

test('headers: nothing configured produces nothing', () => {
  assert.deepEqual(parseHeaders(''), []);
  assert.deepEqual(parseHeaders(undefined), []);
});

test('plan: headers reach the CLI for a URL target', () => {
  const plan = resolvePlan(input({ headers: 'X-E2E: 1' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--header') + 1], 'X-E2E: 1');
});

// A step output is a file on the runner that outlives the step. The secret
// half is emitted on demand instead, straight into the step that runs the
// command — so it must not appear here.
test('plan: secret headers never reach the step output', () => {
  const plan = resolvePlan(input({ headers: 'X-E2E: 1', secretHeaders: 'X-Bypass: the-secret' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--header') + 1], 'X-E2E: 1');
  assert.equal(plan.cliArgs.includes('--secret-header'), false);
  assert.equal(plan.cliArgs.join(' ').includes('the-secret'), false);
});

test('emitSecretHeaderArgs: one flag and value per configured header', () => {
  const written = [];
  const realWrite = process.stdout.write;
  process.env.INPUT_APP_SECRET_HEADERS = 'X-Bypass: the-secret\nX-Token: another';
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    emitSecretHeaderArgs();
  } finally {
    process.stdout.write = realWrite;
    delete process.env.INPUT_APP_SECRET_HEADERS;
  }

  assert.deepEqual(written.join('').trim().split('\n'), [
    '--secret-header', 'X-Bypass: the-secret',
    '--secret-header', 'X-Token: another',
  ]);
});

test('emitSecretHeaderArgs: writes nothing when none are configured', () => {
  const written = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    emitSecretHeaderArgs();
  } finally {
    process.stdout.write = realWrite;
  }

  assert.equal(written.join(''), '');
});

test('plan: secret headers are refused for a tunnel target too', () => {
  const plan = resolvePlan(input({
    appUrl: '', appStartCommand: 'npm run dev', appPort: '3000', secretHeaders: 'X-Bypass: s',
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /deployed URL only/);
});

// ─── The console the report links into ───────────────────────────────────────
//
// The failure this prevents: a workflow that names only its collector — the one
// setting a non-production stage cannot omit — writes its events to that stage
// and builds every report link into production. Each link 404s, and the report
// is what looks broken.

test('console: an explicit host wins over anything derivable', () => {
  assert.equal(
    resolveConsoleUrl({ consoleUrl: 'console.internal', collectorUrl: 'https://collector.service.ironbee.dev' }),
    'console.internal',
  );
});

test('console: an unset host follows the collector to its stage', () => {
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '', collectorUrl: 'https://collector.service.ironbee.dev' }),
    'console.ironbee.dev',
  );
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '  ', collectorUrl: 'https://collector.service.ironbee.us' }),
    'console.ironbee.us',
  );
});

// A collector that is not one of ours says nothing about which console to use,
// and neither does no collector at all.
test('console: an unrecognisable collector falls back to the default host', () => {
  assert.equal(resolveConsoleUrl({ consoleUrl: '', collectorUrl: '' }), 'console.ironbee.ai');
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '', collectorUrl: 'https://collect.example.com' }),
    'console.ironbee.ai',
  );
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '', collectorUrl: 'not a url' }),
    'console.ironbee.ai',
  );
});

test('plan: the derived console host is on the plan', () => {
  const plan = resolvePlan(input({ collectorUrl: 'https://collector.service.ironbee.dev' }));
  assert.equal(plan.consoleUrl, 'console.ironbee.dev');
});

// ─── app_port carries no default ─────────────────────────────────────────────
//
// It used to default to 3000, and the default was indistinguishable from a
// port someone typed — the same defect the unused-input warnings had. Two
// things follow, and both are the point of removing it.

// Before: `app_url: http://localhost:4000` with nobody touching app_port still
// compared 4000 against the default 3000 and warned about a disagreement
// between the user and themselves, on every single run.
test('port: a URL port alone warns about nothing', () => {
  const result = resolveTarget({ appUrl: 'http://localhost:4000', appStartCommand: 'x', appPort: '' });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.target, { kind: 'tunnel', port: 4000 });
});

// Before: this tunnelled to 3000 silently. An application on any other port
// then failed with a connection refused deep inside the run, where nothing
// points back at the port being wrong.
test('port: a start command with no port is refused up front', () => {
  const result = resolveTarget({ appUrl: '', appStartCommand: 'npm start', appPort: '' });
  assert.equal(result.target, null);
  assert.match(result.errors.join(' '), /app_start_command is set but app_port is not/);
});

test('port: a portless localhost URL is refused up front', () => {
  const result = resolveTarget({ appUrl: 'http://localhost', appStartCommand: '', appPort: '' });
  assert.equal(result.target, null);
  assert.match(result.errors.join(' '), /app_url has no port and app_port is not set/);
});

// The warning now means what it says: both were written, and they disagree.
test('port: a real disagreement still warns, and the URL still wins', () => {
  const result = resolveTarget({ appUrl: 'http://localhost:4000', appStartCommand: '', appPort: '3000' });
  assert.deepEqual(result.target, { kind: 'tunnel', port: 4000 });
  assert.match(result.warnings.join(' '), /app_url names port 4000 and app_port is 3000/);
});

// ─── An empty changeset is the base being wrong ──────────────────────────────
//
// The other half of the re-push loop. When some ref still holds the old tip —
// a fix PR branch opened by an earlier failing run does exactly that — the
// event's base resolves fine and measures a rewrite that changed no content, so
// the diff comes back empty and the run has nothing to review. Detectable, so
// no input has to ask which base was meant.

test('binding: a base that resolves to the same content falls back to the parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      baseEmpty: true,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
  );
});

// Nothing is traded away by the fallback: the parent is strictly more to review
// than an empty diff. But a base that does say something must still win, or a
// multi-commit push silently narrows to its tip.
test('binding: a base with real content still outranks the parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      baseEmpty: false,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'b'.repeat(40)],
  );
});

test('binding: an empty base with no parent declares no changeset', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      baseEmpty: true,
      parentSha: '',
    }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

// ─── verification_auto ───────────────────────────────────────────────────────
//
// Off means "verify only when somebody asks". What it cannot mean is "do not
// start": the caller's own steps have run before this action's first one, which
// is why the input is a convenience and the job-level `if:` is the saving.

test('plan: auto off skips a push, with no error and no mode', () => {
  const plan = resolvePlan(input({ eventName: 'push', auto: 'false' }));

  assert.equal(plan.skipped, true);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, null);
  assert.deepEqual(plan.errors, []);
});

test('plan: auto off skips a pull request too', () => {
  assert.equal(resolvePlan(input({ eventName: 'pull_request', auto: 'false' })).skipped, true);
});

// The two a person asked for by name. A comment carries the command itself, and
// a dispatch is somebody pressing a button — neither is "automatic".
test('plan: auto off still runs a comment command and a manual dispatch', () => {
  for (const eventName of ['issue_comment', 'workflow_dispatch']) {
    const plan = resolvePlan(input({ eventName, auto: 'false' }));
    assert.notEqual(plan.skipped, true, eventName);
    assert.equal(plan.mode, 'platform', eventName);
  }
});

test('plan: auto on is the default and changes nothing', () => {
  assert.notEqual(resolvePlan(input({ eventName: 'push' })).skipped, true);
});

// A run that is not going to happen must not also complain about how it was
// configured: the skip is decided before any credential is required, so a
// repository that switched verification off does not get a red run telling it
// the key it deliberately never set is missing.
test('plan: a skipped run reports no configuration errors', () => {
  const plan = resolvePlan(input({ eventName: 'push', auto: 'false', ironbeeApiKey: '', appUrl: '' }));

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.errors, []);
});
