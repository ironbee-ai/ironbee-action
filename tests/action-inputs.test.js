'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
