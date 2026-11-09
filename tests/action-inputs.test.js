'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The seams between `action.yml` and `scripts/resolve-plan.js`, which no unit
// test can see. Each one has already broken once: a rename left `inputs.model`
// behind in a step that still resolved to an empty string, and a defaulted
// input whose `fallback` did not match its declared default put itself in the
// unused-input warning on every single run.
//
// `action.yml` is read as text rather than parsed. This repository has no
// dependencies and will not grow a YAML parser for four assertions — and the
// shapes below are fixed by the file's own conventions, not guessed.

const ROOT = path.join(__dirname, '..');
const ACTION = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'resolve-plan.js'), 'utf8');

/** `name:` at two-space indent between `inputs:` and `outputs:`, with its default. */
function declaredInputs() {
  const block = ACTION.slice(ACTION.indexOf('\ninputs:'), ACTION.indexOf('\noutputs:'));
  const inputs = new Map();
  let current = null;
  for (const line of block.split('\n')) {
    const declaration = line.match(/^ {2}([a-z0-9_]+):\s*$/);
    if (declaration) {
      current = declaration[1];
      inputs.set(current, null);
      continue;
    }
    const value = line.match(/^ {4}default:\s*(.*)$/);
    if (value && current !== null && inputs.get(current) === null) {
      inputs.set(current, value[1].trim().replace(/^'(.*)'$/, '$1'));
    }
  }
  return inputs;
}

const INPUTS = declaredInputs();

test('action.yml: the inputs block parses into something recognisable', () => {
  assert.ok(INPUTS.size > 30, `only ${String(INPUTS.size)} inputs found — the block shape changed`);
  assert.equal(INPUTS.get('verification_mode'), 'auto');
  assert.equal(INPUTS.get('ironbee_api_key'), null, 'a required input declares no default');
});

// A rename that misses one `${{ inputs.x }}` leaves an expression that resolves
// to the empty string. GitHub does not warn, and the step behaves as if nobody
// set the value.
test('action.yml: every referenced input is declared', () => {
  const referenced = new Set(
    [...ACTION.matchAll(/inputs\.([a-z0-9_]+)/g)].map((match) => match[1]),
  );
  const undeclared = [...referenced].filter((name) => !INPUTS.has(name)).sort();
  assert.deepEqual(undeclared, []);
});

test('action.yml: every declared input is referenced somewhere', () => {
  const referenced = new Set(
    [...ACTION.matchAll(/inputs\.([a-z0-9_]+)/g)].map((match) => match[1]),
  );
  const unused = [...INPUTS.keys()].filter((name) => !referenced.has(name)).sort();
  assert.deepEqual(unused, []);
});

// The plan step is the script's whole world: it reads the environment and
// nothing else. An input the step forgets to export reads as unset, which for
// a boolean means "the default" and for a target field means "not configured".
test('action.yml: the plan step exports every variable the script reads', () => {
  const planStep = ACTION.slice(0, ACTION.indexOf('scripts/resolve-plan.js'));
  // Every variable, not only the INPUT_* ones: the step also computes values
  // git has to answer for (the base's usability, the commit's parent), and a
  // new read of that kind was invisible to an INPUT_-only check.
  const exported = new Set([
    ...[...planStep.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s/gm)].map((m) => m[1]),
    // Assigned and exported in the step's own shell rather than declared in env.
    // One `export` may carry several names.
    ...[...planStep.matchAll(/^\s+export ((?:[A-Z][A-Z0-9_]*\s*)+)$/gm)]
      .flatMap((m) => m[1].trim().split(/\s+/)),
  ]);
  // GITHUB_* comes from the runner, not from this step.
  const read = [...SCRIPT.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith('GITHUB_'));

  const missing = [...new Set(read)].filter((name) => !exported.has(name)).sort();
  assert.deepEqual(missing, [], 'read by resolve-plan.js, never exported to it');

  const readSet = new Set(read);
  const spareInputs = [...exported]
    .filter((name) => name.startsWith('INPUT_') && !readSet.has(name))
    .sort();
  assert.deepEqual(spareInputs, [], 'exported to resolve-plan.js, never read');
});

