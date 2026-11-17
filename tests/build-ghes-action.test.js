'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ghesAction } = require('../scripts/build-ghes-action');

// ghes/action.yml is the entry point a GitHub Enterprise Server names. It is
// generated from action.yml and never edited, so what these pin is that the
// committed copy is the generated one, and that the generated one is the same
// action with the server's upload version and its scripts one level up.

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-ghes-action.js');
const ACTION = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
const GHES_PATH = path.join(ROOT, 'ghes', 'action.yml');
const GHES = fs.existsSync(GHES_PATH) ? fs.readFileSync(GHES_PATH, 'utf8') : '';

const OFF_SERVER = " && steps.github-host.outputs.flavor != 'ghes'";
const ON_SERVER = " && steps.github-host.outputs.flavor == 'ghes'";

function run(...args) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

/** The steps of an action file: name and the text above its script. */
function steps(text) {
  return text.slice(text.indexOf('\n  steps:\n')).split('\n    - name: ').slice(1).map((chunk) => {
    const script = chunk.search(/\n\s+run:/);
    return { name: chunk.split('\n')[0], header: script === -1 ? chunk : chunk.slice(0, script) };
  });
}

/** The lines below the generated header. */
function body(text) {
  const lines = text.split('\n');
  return lines.slice(lines.findIndex((line) => line.startsWith('name: ')));
}

// ─── The committed copy is the generated one ─────────────────────────────────

test('ghes/action.yml: is exactly what the script makes from action.yml', () => {
  assert.ok(GHES !== '', 'ghes/action.yml is missing: run `node scripts/build-ghes-action.js`');
  assert.equal(GHES, ghesAction(ACTION), 'ghes/action.yml drifted: run `node scripts/build-ghes-action.js`');
});

test('check: passes on the committed copy', () => {
  const result = run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to date/);
});

test('check: fails on a drifted copy and on a missing one, and the build writes the generated one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghes-action-'));
  const source = path.join(dir, 'action.yml');
  const target = path.join(dir, 'ghes', 'action.yml');
  fs.writeFileSync(source, ACTION);

  const missing = run('--check', source, target);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not what scripts\/build-ghes-action\.js makes from action\.yml/);

  const built = run(source, target);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), ghesAction(ACTION));
  assert.equal(run('--check', source, target).status, 0);

  // A hand edit of the copy.
  fs.appendFileSync(target, '# edited\n');
  assert.equal(run('--check', source, target).status, 1);

  // A change to action.yml not carried over.
  run(source, target);
  fs.writeFileSync(source, ACTION.replace("default: 'auto'", "default: 'local'"));
  assert.equal(run('--check', source, target).status, 1);
});

// ─── What the copy holds ─────────────────────────────────────────────────────

test('ghes/action.yml: both uploads on v3.2.2, on the server alone, and no v4 upload', () => {
  const uploads = steps(GHES).filter((s) => /\n\s+uses: actions\/upload-artifact@/.test(s.header));
  assert.deepEqual(uploads.map((s) => s.name), ['Upload verification evidence', 'Upload the application log']);
  for (const s of uploads) {
    assert.match(s.header, /\n\s+uses: actions\/upload-artifact@v3\.2\.2\n/, s.name);
    assert.ok(s.header.match(/\n\s+if: (.*)\n/)[1].endsWith(ON_SERVER), s.name);
  }
  assert.doesNotMatch(GHES, /upload-artifact@v4/);
  assert.doesNotMatch(GHES, /flavor != 'ghes'/);
});

test('ghes/action.yml: its name and description say it is the GitHub Enterprise Server variant', () => {
  assert.match(GHES, /^name: 'IronBee Action for GitHub Enterprise Server'$/m);
  assert.match(GHES, /^description: '.*\(the GitHub Enterprise Server variant\)'$/m);
  // Everything above `name:` is the generated notice.
  const header = GHES.split('\n').slice(0, GHES.split('\n').findIndex((line) => line.startsWith('name: ')));
  assert.ok(header.length > 0 && header.every((line) => line.startsWith('# ')));
  assert.match(header.join('\n'), /Generated from action\.yml by scripts\/build-ghes-action\.js: do not edit/);
});

