'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { githubHost } = require('../scripts/github-host.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'github-host.js');

// github.com is the host every `gh` call assumed before any was named, so the
// answer there has to be exactly that.
test('host: github.com is github.com', () => {
  for (const url of ['https://github.com', 'https://github.com/', 'https://GitHub.com']) {
    assert.deepEqual(githubHost(url), { host: 'github.com', flavor: 'github_com' }, url);
  }
});

test('host: an empty or unreadable server URL is github.com', () => {
  for (const url of ['', '   ', undefined, null, 'github.com', 'not a url']) {
    assert.deepEqual(githubHost(url), { host: 'github.com', flavor: 'github_com' }, String(url));
  }
});

// A tenant is GitHub's own cloud: `gh` reads GH_TOKEN there and v4 artifacts work.
test('host: a GHE.com tenant is ghe_com', () => {
  assert.deepEqual(githubHost('https://acme.ghe.com'), { host: 'acme.ghe.com', flavor: 'ghe_com' });
  assert.deepEqual(githubHost('https://Acme.GHE.com/'), { host: 'acme.ghe.com', flavor: 'ghe_com' });
});

test('host: any other host is a GitHub Enterprise Server', () => {
  for (const [url, host] of [
    ['https://github.acme.com', 'github.acme.com'],
    ['https://code.example.org/', 'code.example.org'],
    // Neither is github.com or a tenant, whatever the name holds.
    ['https://github.com.acme.net', 'github.com.acme.net'],
    ['https://ghe.com.acme.net', 'ghe.com.acme.net'],
  ]) {
    assert.deepEqual(githubHost(url), { host, flavor: 'ghes' }, url);
  }
});

function run(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-host-'));
  const output = path.join(dir, 'github-output');
  fs.writeFileSync(output, '');
  execFileSync('node', [SCRIPT], { env: { ...process.env, SERVER_URL: serverUrl, GITHUB_OUTPUT: output } });
  return fs.readFileSync(output, 'utf8');
}

test('host: the command line writes the host and the flavor as step outputs', () => {
  assert.equal(run('https://github.com'), 'host=github.com\nflavor=github_com\n');
  assert.equal(run('https://acme.ghe.com'), 'host=acme.ghe.com\nflavor=ghe_com\n');
  assert.equal(run('https://github.acme.com'), 'host=github.acme.com\nflavor=ghes\n');
});