/** The tables' entries, read off the source so the test cannot hold a stale copy. */
function tableEntries(name) {
  const start = SCRIPT.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found`);
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n];', start));
  return [...body.matchAll(/name: '([a-z0-9_]+)', key: '([A-Za-z0-9]+)', fallback: '([^']*)'/g)]
    .map((match) => ({ name: match[1], key: match[2], fallback: match[3] }));
}

// The whole point of `fallback` is that it equals the declared default, so
// "the author chose this" can be told from "the default arrived". A drifted
// pair names the input in a warning on every run, and a reader who sees the
// line every time stops reading it.
for (const table of ['LOCAL_ONLY_INPUTS', 'PLATFORM_ONLY_INPUTS']) {
  test(`${table}: every entry names a real input, with its declared default`, () => {
    const entries = tableEntries(table);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.ok(INPUTS.has(entry.name), `${entry.name} is not a declared input`);
      assert.equal(
        entry.fallback,
        INPUTS.get(entry.name) ?? '',
        `${entry.name}: fallback disagrees with the default in action.yml`,
      );
    }
  });
}

// An input this file forgets is one GitHub validates not at all: any string
// reaches the step, and the narrower comparison downstream reads it as false.
test('BOOLEAN_INPUTS: covers exactly the inputs whose default is a boolean', () => {
  const start = SCRIPT.indexOf('const BOOLEAN_INPUTS = [');
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n];', start));
  const declared = new Set([...body.matchAll(/\['([a-z0-9_]+)',/g)].map((match) => match[1]));

  const booleanByDefault = [...INPUTS.entries()]
    .filter(([, value]) => value === 'true' || value === 'false')
    .map(([name]) => name);

  for (const name of booleanByDefault) {
    assert.ok(declared.has(name), `${name} defaults to a boolean but is never parsed as one`);
  }
  for (const name of declared) {
    assert.ok(INPUTS.has(name), `${name} is parsed as a boolean but is not a declared input`);
  }
});

// The fallback is what an omitted or empty value resolves to, so a drift from
// the declared default means the action does one thing and documents another.
test('BOOLEAN_INPUTS: every fallback equals the declared default', () => {
  const start = SCRIPT.indexOf('const BOOLEAN_INPUTS = [');
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n];', start));
  const entries = [...body.matchAll(/\['([a-z0-9_]+)', '[A-Za-z0-9]+', (true|false)\]/g)];
  assert.ok(entries.length > 0);
  for (const [, name, fallback] of entries) {
    assert.equal(fallback, INPUTS.get(name), `${name}: fallback disagrees with action.yml`);
  }
});

// Pinned because it is the kind of thing that gets helpfully restored. A port
// default is indistinguishable from a port someone typed, which cost this
// action a spurious "app_url and app_port disagree" warning on every run of a
// workflow that named only its URL — and, worse, silently tunnelled to the
// guess when nobody named a port at all.
test('action.yml: app_port declares no default', () => {
  assert.ok(INPUTS.has('app_port'));
  assert.equal(INPUTS.get('app_port'), '');
});

// Both outcome paths carry the same refusal, and they must keep carrying it.
// The gate was added to the fix PR alone at first, which left a failing
// re-verification pushing its fix onto someone else's branch — the more
// intrusive of the two, guarded by the weaker rule.
test('action.yml: neither outcome path ships a fix the re-verification rejected', () => {
  for (const step of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    const start = ACTION.indexOf(`- name: ${step}`);
    assert.notEqual(start, -1, `${step} not found`);
    const condition = ACTION.slice(start, ACTION.indexOf('shell:', start));

    assert.match(condition, /job-reverified\.outputs\.verdict != 'fail'/, step);
    assert.match(condition, /verdict\.outputs\.status != 'fail'/, step);
  }
});

// The comment is left out when the platform publishes the run itself, judged
// on the job the report was built from: the re-verified one when it ran. Read
// from the first job alone, a re-verification would be judged by a stale answer.
test('action.yml: the report comment reads the publication of the job the report shows', () => {
  const start = ACTION.indexOf('- name: Post the report on the pull request');
  assert.notEqual(start, -1);
  const step = ACTION.slice(start, ACTION.indexOf('\n    - name:', start + 1));

  assert.match(
    step,
    /PLATFORM_PUBLISHES: \$\{\{ steps\.job-reverified\.outputs\.platform_publishes \|\| steps\.job\.outputs\.platform_publishes \}\}/,
  );
  // Before the first `gh` call, so an older report comment is not updated either.
  const guard = step.indexOf('"$PLATFORM_PUBLISHES" = "true"');
  assert.notEqual(guard, -1);
  assert.ok(guard < step.indexOf('gh api'));
});

// ─── The comment command ─────────────────────────────────────────────────────

// The one line in this file that would be a remote code execution. A comment
// body is text a stranger wrote, and `${{ github.event.comment.body }}` inside
// a `run:` is that text pasted into a shell holding this job's credentials —
// so it may appear as an `env:` value and nowhere else.
test('action.yml: the comment body reaches the parser as an environment value only', () => {
  // Comment lines excluded: this rule is stated in one of them, right above
  // the step it governs.
  const uses = ACTION.split('\n')
    .filter((line) => line.includes('github.event.comment.body') && !line.trim().startsWith('#'));

  assert.equal(uses.length, 1);
  assert.match(uses[0], /^\s*COMMENT_BODY:\s/);
});

// The routing rule for a comment run: it IS a pull request run. Its fixes
// belong on the branch under review, and a second pull request against that
// branch is noise nobody asked for.
test('action.yml: a comment run lands its fixes on the branch, never in a new pull request', () => {
  const commit = ACTION.slice(ACTION.indexOf('- name: Commit the fixes to the pull request branch'));
  assert.match(commit.slice(0, commit.indexOf('shell:')), /github\.event_name == 'issue_comment'/);

  const create = ACTION.slice(ACTION.indexOf('- name: Create fix PR'));
  assert.match(create.slice(0, create.indexOf('shell:')), /github\.event_name != 'issue_comment'/);
});

// A comment event carries an issue, not a pull request, so every place that
// reads the number needs both — and a half-converted one binds the run to
// nothing while looking configured.
test('action.yml: every PR_NUMBER falls back to the comment\'s issue', () => {
  // `PR_NUMBER:` only. The local-mode prompt names the number too, but inside
  // an `if` branch that a comment run never reaches — it has its own.
  const uses = ACTION.split('\n').filter((line) => line.trim().startsWith('PR_NUMBER:'));

  assert.ok(uses.length > 0);
  for (const line of uses) {
    assert.match(line, /github\.event\.issue\.number/, line.trim());
  }
});

// The command's own prompt has to win: a repository that configures a standing
// `verification_prompt` would otherwise silently verify that instead of what
// the comment asked for.
test('action.yml: the command\'s prompt takes precedence over the configured one', () => {
  const uses = ACTION.split('\n').filter((line) => line.includes('USER_PROMPT:'));

  assert.ok(uses.length >= 3);
  for (const line of uses) {
    assert.match(line, /steps\.command\.outputs\.prompt \|\| inputs\.verification_prompt/, line.trim());
  }
});

// ─── Step bodies ─────────────────────────────────────────────────────────────

/** One step, from its `- name:` to the next step's. */
function step(name) {
  const start = ACTION.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = ACTION.indexOf('\n    - name:', start + 1);
  return ACTION.slice(start, end === -1 ? ACTION.length : end);
}

/** The step's `if:` and `env:`, everything above its script. */
function header(name) {
  const body = step(name);
  return body.slice(0, body.indexOf('run: |'));
}

// The fork answer is what keeps a fork's code off a run holding the secrets, so
// it may not hinge on how the parser read the comment: `/ironbee-verify.`
// passes a prefix filter, parses as no command, and used to skip the lookup.
test('action.yml: the fork lookup runs on every pull request comment, whatever the parser said', () => {
  const condition = header('Resolve the pull request behind the comment');

  assert.match(condition, /if: github\.event_name == 'issue_comment' && github\.event\.issue\.pull_request\n/);
  assert.doesNotMatch(condition, /steps\.command\.outputs/);
  assert.match(header('Resolve the verification plan'), /COMMAND_MATCHED: \$\{\{ steps\.command\.outputs\.matched \}\}/);
});

// A plain issue has no pull request: the comment is neither read nor looked up,
// and the plan is told so, which skips the run.
test('action.yml: a comment on a plain issue is not read and not looked up', () => {
  for (const name of ['Read the comment command', 'Resolve the pull request behind the comment']) {
    assert.match(header(name), /&& github\.event\.issue\.pull_request\n/, name);
  }
  assert.match(
    header('Resolve the verification plan'),
    /COMMENT_ON_PULL_REQUEST: \$\{\{ github\.event\.issue\.pull_request && 'true' \|\| 'false' \}\}/,
  );
});

// A comment's --fix the workflow does not apply is said in the report, in both
// shapes, from the plan's own answer.
test('action.yml: the report says when a comment\'s fix is not applied', () => {
  const body = step('Build the verification report');
  const flags = body.match(/\$\{\{ steps\.plan\.outputs\.fix_refused == 'true' && '--fix-off' \|\| '' \}\}/g) || [];
  assert.equal(flags.length, 2);
});

// Fixing off — the setting, or a comment without --fix — has to hold in local
// mode too, where the agent edits the tree itself: neither path may land a fix.
test('action.yml: neither outcome path lands a fix when fixing is off', () => {
  for (const name of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    assert.match(header(name), /steps\.plan\.outputs\.can_fix == 'true'/, name);
  }
});

test('action.yml: the local prompt asks for fixes only when fixing is on', () => {
  const body = step('Build verification prompt');

  assert.match(body, /CAN_FIX: \$\{\{ steps\.plan\.outputs\.can_fix \}\}/);
  assert.match(body, /do not edit any files/);
  // Every "fix the issues" instruction sits behind the flag.
  assert.doesNotMatch(body, /If verification fails, fix the issues/);
});

// A push can carry several commits; the parent alone reviews only the last.
test('action.yml: a local push run diffs from the plan\'s base, not HEAD~1', () => {
  const body = step('Build verification prompt');

  assert.match(body, /DIFF_BASE: \$\{\{ steps\.plan\.outputs\.diff_base \}\}/);
  assert.doesNotMatch(body, /DIFF_TARGET="HEAD~1"/);
});

// A start command with no URL leaves the agent nothing to open but the port.
test('action.yml: the local prompt names the application\'s port', () => {
  const body = step('Build verification prompt');

  assert.match(body, /APP_PORT: \$\{\{ steps\.plan\.outputs\.target_port \}\}/);
  assert.match(body, /Port the application listens on: \$\{APP_PORT\}/);
});

// In a subdirectory `.git` is not where the step runs.
test('action.yml: the exclude file is located by git, not by a relative path', () => {
  const body = step('Setup IronBee for Claude');

  assert.match(body, /git rev-parse --git-path info\/exclude/);
  assert.doesNotMatch(body, />> \.git\/info\/exclude/);
});

// A start command that serves built output would serve the pre-fix build.
test('action.yml: the default restart rebuilds before it starts', () => {
  const body = step('Re-verify after the fix');
  const restart = body.slice(body.indexOf('kill "$(cat .ironbee/app.pid)"'));

  assert.match(header('Re-verify after the fix'), /APP_BUILD_COMMAND: \$\{\{ inputs\.app_build_command \}\}/);
  const build = restart.indexOf('bash -c "$APP_BUILD_COMMAND"');
  assert.notEqual(build, -1);
  assert.ok(build < restart.indexOf('bash -c "$APP_START_COMMAND"'));
});

// The run sends its headers, so the check has to: otherwise a protection bypass
// configured for the run is refused here as deployment protection.
test('action.yml: the reachability check sends the run\'s headers, never as arguments', () => {
  const body = step('Check the deployment is reachable');

  assert.match(body, /resolve-plan\.js" --header-lines/);
  assert.match(body, /CURL_ARGS\+=\(-H @-\)/);
  // A redirect would carry the headers to another host, so none is followed.
  assert.doesNotMatch(body, /-L\b|--location/);
});

// The start command's children would otherwise outlive the restart, keep the
// port, and serve the pre-fix code to the re-verification.
test('action.yml: the application started by command leads its own process group, stopped whole', () => {
  const start = step('Start the application');
  assert.match(start, /set -m\n\s+nohup bash -c "\$APP_START_COMMAND" < \/dev\/null > \.ironbee\/artifacts\/app\.log 2>&1 &\n\s+echo \$! > \.ironbee\/app\.pid\n\s+set \+m/);

  const restart = step('Re-verify after the fix');
  assert.match(restart, /set -m\n\s+nohup bash -c "\$APP_START_COMMAND" < \/dev\/null >> \.ironbee\/artifacts\/app\.log 2>&1 &/);

  const groupKill = 'kill -- "-$(cat .ironbee/app.pid)" 2>/dev/null || kill "$(cat .ironbee/app.pid)" 2>/dev/null || true';
  for (const name of ['Re-verify after the fix', 'Stop the application']) {
    assert.ok(step(name).includes(groupKill), name);
    // No kill of the process alone, other than as the fallback above.
    assert.doesNotMatch(step(name), /^\s+kill "\$\(cat \.ironbee\/app\.pid\)"/m, name);
  }
});

// What an install or a build left in the tree is not a fix: neither path stages
// anything unless a fix step changed files, and then only the paths it touched.
test('action.yml: neither outcome path stages anything but what the fix touched', () => {
  for (const name of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    assert.match(
      header(name),
      /\(steps\.platform-fix\.outputs\.fixed == 'true' \|\| steps\.claude-verify\.outputs\.fixed == 'true'\)/,
      name,
    );
    const body = step(name);
    // `git add` only ever names a path: the IronBee setup's, when it is kept.
    assert.doesNotMatch(body, /git add(?! -A -- "\$SETUP_PATH")/, name);
    assert.match(body, /git reset -q \|\| true\n\s+node "\$\{\{ github\.action_path \}\}\/scripts\/fix-paths\.js" stage \.ironbee\/fix-paths/, name);
    // The exclusions still apply on top.
    assert.match(body, /git reset HEAD -- \.ironbee\//, name);
    assert.match(body, /git reset HEAD -- \.mcp\.json \.gitignore \.claude\//, name);
  }
});

// ─── Step scripts, run ───────────────────────────────────────────────────────

/**
 * A piece of a step's script, from `from` up to `to` (or the end), with its
 * expressions replaced by `values`, run by bash as GitHub runs it.
 */
function runPiece(name, from, to, values, cwd, env) {
  const body = step(name);
  const script = body.slice(body.indexOf('run: |'));
  const start = script.indexOf(from);
  assert.notEqual(start, -1, `${from} not in ${name}`);
  const end = to ? script.indexOf(to, start) : script.length;
  assert.notEqual(end, -1, `${to} not in ${name}`);
  const text = script.slice(start, end).replace(/\$\{\{ ([^}]+?) \}\}/g, (match, expression) => {
    assert.ok(expression in values, `no value for ${expression}`);
    return values[expression];
  });
  return execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', text], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/**
 * A checkout as the local agent leaves it: a stray `stray.log` and the IronBee
 * setup written before the snapshot, then the agent's own install rewriting the
 * lockfile and its build writing an unignored file, and the session's verdicts
 * as `statuses` in the main agent's file, as the CLI writes them. With `edit`,
 * the agent also fixed `app.js`; with `ignoreSetup`, the repository ignores
 * `.mcp.json`.
 */
function localRun(statuses, edit, ignoreSetup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-step-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), ignoreSetup ? 'node_modules/\n.mcp.json\n' : 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'broken\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  fs.mkdirSync(path.join(dir, '.ironbee', 'sessions', 's1', 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stray.log'), 'left by something before the run\n');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{}\n');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}\n');
  fs.appendFileSync(path.join(dir, '.gitignore'), '.ironbee/\n');
  execFileSync('node', [path.join(ROOT, 'scripts', 'fix-paths.js'), 'snapshot', '.ironbee/pre-fix-tree'], { cwd: dir });

  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(dir, 'next-env.d.ts'), '// generated\n');
  if (edit) {
    fs.writeFileSync(path.join(dir, 'app.js'), 'fixed\n');
  }
  fs.writeFileSync(
    path.join(dir, '.ironbee', 'sessions', 's1', 'agents', 'main', 'actions.jsonl'),
    statuses.map((status, index) => JSON.stringify({ type: 'verdict_write', timestamp: 1000 + index, verdict: { status } })).join('\n'),
  );

  const output = path.join(dir, '.ironbee', 'github-output');
  fs.writeFileSync(output, '');
  runPiece(
    'Run Claude Code verification',
    'node "${{ github.action_path }}/scripts/fix-paths.js" changed',
    null,
    { 'github.action_path': ROOT },
    dir,
    { GITHUB_OUTPUT: output },
  );
  return { dir, outputs: fs.readFileSync(output, 'utf8') };
}

/** Where each outcome step stops staging and starts committing. */
const COMMIT_CHECK = {
  'Commit the fixes to the pull request branch': 'if [ -z "$(git diff --cached --name-only)" ]',
  'Create fix PR': 'if [ -n "$(git diff --cached --name-only)" ]',
};

function stagedAfterCommitStep(name, dir, excludeFiles) {
  runPiece(
    name,
    'git reset -q || true',
    COMMIT_CHECK[name],
    { 'github.action_path': ROOT, 'steps.plan.outputs.exclude_files': excludeFiles },
    dir,
    {},
  );
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
}

// The agent's own install and build wrote into the tree, and its first cycle
// passed: nothing was fixed, so nothing is staged.
test('local run: a first cycle that passes over a dirty tree is no fix', () => {
  const { outputs } = localRun(['pass'], false);
  assert.match(outputs, /^fixed=false$/m);
});

// Even an edit is no fix without a failing cycle before it.
test('local run: changed files without a failing cycle are no fix', () => {
  assert.match(localRun(['pass'], true).outputs, /^fixed=false$/m);
});

// A fix that also carries what the agent's install and build wrote is accepted.
test('local run: a fail then a pass with changed files is a fix, carrying the install\'s output', () => {
  const { dir, outputs } = localRun(['fail', 'pass'], true);
  assert.match(outputs, /^fixed=true$/m);
  for (const name of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    // Lying there before the run and staged by the agent itself: the step's
    // own reset drops it.
    execFileSync('git', ['add', 'stray.log'], { cwd: dir });
    assert.deepEqual(stagedAfterCommitStep(name, dir, 'true'), ['app.js', 'next-env.d.ts', 'package-lock.json'], name);
  }
});

// A setup path the repository ignores is skipped, as a whole-tree add skipped
// it, and the fix is still committed.
test('local run: with exclude_files off an ignored setup path does not cost the fix', () => {
  const { dir } = localRun(['fail', 'pass'], true, true);
  for (const name of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    assert.deepEqual(
      stagedAfterCommitStep(name, dir, 'false'),
      ['.claude/settings.json', '.gitignore', 'app.js', 'next-env.d.ts', 'package-lock.json'],
      name,
    );
  }
});

// ironbee_exclude_files off commits the IronBee setup with the fix, though it
// was written before the snapshot.
test('local run: with exclude_files off the IronBee setup is staged with the fix', () => {
  const { dir } = localRun(['fail', 'pass'], true);
  for (const name of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    assert.deepEqual(
      stagedAfterCommitStep(name, dir, 'false'),
      ['.claude/settings.json', '.gitignore', '.mcp.json', 'app.js', 'next-env.d.ts', 'package-lock.json'],
      name,
    );
  }
});

test('action.yml: the setup paths are staged only when exclude_files is off, after the fix\'s', () => {
  for (const name of ['Commit the fixes to the pull request branch', 'Create fix PR']) {
    const body = step(name);
    const stage = body.indexOf('fix-paths.js" stage .ironbee/fix-paths');
    const setup = body.indexOf('if [ "${{ steps.plan.outputs.exclude_files }}" != "true" ]; then\n');
    assert.ok(stage !== -1 && setup > stage, name);
    assert.match(body.slice(setup), /for SETUP_PATH in \.mcp\.json \.gitignore \.claude; do/, name);
  }
});

// The platform's own publication says nothing of fixing: the refusal is posted
// on its own, with the token and the mechanism the malformed-command reply uses.
test('action.yml: a refused --fix is answered on the pull request when the platform publishes', () => {
  const body = step('Post the report on the pull request');
  assert.match(header('Post the report on the pull request'), /FIX_REFUSED: \$\{\{ steps\.plan\.outputs\.fix_refused \}\}/);
  const publishes = body.indexOf('if [ "$PLATFORM_PUBLISHES" = "true" ]; then');
  const refused = body.indexOf('if [ "$FIX_REFUSED" = "true" ]; then', publishes);
  const exit = body.indexOf('exit 0', publishes);
  assert.ok(publishes !== -1 && refused > publishes && refused < exit);
  const answer = body.slice(refused, exit);
  assert.match(answer, /build-report\.js" --fix-off-note > \.ironbee-fix-off\.txt/);
  assert.match(answer, /gh api "repos\/\$\{\{ github\.repository \}\}\/issues\/\$\{PR_NUMBER\}\/comments" \\\n\s+-F "body=@\.ironbee-fix-off\.txt"/);
  assert.match(header('Answer a malformed command'), /GH_TOKEN: \$\{\{ inputs\.github_token \}\}/);
  assert.match(header('Post the report on the pull request'), /GH_TOKEN: \$\{\{ inputs\.github_token \}\}/);
});

// Each fix step measures its own changes from a snapshot taken before it.
test('action.yml: both fix steps snapshot the tree before the fix and list what changed after it', () => {
  for (const name of ['Run Claude Code verification', 'Fix the reported issues']) {
    const body = step(name);
    const snapshot = body.indexOf('fix-paths.js" snapshot .ironbee/pre-fix-tree');
    const agent = body.indexOf('| claude --output-format');
    const changed = body.indexOf('fix-paths.js" changed .ironbee/pre-fix-tree .ironbee/fix-paths');
    assert.ok(snapshot !== -1 && agent !== -1 && changed !== -1, name);
    assert.ok(snapshot < agent && agent < changed, name);
    assert.match(body, /if \[ -s \.ironbee\/fix-paths \](?: && \[ "\$FIX_CYCLE" = "true" \])?; then\n/, name);
    assert.match(body, /echo "fixed=true" >> "\$GITHUB_OUTPUT"/, name);
    // Neither call may fail the step; a broken one leaves a list of nothing.
    assert.match(body, /fix-paths\.js" snapshot \.ironbee\/pre-fix-tree \|\| \{\n\s+echo "::warning::[^\n]+"\n\s+: > \.ironbee\/pre-fix-tree\n\s+\}/, name);
    assert.match(body, /fix-paths\.js" changed \.ironbee\/pre-fix-tree \.ironbee\/fix-paths \|\| \{\n\s+echo "::warning::[^\n]+"\n\s+: > \.ironbee\/fix-paths\n\s+\}/, name);
  }
  assert.doesNotMatch(step('Fix the reported issues'), /git status --porcelain/);
  // In local mode the changed list alone is not a fix: a fix cycle is too, and
  // reading it cannot fail the step.
  assert.match(step('Run Claude Code verification'), /FIX_CYCLE="\$\(node "\$\{\{ github\.action_path \}\}\/scripts\/build-report\.js" --fix-cycle \.ironbee \|\| echo false\)"/);
});

// The CLI keeps sessions outside the project by default, where nothing here
// reads them: every local step that runs it keeps them in .ironbee/.
test('action.yml: the local steps that run the CLI keep its sessions in the working directory', () => {
  for (const name of ['Setup IronBee for Claude', 'Run Claude Code verification']) {
    assert.match(header(name), /\n\s+IRONBEE_RUNTIME_LOCATION: in-project\n/, name);
  }
});

/** A `.ironbee/sessions/s1` as the CLI leaves it: the verdict and the actions in the main agent's directory. */
function sessionTree(status) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
  const agent = path.join(dir, '.ironbee', 'sessions', 's1', 'agents', 'main');
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(dir, '.ironbee', 'artifacts'));
  if (status) {
    fs.writeFileSync(path.join(agent, 'verdict.json'), JSON.stringify({ status }));
  }
  fs.writeFileSync(path.join(agent, 'actions.jsonl'), [
    JSON.stringify({ type: 'verdict_write', timestamp: 1, session_id: 's1', verdict: { status: 'fail' } }),
    JSON.stringify({ type: 'verdict_write', timestamp: 2, session_id: 's1', verdict: { status: 'pass' } }),
    JSON.stringify({ type: 'verdict_write', timestamp: 3, session_id: 's1', kind: 'scenario', verdict: { status: 'fail' } }),
  ].join('\n'));
  return dir;
}

function extractVerdict(dir) {
  const output = path.join(dir, 'github-output');
  fs.writeFileSync(output, '');
  runPiece('Extract verdict', 'STATUS="unknown"', null,
    { 'steps.plan.outputs.verbose': 'false', 'github.action_path': ROOT }, dir, { GITHUB_OUTPUT: output });
  return fs.readFileSync(output, 'utf8');
}

// The session is the directory under sessions/, not the agent's below it.
test('local run: the verdict is read from the agent\'s directory, the session from the one above it', () => {
  assert.match(extractVerdict(sessionTree('pass')), /^status=pass\nsession_id=s1\n$/);
});

// Without a verdict file, the last gated verdict in the agents' actions counts;
// a scenario run's does not.
test('local run: without a verdict file the agents\' actions give the verdict', () => {
  assert.match(extractVerdict(sessionTree(null)), /^status=pass\nsession_id=s1\n$/);
});

test('local run: the evidence carries the whole session, its agents included', () => {
  const dir = sessionTree('pass');
  runPiece('Collect session artifacts', 'ARTIFACTS_DIR=".ironbee/artifacts"', null,
    { 'steps.plan.outputs.verbose': 'false' }, dir, { GITHUB_OUTPUT: path.join(dir, 'github-output') });
  for (const file of ['verdict.json', 'actions.jsonl']) {
    assert.ok(fs.existsSync(path.join(dir, '.ironbee', 'artifacts', 'sessions', 's1', 'agents', 'main', file)), file);
  }
});

// The note is a courtesy: a refused post warns, and leaves no note file behind
// for a re-run to find.
test('action.yml: a refused --fix note that cannot be posted warns and leaves nothing behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const printed = runPiece('Post the report on the pull request', 'if [ "$PLATFORM_PUBLISHES" = "true" ]; then', '# Updated in place',
    { 'github.action_path': ROOT, 'github.repository': 'ironbee-ai/shop' }, dir,
    { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PLATFORM_PUBLISHES: 'true', FIX_REFUSED: 'true', PR_NUMBER: '7' });
  assert.match(printed, /^::warning::could not post on the pull request that fixing is off in this workflow/m);
  assert.equal(fs.existsSync(path.join(dir, '.ironbee-fix-off.txt')), false);
});

// A redirect is not followed, so its target is named: a sign-in redirect to an
// identity provider, or http to https, is then visible in the log.
test('reachability: a redirect is named, not followed', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-stub-'));
  const args = path.join(bin, 'args');
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" > "${args}"`,
    'cat >/dev/null',
    'printf "%s %s" "$STUB_STATUS" "$STUB_REDIRECT"',
  ].join('\n'), { mode: 0o755 });
  const check = (status, redirect) => runPiece(
    'Check the deployment is reachable',
    'HEADER_LINES=""',
    null,
    { 'steps.plan.outputs.mode': 'local', 'github.action_path': ROOT },
    bin,
    { PATH: `${bin}${path.delimiter}${process.env.PATH}`, APP_URL: 'https://preview.example.com', STUB_STATUS: status, STUB_REDIRECT: redirect },
  );

  const redirected = check('302', 'https://idp.example.com/login');
  assert.match(redirected, /^::warning::https:\/\/preview\.example\.com answers 302, redirecting to https:\/\/idp\.example\.com\/login\./m);
  assert.doesNotMatch(fs.readFileSync(args, 'utf8'), /(^| )(-L|--location)( |$)/);
  assert.match(fs.readFileSync(args, 'utf8'), /%\{http_code\} %\{redirect_url\}/);

  const plain = check('200', '');
  assert.match(plain, /^https:\/\/preview\.example\.com answers 200$/m);
  assert.doesNotMatch(plain, /::warning::/);
});

