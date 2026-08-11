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
test('binding: a push with an unusable base declares no changeset', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push', sha: 'a'.repeat(40), beforeSha: '0'.repeat(40), baseUsable: false,
    }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

test('binding: a manual or scheduled run binds the commit with no changeset', () => {
  for (const eventName of ['workflow_dispatch', 'schedule']) {
    assert.deepEqual(
      resolveRepoBinding({ eventName, sha: 'a'.repeat(40) }),
      ['--commit', 'a'.repeat(40), '--no-diff'],
    );
  }
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
  assert.match(plan.warnings.join(' '), /model/);
  assert.match(plan.warnings.join(' '), /max_turns/);
});

test('plan: local-only inputs are silent in local mode', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local', anthropicApiKey: 'sk-ant', model: 'claude-sonnet-5',
  }));
  assert.deepEqual(plan.warnings, []);
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

// ─── The budget floor ────────────────────────────────────────────────────────

test('floor: the default job timeout produces a floor above the queue wait', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '' }), 15 + 60 + 10);
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
