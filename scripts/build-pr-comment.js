#!/usr/bin/env node

// Builds a markdown PR comment from IronBee verification artifacts.
//
// Usage: node build-pr-comment.js <artifacts-dir> <ironbee-version> [artifact-url]
//
// Reads:
//   - <artifacts-dir>/cycle-*/ directories for evidence files
//   - <artifacts-dir>/sessions/<id>/actions.jsonl for verdict details
//
// Outputs markdown to stdout.

const fs = require('fs');
const path = require('path');

function main() {
  const [artifactsDir, ironbeeVersion, artifactUrl] = process.argv.slice(2);

  if (!artifactsDir || !ironbeeVersion) {
    console.error('Usage: node build-pr-comment.js <artifacts-dir> <ironbee-version> [artifact-url]');
    process.exit(1);
  }

  const verdicts = parseVerdicts(artifactsDir);
  const cycles = parseCycles(artifactsDir);
  const matched = matchVerdictsWithCycles(verdicts, cycles);
  const finalVerdict = getFinalVerdict(matched);

  const lines = [];

  // Header
  lines.push('## \uD83D\uDC1D IronBee Verification Report');
  lines.push('');
  lines.push(formatBadge(finalVerdict, matched.length));
  lines.push('');

  // Each cycle
  for (const cycle of matched) {
    lines.push('---');
    lines.push('');
    lines.push(formatCycle(cycle));
    lines.push('');
  }

  // Artifact link
  if (artifactUrl) {
    lines.push('---');
    lines.push('');
    lines.push(`### \uD83D\uDCE6 [Download Verification Artifacts](${artifactUrl})`);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push(`*Verified by [IronBee](https://github.com/ironbee-ai/ironbee-action) v${ironbeeVersion}*`);

  console.log(lines.join('\n'));
}

// Parse all verdicts from actions.jsonl files in session directories.
function parseVerdicts(artifactsDir) {
  const sessionsDir = path.join(artifactsDir, 'sessions');
  const verdicts = [];

  if (!fs.existsSync(sessionsDir)) return verdicts;

  for (const sessionId of fs.readdirSync(sessionsDir)) {
    const actionsFile = path.join(sessionsDir, sessionId, 'actions.jsonl');
    if (!fs.existsSync(actionsFile)) continue;

    const lines = fs.readFileSync(actionsFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        // IronBee uses "verdict_write" as the event type
        if (event.type === 'verdict_write' && event.verdict) {
          verdicts.push(event.verdict);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return verdicts;
}

// Parse cycle directories for evidence files.
// Directories with the same cycle number (e.g. cycle-1-fail, cycle-1-pass) are
// merged — their screenshots and recordings are combined into one cycle.
function parseCycles(artifactsDir) {
  if (!fs.existsSync(artifactsDir)) return [];

  const dirs = fs.readdirSync(artifactsDir)
    .filter(d => d.startsWith('cycle-') && fs.statSync(path.join(artifactsDir, d)).isDirectory())
    .sort();

  const byNum = new Map();
  for (const dir of dirs) {
    const match = dir.match(/^cycle-(\d+)/);
    if (!match) continue;

    const num = parseInt(match[1], 10);
    const cycleDir = path.join(artifactsDir, dir);
    const screenshots = listFiles(path.join(cycleDir, 'screenshots'));
    const recordings = listFiles(path.join(cycleDir, 'recordings'));

    if (byNum.has(num)) {
      const existing = byNum.get(num);
      existing.screenshots.push(...screenshots);
      existing.recordings.push(...recordings);
    } else {
      byNum.set(num, { num, screenshots, recordings });
    }
  }

  return Array.from(byNum.values()).sort((a, b) => a.num - b.num);
}

// List file names in a directory.
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => {
    const full = path.join(dir, f);
    return fs.statSync(full).isFile();
  });
}

// Match verdicts (from actions.jsonl) with cycle directories.
// Verdicts are in order — cycle 1 gets verdict 1, etc.
function matchVerdictsWithCycles(verdicts, cycles) {
  return cycles.map((cycle, i) => ({
    ...cycle,
    verdict: verdicts[i]?.status || 'unknown',
    details: verdicts[i] || null,
  }));
}

// Determine the final verdict status.
function getFinalVerdict(matched) {
  if (matched.length === 0) return 'unknown';
  const last = matched[matched.length - 1];
  return last.verdict;
}

// Format the top-level badge line.
function formatBadge(verdict, cycleCount) {
  const icon = verdict === 'pass' ? '\u2705' : verdict === 'fail' ? '\u274C' : '\u26A0\uFE0F';
  const label = verdict.toUpperCase();
  const suffix = cycleCount > 1 ? ` (${cycleCount} cycles)` : '';
  return `${icon} **${label}**${suffix}`;
}

// Format a single verification cycle as markdown.
function formatCycle(cycle) {
  const lines = [];
  const icon = cycle.verdict === 'pass' ? '\u2705' : cycle.verdict === 'fail' ? '\u274C' : '\u26A0\uFE0F';

  lines.push(`### Cycle ${cycle.num} \u2014 ${icon} ${cycle.verdict}`);
  lines.push('');

  const d = cycle.details;

  if (d) {
    if (d.pages_tested && d.pages_tested.length > 0) {
      lines.push('**Pages Tested:**');
      for (const p of d.pages_tested) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }

    if (d.checks && d.checks.length > 0) {
      lines.push('**Checks:**');
      for (const c of d.checks) {
        lines.push(`- ${c}`);
      }
      lines.push('');
    }

    if (d.issues && d.issues.length > 0) {
      lines.push('**Issues:**');
      for (const issue of d.issues) {
        lines.push(`- ${issue}`);
      }
      lines.push('');
    }

    if (d.fixes && d.fixes.length > 0) {
      lines.push('**Fixes Applied:**');
      for (const fix of d.fixes) {
        lines.push(`- ${fix}`);
      }
      lines.push('');
    }
  }

  if (cycle.screenshots.length > 0) {
    lines.push(`**Screenshots:** ${cycle.screenshots.join(', ')}`);
  }
  if (cycle.recordings.length > 0) {
    lines.push(`**Recordings:** ${cycle.recordings.join(', ')}`);
  }
  if (cycle.screenshots.length > 0 || cycle.recordings.length > 0) {
    lines.push('');
  }

  return lines.join('\n');
}

main();
