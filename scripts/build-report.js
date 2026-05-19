#!/usr/bin/env node

// Builds a markdown verification report from IronBee artifacts.
//
// Usage: node build-report.js <artifacts-dir> <ironbee-version> [artifact-url] [console-url] [session-id]
//
// Reads:
//   - <artifacts-dir>/sessions/<id>/actions.jsonl for verdict details
//
// When console-url and session-id are provided, a link to the IronBee Console
// is rendered under the report header.
//
// Outputs markdown to stdout.

const fs = require('fs');
const path = require('path');

function main() {
  const [artifactsDir, ironbeeVersion, artifactUrl, consoleUrl, sessionIdArg] = process.argv.slice(2);

  if (!artifactsDir || !ironbeeVersion) {
    console.error('Usage: node build-report.js <artifacts-dir> <ironbee-version> [artifact-url] [console-url] [session-id]');
    process.exit(1);
  }

  const cycles = parseVerdicts(artifactsDir);
  const endReason = parseEndReason(artifactsDir);
  const sessionId = sessionIdArg || endReason?.session_id || findAnySessionId(artifactsDir);
  const finalStatus = cycles.length > 0 ? (cycles[cycles.length - 1].verdict.status || 'unknown') : 'unknown';
  const host = consoleHost(consoleUrl);

  const lines = [];

  // Header
  lines.push('## <img src="https://ironbee.ai/favicon.png" width="24" height="24"> IronBee Verification Report');
  lines.push('');

  // Session-level console link (above the verdict badge)
  if (host && sessionId) {
    lines.push(`🔗 **[View session in IronBee Console](https://${host}/sessions/${sessionId})**`);
    lines.push('');
  }

  // Verdict badge
  lines.push(formatBadge(finalStatus, cycles.length));
  lines.push('');

  // Banner when the session ended abnormally (e.g., max_turns)
  if (endReason && isAbnormalEnd(endReason)) {
    lines.push(formatEndBanner(endReason));
    lines.push('');
  }

  // Each cycle
  cycles.forEach((cycle, i) => {
    lines.push('---');
    lines.push('');
    lines.push(formatCycle(i + 1, cycle, host));
    lines.push('');
  });

  // Collapsible session-end details — only when the session ended abnormally
  if (endReason && isAbnormalEnd(endReason)) {
    lines.push('---');
    lines.push('');
    lines.push(formatEndDetails(endReason));
    lines.push('');
  }

  // Artifact link
  if (artifactUrl) {
    lines.push('---');
    lines.push('');
    lines.push(`### 📦 [Download Verification Artifacts](${artifactUrl})`);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push(`*Verified by [IronBee](https://github.com/ironbee-ai/ironbee-action) v${ironbeeVersion}*`);

  console.log(lines.join('\n'));
}

// Parse all verdicts from actions.jsonl files in session directories.
// Each entry keeps its session/activity/verification IDs so per-cycle links
// can be rendered.
function parseVerdicts(artifactsDir) {
  const sessionsDir = path.join(artifactsDir, 'sessions');
  const cycles = [];

  if (!fs.existsSync(sessionsDir)) return cycles;

  for (const sessionId of fs.readdirSync(sessionsDir)) {
    const actionsFile = path.join(sessionsDir, sessionId, 'actions.jsonl');
    if (!fs.existsSync(actionsFile)) continue;

    const lines = fs.readFileSync(actionsFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'verdict_write' && event.verdict) {
          cycles.push({
            sessionId,
            activityId: event.activity_id,
            verificationId: event.verification_id,
            verdict: event.verdict,
          });
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return cycles;
}

// Normalize console URL into a bare hostname (strips scheme + trailing slashes).
function consoleHost(consoleUrl) {
  if (!consoleUrl) return '';
  return consoleUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// Parse the final type:"result" event from claude-output.log.raw.
// Returns the parsed event (with subtype, num_turns, errors, etc.) or null.
function parseEndReason(artifactsDir) {
  const logFile = path.join(artifactsDir, 'claude-output.log.raw');
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') return event;
    } catch {}
  }
  return null;
}

// Last-resort session_id lookup: name of any subdirectory under sessions/.
function findAnySessionId(artifactsDir) {
  const sessionsDir = path.join(artifactsDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return '';
  const entries = fs.readdirSync(sessionsDir).filter((name) => {
    try { return fs.statSync(path.join(sessionsDir, name)).isDirectory(); } catch { return false; }
  });
  return entries[0] || '';
}

function isAbnormalEnd(end) {
  return end.subtype && end.subtype !== 'success';
}

// Human-readable label for the result.subtype field.
function endReasonLabel(end) {
  const subtype = end.subtype || 'unknown';
  switch (subtype) {
    case 'success': return 'Completed successfully';
    case 'error_max_turns': return 'Reached max turns limit';
    case 'error_during_execution': return 'Error during execution';
    default: return subtype;
  }
}

// One-line banner shown under the verdict badge when the session ended abnormally.
function formatEndBanner(end) {
  const label = endReasonLabel(end);
  const turns = end.num_turns != null ? ` after ${end.num_turns} turn${end.num_turns === 1 ? '' : 's'}` : '';
  return `> ⚠️ **Session ended early:** ${label}${turns}. Verification may be incomplete.`;
}

// Collapsible <details> block with full end-of-session diagnostics.
function formatEndDetails(end) {
  const lines = [];
  lines.push('<details><summary>Session end details</summary>');
  lines.push('');
  lines.push(`- **Reason:** ${endReasonLabel(end)} (\`${end.subtype || 'unknown'}\`)`);
  if (end.terminal_reason && end.terminal_reason !== end.subtype) {
    lines.push(`- **Terminal reason:** \`${end.terminal_reason}\``);
  }
  if (end.num_turns != null) lines.push(`- **Turns:** ${end.num_turns}`);
  if (typeof end.total_cost_usd === 'number') {
    lines.push(`- **Cost:** $${end.total_cost_usd.toFixed(4)}`);
  }
  if (typeof end.duration_ms === 'number') {
    lines.push(`- **Duration:** ${(end.duration_ms / 1000).toFixed(1)}s`);
  }
  if (Array.isArray(end.errors) && end.errors.length > 0) {
    lines.push(`- **Errors:**`);
    for (const e of end.errors) lines.push(`  - ${e}`);
  }
  if (Array.isArray(end.permission_denials) && end.permission_denials.length > 0) {
    lines.push(`- **Blocked tool calls:** ${end.permission_denials.length}`);
    for (const d of end.permission_denials.slice(0, 10)) {
      const target = d.tool_input?.file_path
        || (typeof d.tool_input?.command === 'string' ? d.tool_input.command.slice(0, 80) : '')
        || d.tool_input?.url
        || '';
      lines.push(`  - \`${d.tool_name}\`${target ? ` — ${target}` : ''}`);
    }
  }
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

// Format the top-level badge line.
function formatBadge(status, cycleCount) {
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️';
  const label = status.toUpperCase();
  const suffix = cycleCount > 1 ? ` (${cycleCount} cycles)` : '';
  return `${icon} **${label}**${suffix}`;
}

// Format a single verification cycle as markdown.
function formatCycle(num, cycle, host) {
  const lines = [];
  const verdict = cycle.verdict;
  const status = verdict.status || 'unknown';
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️';

  lines.push(`### Cycle ${num} — ${icon} ${status}`);
  lines.push('');

  // Per-verification console link
  if (host && cycle.sessionId && cycle.verificationId) {
    const params = new URLSearchParams();
    if (cycle.activityId) params.set('activityId', cycle.activityId);
    params.set('verificationId', cycle.verificationId);
    const url = `https://${host}/sessions/${cycle.sessionId}?${params.toString()}`;
    lines.push(`🔗 [View this verification in IronBee Console](${url})`);
    lines.push('');
  }

  if (verdict.checks && verdict.checks.length > 0) {
    lines.push('**Checks:**');
    for (const c of verdict.checks) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  if (verdict.issues && verdict.issues.length > 0) {
    lines.push('**Issues:**');
    for (const issue of verdict.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (verdict.fixes && verdict.fixes.length > 0) {
    lines.push('**Fixes:**');
    for (const fix of verdict.fixes) {
      lines.push(`- ${fix}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

main();