// The service's text reaches the shell as a value, never as script.
test('action.yml: the report carries the failure message through the environment', () => {
  const body = step('Build the verification report');

  assert.match(body, /FAILURE_MESSAGE: \$\{\{ steps\.job\.outputs\.failure_message \}\}/);
  assert.match(body, /--failure-message "\$FAILURE_MESSAGE"/);
  assert.doesNotMatch(body, /run: \|[\s\S]*outputs\.failure_message/);
});

// A scheduled run's event has no repository object, and an empty visibility
// reads as public in `auto` mode.
test('action.yml: the plan asks the API for the visibility the event left out', () => {
  const body = step('Resolve the verification plan');

  assert.match(body, /GH_TOKEN: \$\{\{ inputs\.github_token \}\}/);
  assert.match(body, /if \[ -z "\$REPOSITORY_PRIVATE" \]; then/);
  assert.match(body, /gh api "repos\/\$\{\{ github\.repository \}\}" --jq '\.private'/);
  // Before the script reads it.
  assert.ok(body.indexOf('export REPOSITORY_PRIVATE') < body.indexOf('scripts/resolve-plan.js'));
});

// ─── Event text never becomes script ─────────────────────────────────────────

/** Every step's `run:` script, block or single-line, with its starting line. */
function runScripts() {
  const lines = ACTION.split('\n');
  const scripts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s+)run:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    if (match[2] !== '|' && match[2] !== '|-' && match[2] !== '>-') {
      scripts.push({ line: index + 1, text: match[2] });
      continue;
    }
    const body = [];
    let next = index + 1;
    while (next < lines.length
        && (lines[next].trim() === '' || lines[next].match(/^\s*/)[0].length > indent)) {
      body.push(lines[next]);
      next += 1;
    }
    scripts.push({ line: index + 1, text: body.join('\n') });
    index = next - 1;
  }
  return scripts;
}

