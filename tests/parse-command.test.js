'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand, describeCommand, PROMPT_MAX_CHARS } = require('../scripts/parse-command.js');

const COMMAND = '/ironbee-verify';

function parse(body) {
  return parseCommand({ body, command: COMMAND });
}

// ─── What is and is not the command ──────────────────────────────────────────

test('the bare command runs with no options and no prompt', () => {
  assert.deepEqual(parse('/ironbee-verify'), { matched: true, ok: true, fix: false, prompt: '' });
});

test('a body that is not the command matches nothing', () => {
  assert.deepEqual(parse('looks good to me'), { matched: false });
});

// Anchored to the first real line: a comment discussing the command is the
// normal way a team explains it to a new member, and it must not start a run.
test('a command mentioned mid-sentence is not a command', () => {
  assert.deepEqual(parse('you can run /ironbee-verify on this once CI is green'), { matched: false });
});

test('a command further down the body is not a command either', () => {
  assert.deepEqual(parse('some context first\n\n/ironbee-verify'), { matched: false });
});

// A reply that quotes the message it answers carries the command again. The
// original already ran; the quote must not run it a second time.
test('a quoted command is skipped, and the real first line decides', () => {
  assert.deepEqual(parse('> /ironbee-verify --fix\n\nthanks!'), { matched: false });
});

test('leading blank lines and a quote block do not hide the command', () => {
  assert.deepEqual(parse('\n> earlier discussion\n/ironbee-verify'),
    { matched: true, ok: true, fix: false, prompt: '' });
});

// The command name has to be the whole first token — a longer command that
// merely starts with it is a different command.
test('a longer word starting with the command is not the command', () => {
  assert.deepEqual(parse('/ironbee-verify-all'), { matched: false });
});

// ─── Options ─────────────────────────────────────────────────────────────────

test('--fix turns the fix round on', () => {
  assert.deepEqual(parse('/ironbee-verify --fix'), { matched: true, ok: true, fix: true, prompt: '' });
});

// The whole reason options are marked. A bare `fix` here would make this run
// commit to the caller's branch when all they asked for was a check.
test('a prompt beginning with the word fix is a prompt, not the option', () => {
  assert.deepEqual(parse('/ironbee-verify fix the cart total'),
    { matched: true, ok: true, fix: false, prompt: 'fix the cart total' });
});

test('an option and a prompt fit on one line', () => {
  assert.deepEqual(parse('/ironbee-verify --fix check the coupon flow'),
    { matched: true, ok: true, fix: true, prompt: 'check the coupon flow' });
});

// A typed `--` says the author meant an option. Reading it as prose would hide
// the typo and verify something they did not ask for.
test('an unknown option is refused rather than read as prose', () => {
  const parsed = parse('/ironbee-verify --fx check the cart');

  assert.equal(parsed.matched, true);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /`--fx` is not an option/);
  assert.match(parsed.error, /\/ironbee-verify \[--fix\]/);
});

test('the end-of-options marker lets a prompt start with a dash', () => {
  assert.deepEqual(parse('/ironbee-verify --fix -- --50% coupon shows wrong'),
    { matched: true, ok: true, fix: true, prompt: '--50% coupon shows wrong' });
});

test('repeating an option is not an error', () => {
  assert.deepEqual(parse('/ironbee-verify --fix --fix'),
    { matched: true, ok: true, fix: true, prompt: '' });
});

// ─── The prompt ──────────────────────────────────────────────────────────────

test('the prompt is the rest of the comment, not just the rest of the line', () => {
  const parsed = parse('/ironbee-verify --fix\ncheck the coupon flow\nand the totals');

  assert.equal(parsed.fix, true);
  assert.equal(parsed.prompt, 'check the coupon flow\nand the totals');
});

test('a first-line prompt continues onto the lines below it', () => {
  assert.equal(parse('/ironbee-verify check the cart\nand the totals').prompt,
    'check the cart\nand the totals');
});

// It is prose, and its own shape is part of what it says.
test('the prompt keeps its inner spacing and markdown', () => {
  assert.equal(parse('/ironbee-verify\n- cart\n- checkout\n\n`POST /orders` too').prompt,
    '- cart\n- checkout\n\n`POST /orders` too');
});

test('carriage returns from the web editor are normalised away', () => {
  assert.equal(parse('/ironbee-verify --fix\r\ncheck the cart\r\n').prompt, 'check the cart');
});

// Refused here rather than at create: the platform's own cap would reject the
// job after it had been assembled, which reads as a broken action.
test('an over-long prompt is refused with its own size', () => {
  const parsed = parse(`/ironbee-verify ${'a'.repeat(PROMPT_MAX_CHARS + 1)}`);

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, new RegExp(String(PROMPT_MAX_CHARS)));
});

test('a prompt exactly at the cap is accepted', () => {
  assert.equal(parse(`/ironbee-verify ${'a'.repeat(PROMPT_MAX_CHARS)}`).ok, true);
});

// ─── The acknowledgement ─────────────────────────────────────────────────────

test('the acknowledgement states what was understood', () => {
  assert.equal(describeCommand(parse('/ironbee-verify --fix check the cart')),
    'fix: on · prompt: check the cart');
  assert.equal(describeCommand(parse('/ironbee-verify')), 'fix: off');
});

// One line, because it goes into a comment beside the run link.
test('the acknowledgement flattens a multi-line prompt', () => {
  assert.equal(describeCommand(parse('/ironbee-verify\ncheck the cart\nand totals')),
    'fix: off · prompt: check the cart and totals');
});