// The runner sets github.action_path to ghes/, and the scripts sit in the root.
test('ghes/action.yml: every script it names resolves from ghes/', () => {
  const named = [...GHES.matchAll(/\$\{\{ github\.action_path \}\}\/([^"\s]+)/g)].map((match) => match[1]);
  assert.ok(named.length > 20, `only ${String(named.length)} script paths found`);
  for (const relative of new Set(named)) {
    assert.match(relative, /^\.\.\/scripts\/[a-z-]+\.js$/, relative);
    assert.ok(fs.existsSync(path.join(ROOT, 'ghes', relative)), relative);
  }
  assert.equal(GHES.split('github.action_path').length - 1, named.length);
});

test('action.yml: every script it names resolves from the root', () => {
  const named = [...ACTION.matchAll(/\$\{\{ github\.action_path \}\}\/([^"\s]+)/g)].map((match) => match[1]);
  assert.ok(named.length > 20);
  for (const relative of new Set(named)) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), relative);
  }
});

// Line for line against action.yml: the name, the description, the two uploads'
// `uses:` and `if:`, and the script paths. Nothing else.
test('ghes/action.yml: differs from action.yml in nothing else', () => {
  const main = ACTION.split('\n');
  const ghes = body(GHES);
  assert.equal(ghes.length, main.length);

  const kinds = { name: 0, description: 0, uses: 0, if: 0, path: 0 };
  const other = [];
  main.forEach((line, index) => {
    const theirs = ghes[index];
    if (theirs === line) {
      return;
    }
    if (line.startsWith('name: ') && theirs.startsWith('name: ')) {
      kinds.name += 1;
    } else if (line.startsWith('description: ') && theirs.startsWith('description: ')) {
      kinds.description += 1;
    } else if (/^\s+uses: actions\/upload-artifact@v4$/.test(line)
        && theirs === line.replace('@v4', '@v3.2.2')) {
      kinds.uses += 1;
    } else if (/^\s+if: /.test(line) && line.endsWith(OFF_SERVER)
        && theirs === `${line.slice(0, -OFF_SERVER.length)}${ON_SERVER}`) {
      kinds.if += 1;
    } else if (theirs === line.split('${{ github.action_path }}/scripts/').join('${{ github.action_path }}/../scripts/')) {
      kinds.path += 1;
    } else {
      other.push(`line ${String(index + 1)}: ${line.trim()} -> ${theirs.trim()}`);
    }
  });
  assert.deepEqual(other, []);
  assert.deepEqual({ ...kinds, path: kinds.path > 20 }, { name: 1, description: 1, uses: 2, if: 2, path: true });
});

// ─── The generator, on a small action ────────────────────────────────────────

const SMALL = [
  "name: 'Small'",
  "description: 'A small action'",
  'runs:',
  "  using: 'composite'",
  '  steps:',
  '    - name: Upload',
  "      if: always() && steps.github-host.outputs.flavor != 'ghes'",
  '      uses: actions/upload-artifact@v4',
  '      with:',
  '        name: evidence',
  '    - name: Gate',
  '      shell: bash',
  '      run: node "${{ github.action_path }}/scripts/gate.js"',
  '',
].join('\n');

test('generator: the exact transformation of a small action', () => {
  assert.equal(ghesAction(SMALL), [
    '# Generated from action.yml by scripts/build-ghes-action.js: do not edit.',
    '# Run `node scripts/build-ghes-action.js` after changing action.yml.',
    "name: 'Small for GitHub Enterprise Server'",
    "description: 'A small action (the GitHub Enterprise Server variant)'",
    'runs:',
    "  using: 'composite'",
    '  steps:',
    '    - name: Upload',
    "      if: always() && steps.github-host.outputs.flavor == 'ghes'",
    '      uses: actions/upload-artifact@v3.2.2',
    '      with:',
    '        name: evidence',
    '    - name: Gate',
    '      shell: bash',
    '      run: node "${{ github.action_path }}/../scripts/gate.js"',
    '',
  ].join('\n'));
});

// An `||` inside parentheses or a string leaves the trailing flavor test
// guarding the whole condition, so the swap keeps the meaning.
test('generator: swaps an upload if: whose || sits inside parentheses or a string', () => {
  const conditions = [
    '(failure() || always())',
    "always() && inputs.mode != 'x || y'",
    "always() && inputs.mode != 'it''s || y'",
    "always() && inputs.mode != \"x || y\"",
  ];
  for (const condition of conditions) {
    const built = ghesAction(SMALL.replace("if: always() && steps.github-host.outputs.flavor != 'ghes'",
      `if: ${condition}${OFF_SERVER}`));
    assert.ok(built.includes(`\n      if: ${condition}${ON_SERVER}\n      uses: actions/upload-artifact@v3.2.2\n`), condition);
  }
});

// A source it cannot turn into the server's entry point exactly is refused,
// never guessed at.
test('generator: refuses what it cannot carry over exactly', () => {
  const refusals = [
    [SMALL.replace('upload-artifact@v4', 'upload-artifact@v3.2.2'), /names a v3 action/],
    [SMALL.replace("\n      if: always() && steps.github-host.outputs.flavor != 'ghes'", ''), /an upload whose if: does not end with/],
    [SMALL.replace("flavor != 'ghes'", "flavor == 'github_com'"), /an upload whose if: does not end with/],
    [SMALL.replace('if: always() && ', 'if: failure() || always() && '), /action\.yml line 7: an upload whose if: has an \|\| outside parentheses/],
    [SMALL.replace('if: always() && ', 'if: (failure()) || always() && '), /an upload whose if: has an \|\| outside parentheses/],
    [SMALL.replace('if: always() && ', "if: inputs.mode == 'it''s' || always() && "), /an upload whose if: has an \|\| outside parentheses/],
    [SMALL.replace('/scripts/gate.js', '/gate.js'), /a path from github\.action_path other than/],
    [SMALL.replace('"${{ github.action_path }}/scripts/gate.js"', '"$GITHUB_ACTION_PATH/scripts/gate.js"'), /GITHUB_ACTION_PATH/],
    [SMALL.replace('      uses: actions/upload-artifact@v4\n', '      uses: actions/cache@v4\n'), /no actions\/upload-artifact step found/],
    [SMALL.replace('      uses: actions/upload-artifact@v4', "      uses: 'actions/upload-artifact@v4'"), /no actions\/upload-artifact step found/],
    [SMALL.replace("name: 'Small'", 'name: Small'), /one single-quoted top-level name/],
  ];
  for (const [source, error] of refusals) {
    assert.throws(() => ghesAction(source), error);
  }
});
