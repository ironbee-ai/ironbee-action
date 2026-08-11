'use strict';

/**
 * The comment command: `/ironbee-verify [--flag ...] [<prompt>]`
 *
 * Parsing lives here rather than in the step's shell for the reason every other
 * script in this directory exists: a comment body is text a stranger wrote, and
 * a `run:` block that interpolates it is arbitrary code execution. It reaches
 * this parser as an environment variable and leaves as a step output.
 *
 * The grammar is the CLI's, minus the ambiguity a bare keyword would introduce.
 * Options are marked with `--`, so scanning stops at the first token that is not
 * one and everything from there is the prompt — no natural sentence begins with
 * `--`, which is what lets `/ironbee-verify --fix check the cart` be read one
 * way only. A bare `fix` could not: it is an ordinary English verb, and reading
 * it as a flag would silently turn "fix the cart total" into a run that commits
 * to the caller's branch.
 */

/** Mirrors the platform's own prompt cap, so an over-long one is refused here rather than at create. */
const PROMPT_MAX_CHARS = 4000;

/** Every option the command understands. Unknown ones are refused, never treated as prose. */
const KNOWN_FLAGS = ['--fix'];

const USAGE = '`/ironbee-verify [--fix] [<what to verify>]`';

/**
 * Whether a line is a quote of an earlier comment.
 *
 * A reply that quotes the message it answers carries the command again, and a
 * quoted command must not re-trigger the run the original already started.
 */
function isQuote(line) {
  return line.trimStart().startsWith('>');
}

/**
 * The line the command has to be on: the first that is neither blank nor a
 * quote.
 *
 * Anchored rather than searched for anywhere in the body, so a comment that
 * merely mentions the command while discussing it — "you can run
 * /ironbee-verify on this" — does not start a run.
 */
function commandLineIndex(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && !isQuote(lines[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * Splits the command line into its options and the offset the prompt starts at.
 *
 * The offset is a position in the ORIGINAL string rather than a re-joined token
 * list: the prompt is the caller's own text and has to survive the round trip
 * with its spacing intact.
 */
function scanFlags(rest) {
  const flags = { fix: false };
  let offset = 0;
  while (offset < rest.length) {
    const remainder = rest.slice(offset);
    const leading = remainder.length - remainder.trimStart().length;
    const start = offset + leading;
    const token = rest.slice(start).split(/\s/, 1)[0];
    if (token === '') {
      return { flags, promptOffset: rest.length };
    }
    if (!token.startsWith('--')) {
      return { flags, promptOffset: start };
    }
    // The end-of-options marker, so a prompt that genuinely begins with a dash
    // can still be written. Everything after it is prose whatever it looks like.
    if (token === '--') {
      return { flags, promptOffset: start + token.length };
    }
    if (!KNOWN_FLAGS.includes(token)) {
      return {
        error: `\`${token}\` is not an option I know. Usage: ${USAGE}`,
      };
    }
    if (token === '--fix') {
      flags.fix = true;
    }
    offset = start + token.length;
  }
  return { flags, promptOffset: rest.length };
}

/**
 * Reads a comment body.
 *
 * Three outcomes, and they are deliberately distinct: a body that is not the
 * command at all (`matched: false` — nothing happens, and nothing is said),
 * a body that is the command but malformed (`ok: false` — the caller replies
 * with the reason, because a typed `--` says the author meant an option and
 * silently reading it as prose would hide the typo), and a parsed command.
 */
function parseCommand({ body, command }) {
  const name = String(command || '').trim();
  if (name === '') {
    throw new Error('parseCommand needs the command name');
  }
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const index = commandLineIndex(lines);
  if (index === -1) {
    return { matched: false };
  }

  const line = lines[index].trim();
  if (line !== name && !line.startsWith(`${name} `)) {
    return { matched: false };
  }

  const rest = line.slice(name.length);
  const scanned = scanFlags(rest);
  if (scanned.error !== undefined) {
    return { matched: true, ok: false, error: scanned.error };
  }

  // The rest of the comment, not just the rest of the line: a paragraph is a
  // natural thing to write under a command, and requiring one line would make
  // the useful case the awkward one.
  const prompt = [rest.slice(scanned.promptOffset), ...lines.slice(index + 1)]
    .join('\n')
    .trim();
  if (prompt.length > PROMPT_MAX_CHARS) {
    return {
      matched: true,
      ok: false,
      error: `the prompt is ${String(prompt.length)} characters; the limit is ${String(PROMPT_MAX_CHARS)}.`,
    };
  }

  return { matched: true, ok: true, fix: scanned.flags.fix, prompt };
}

/** What the acknowledgement says the run understood, so a misread is visible immediately. */
function describeCommand(parsed) {
  const fix = parsed.fix ? 'on' : 'off';
  return parsed.prompt === ''
    ? `fix: ${fix}`
    : `fix: ${fix} · prompt: ${parsed.prompt.replace(/\s+/g, ' ')}`;
}

module.exports = { parseCommand, describeCommand, PROMPT_MAX_CHARS, KNOWN_FLAGS, USAGE };

// ─── The shell entry point ───────────────────────────────────────────────────

/**
 * Writes `matched`, `fix` and `prompt` as step outputs. A malformed command
 * writes its reason to `error` and still exits 0 — the parser's job is to read,
 * not to decide. The step that follows posts the reply and stops the run there,
 * which it does by failing: a composite action cannot skip the steps below it,
 * so the alternative to a red run is a verification that proceeds having
 * discarded what the author asked for.
 */
function main() {
  const fs = require('fs');
  const parsed = parseCommand({
    body: process.env.COMMENT_BODY,
    command: process.env.COMMAND_NAME || '/ironbee-verify',
  });

  const outputs = [
    ['matched', parsed.matched ? 'true' : 'false'],
    ['ok', parsed.matched && parsed.ok ? 'true' : 'false'],
    ['fix', parsed.ok && parsed.fix ? 'true' : 'false'],
    ['error', parsed.matched && !parsed.ok ? parsed.error : ''],
  ];
  let body = outputs.map(([key, value]) => `${key}=${value}\n`).join('');
  // The prompt is caller text and can hold anything, newlines included, so it
  // goes out in the delimiter form with a delimiter it cannot contain.
  const delimiter = `IRONBEE_PROMPT_${Date.now().toString(36)}`;
  body += `prompt<<${delimiter}\n${parsed.ok ? parsed.prompt : ''}\n${delimiter}\n`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, body);

  if (parsed.matched && parsed.ok) {
    console.log(`command: ${describeCommand(parsed)}`);
  }
}

if (require.main === module) {
  main();
}
