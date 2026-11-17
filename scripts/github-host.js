#!/usr/bin/env node

// The GitHub host this run is on, read from the server URL, and its flavor.
//
// A composite action shares no environment between its steps, so the host is
// read once and every step that calls `gh` names it from this step's output.
// `gh` reads GH_TOKEN on github.com and on a *.ghe.com tenant, and
// GH_ENTERPRISE_TOKEN on any other host, which is a GitHub Enterprise Server.

'use strict';

const fs = require('fs');

const GITHUB_COM = 'github.com';

/**
 * `{ host, flavor }`, the flavor one of `github_com`, `ghe_com` and `ghes`.
 *
 * Every name under ghe.com is GitHub's own cloud, never a customer's server.
 * An empty or unreadable URL is github.com, the host `gh` assumes when it is
 * given none, so a run that names no server behaves as it always did.
 */
function githubHost(serverUrl) {
  let host = '';
  try {
    host = new URL(String(serverUrl == null ? '' : serverUrl).trim()).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === '' || host === GITHUB_COM) {
    return { host: GITHUB_COM, flavor: 'github_com' };
  }
  if (host.endsWith('.ghe.com')) {
    return { host, flavor: 'ghe_com' };
  }
  return { host, flavor: 'ghes' };
}

function main() {
  const { host, flavor } = githubHost(process.env.SERVER_URL);
  const body = `host=${host}\nflavor=${flavor}\n`;
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    fs.appendFileSync(file, body);
  } else {
    process.stdout.write(body);
  }
}

module.exports = { githubHost, GITHUB_COM };

if (require.main === module) {
  main();
}
