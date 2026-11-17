#!/usr/bin/env node

// Builds ghes/action.yml, the entry point a GitHub Enterprise Server names
// (`ironbee-ai/ironbee-action/ghes@v1`), from action.yml.
//
// A `uses:` is resolved when the job is set up, skipped steps included, and no
// expression can choose it. github.com refuses v3 of upload-artifact and the
// server serves no v4, so no one file names a version both take. The server's
// copy differs in its name and description, its uploads and its script paths,
// and nothing else. `--check` fails when the committed copy is not what this
// makes, so the two cannot drift.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'action.yml');
const TARGET = path.join(ROOT, 'ghes', 'action.yml');

const UPLOAD = 'actions/upload-artifact';
// The version the server serves, pinned as this repository pins its actions.
const UPLOAD_ON_SERVER = 'v3.2.2';
const OFF_SERVER = " && steps.github-host.outputs.flavor != 'ghes'";
const ON_SERVER = " && steps.github-host.outputs.flavor == 'ghes'";
// The scripts sit in the repository root, one level above ghes/.
const SCRIPTS = '${{ github.action_path }}/scripts/';
const SCRIPTS_FROM_SUBFOLDER = '${{ github.action_path }}/../scripts/';

const HEADER = [
  '# Generated from action.yml by scripts/build-ghes-action.js: do not edit.',
  '# Run `node scripts/build-ghes-action.js` after changing action.yml.',
];

/** The step around line `at`: from its `- ` line to the next step's, or the end. */
function stepAround(lines, at) {
  const item = /^ {4}- /;
  let start = at;
  while (start >= 0 && !item.test(lines[start])) {
    start -= 1;
  }
  let end = at + 1;
  while (end < lines.length && !item.test(lines[end])) {
    end += 1;
  }
  if (start < 0) {
    throw new Error(`line ${String(at + 1)}: an upload outside any step`);
  }
  return { start, end };
}

/** Whether an expression has an `||` outside parentheses and string literals. */
function hasTopLevelOr(expression) {
  let depth = 0;
  let quote = null;
  for (let at = 0; at < expression.length; at += 1) {
    const char = expression[at];
    if (quote !== null) {
      if (char === quote) {
        // A doubled single quote is an escaped one, inside the string.
        if (quote === "'" && expression[at + 1] === "'") {
          at += 1;
        } else {
          quote = null;
        }
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === '|' && expression[at + 1] === '|' && depth <= 0) {
      return true;
    }
  }
  return false;
}

/** A top-level `key: '<value>'` line, rewritten by `change`. Exactly one is required. */
function rewriteTopLevel(lines, key, change) {
  const pattern = new RegExp(`^${key}: '(.*)'$`);
  const found = lines.map((line, index) => ({ line, index })).filter(({ line }) => pattern.test(line));
  if (found.length !== 1) {
    throw new Error(`action.yml: expected one single-quoted top-level ${key}, found ${String(found.length)}`);
  }
  const { line, index } = found[0];
  lines[index] = `${key}: '${change(line.match(pattern)[1])}'`;
}

/**
 * ghes/action.yml's text, from action.yml's. Throws on a source this cannot
 * turn into the server's entry point exactly, rather than guessing.
 */
function ghesAction(source) {
  const text = String(source);
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    if (/@v3\b/.test(line)) {
      throw new Error(`action.yml line ${String(index + 1)}: names a v3 action, which github.com refuses`);
    }
    if (line.includes('GITHUB_ACTION_PATH')) {
      throw new Error(`action.yml line ${String(index + 1)}: GITHUB_ACTION_PATH, a path this cannot adjust`);
    }
  });

  rewriteTopLevel(lines, 'name', (name) => `${name} for GitHub Enterprise Server`);
  rewriteTopLevel(lines, 'description', (description) => `${description} (the GitHub Enterprise Server variant)`);

  let uploads = 0;
  const usesUpload = new RegExp(`^(\\s+)uses: ${UPLOAD.replace('/', '\\/')}@\\S+$`);
  lines.forEach((line, index) => {
    const match = line.match(usesUpload);
    if (!match) {
      return;
    }
    const indent = match[1];
    const { start, end } = stepAround(lines, index);
    const conditions = [];
    for (let at = start; at < end; at += 1) {
      if (lines[at].startsWith(`${indent}if: `)) {
        conditions.push(at);
      }
    }
    if (conditions.length !== 1 || !lines[conditions[0]].endsWith(OFF_SERVER)) {
      throw new Error(`action.yml line ${String(index + 1)}: an upload whose if: does not end with${OFF_SERVER}`);
    }
    const at = conditions[0];
    // `&&` binds tighter than `||`, so the trailing flavor test would guard
    // only the last operand of a top-level `||` and the swap would change the
    // meaning. One inside parentheses or a string leaves it guarding the whole.
    if (hasTopLevelOr(lines[at].slice(`${indent}if: `.length))) {
      throw new Error(`action.yml line ${String(at + 1)}: an upload whose if: has an || outside parentheses, which the trailing flavor test does not guard whole`);
    }
    lines[at] =`${lines[at].slice(0, -OFF_SERVER.length)}${ON_SERVER}`;
    lines[index] = `${indent}uses: ${UPLOAD}@${UPLOAD_ON_SERVER}`;
    uploads += 1;
  });
  if (uploads === 0) {
    throw new Error(`action.yml: no ${UPLOAD} step found`);
  }
  lines.forEach((line, index) => {
    if (line.includes(`${UPLOAD}@`) && !line.endsWith(`uses: ${UPLOAD}@${UPLOAD_ON_SERVER}`)) {
      throw new Error(`action.yml line ${String(index + 1)}: a ${UPLOAD} reference not in the form this rewrites`);
    }
  });

  lines.forEach((line, index) => {
    const named = line.split('github.action_path').length - 1;
    const known = line.split(SCRIPTS).length - 1;
    if (named !== known) {
      throw new Error(`action.yml line ${String(index + 1)}: a path from github.action_path other than ${SCRIPTS}`);
    }
    lines[index] = line.split(SCRIPTS).join(SCRIPTS_FROM_SUBFOLDER);
  });

  return `${HEADER.join('\n')}\n${lines.join('\n')}`;
}

function main(argv) {
  const check = argv.includes('--check');
  const paths = argv.filter((arg) => arg !== '--check');
  const source = paths[0] || SOURCE;
  const target = paths[1] || TARGET;
  const shown = path.relative(process.cwd(), target) || target;

  let built;
  try {
    built = ghesAction(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current !== built) {
      process.stderr.write(`${shown} is not what scripts/build-ghes-action.js makes from action.yml: run \`node scripts/build-ghes-action.js\` and commit the result\n`);
      return 1;
    }
    process.stdout.write(`${shown} is up to date\n`);
    return 0;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, built);
  process.stdout.write(`wrote ${shown}\n`);
  return 0;
}

module.exports = { ghesAction, UPLOAD_ON_SERVER, SCRIPTS_FROM_SUBFOLDER };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
