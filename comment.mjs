#!/usr/bin/env node
/**
 * Post a unified PR comment summarising mcp-stack-validate results.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const reportPath = process.env.REPORT_PATH || 'mcp-stack-report.json';
const prNumber = process.env.PR_NUMBER;
if (!prNumber) {
  console.log('[mcp-stack-comment] no PR_NUMBER, skipping comment');
  process.exit(0);
}

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const ICON = { passed: 'pass', failed: 'fail', skipped: 'skip' };

const lines = [];
lines.push('## mcp-stack-validate');
lines.push('');
lines.push(`**${report.summary.passed} passed** | **${report.summary.failed} failed** | **${report.summary.skipped} skipped**`);
lines.push('');
lines.push('| Tool | Status | Summary |');
lines.push('|---|---|---|');
for (const step of report.steps) {
  const sum = step.summary
    ? Object.entries(step.summary).map(([k, v]) => `${k}=${v}`).join(' ')
    : step.reason || '';
  lines.push(`| \`${step.name}\` | ${ICON[step.status] || step.status} | ${sum} |`);
}
lines.push('');

const failed = report.steps.filter((s) => s.status === 'failed');
if (failed.length > 0) {
  lines.push('### Failures');
  for (const step of failed) {
    lines.push(`#### \`${step.name}\``);
    if (step.results && step.results.length > 0) {
      lines.push('');
      for (const r of step.results.slice(0, 10)) {
        const desc = r.message || r.error || r.status || JSON.stringify(r);
        lines.push(`- \`${r.file ?? ''}\` ${r.code ? '(' + r.code + ')' : ''} ${desc}`);
      }
      if (step.results.length > 10) lines.push(`- _… ${step.results.length - 10} more_`);
    }
    lines.push('');
  }
}

lines.push('---');
lines.push('Run individual checks: [agentvet-action](https://github.com/MukundaKatta/agentvet-action) | [agentsnap-action](https://github.com/MukundaKatta/agentsnap-action)');

const tmp = '/tmp/mcp-stack-comment.md';
await writeFile(tmp, lines.join('\n'), 'utf8');
const r = spawnSync('gh', ['pr', 'comment', prNumber, '-F', tmp], { stdio: 'inherit' });
process.exit(r.status ?? 1);