// A title, a branch name, a comment, a login: text someone outside the
// workflow chose. Pasted into a script by `${{ }}` it is code run with this
// job's secrets, so it reaches a script through `env:` and nowhere else.
const EVENT_TEXT = /github\.event\.|github\.(ref_name|head_ref|base_ref|actor|triggering_actor)\b|steps\.(comment-pr|command)\.outputs\./;

test('action.yml: the scripts were found', () => {
  assert.ok(runScripts().length > 30, `only ${String(runScripts().length)} run scripts found — the shape changed`);
});

test('action.yml: no run script interpolates event-controlled text', () => {
  const offending = [];
  for (const script of runScripts()) {
    for (const expression of script.text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      if (EVENT_TEXT.test(expression[1])) {
        offending.push(`run: at line ${String(script.line)}: \${{${expression[1]}}}`);
      }
    }
  }
  assert.deepEqual(offending, []);
});

// ─── The history fetch ───────────────────────────────────────────────────────

/**
 * A pull request's checkout, one commit deep as `actions/checkout` leaves it:
 * `feature` left `main` two commits ago, and `main` has since moved 60 on.
 */
function checkoutFarBehindMain(cloneArgs = ['--no-single-branch']) {
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(upstream, 'init', '-q', '-b', 'main');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'fork point');
  const forkPoint = git(upstream, 'rev-parse', 'HEAD');
  git(upstream, 'checkout', '-q', '-b', 'feature');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'feature 1');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'feature 2');
  git(upstream, 'checkout', '-q', 'main');
  execFileSync('bash', ['-c', 'for i in $(seq 60); do git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "main $i"; done'], { cwd: upstream });
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-')), 'repo');
  execFileSync('git', ['clone', '-q', '--depth', '1', ...cloneArgs, '--branch', 'feature', `file://${upstream}`, dir]);
  return { dir, forkPoint };
}

// A depth of 50 after the unshallow made the checkout shallow again, and a main
// that moved further than that hid the merge base the diff is measured from.
test('fetch: a base branch far ahead of the fork still has its merge base', () => {
  const { dir, forkPoint } = checkoutFarBehindMain();
  runPiece('Fetch git history for diff', 'git fetch --unshallow origin', null, {}, dir, { BASE_REF: 'main' });

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(git('merge-base', 'HEAD', 'origin/main'), forkPoint);
});

// A single-branch checkout's refspec covers its own branch alone, so a fetch
// that named no destination left origin/<base> missing.
test('fetch: a single-branch checkout ends with origin/<base>', () => {
  const { dir, forkPoint } = checkoutFarBehindMain(['--single-branch']);
  runPiece('Fetch git history for diff', 'git fetch --unshallow origin', null, {}, dir, { BASE_REF: 'main' });

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  assert.match(git('rev-parse', '--verify', 'refs/remotes/origin/main'), /^[0-9a-f]{40,64}$/);
  assert.equal(git('merge-base', 'HEAD', 'origin/main'), forkPoint);
});
