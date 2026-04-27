#!/usr/bin/env node
/**
 * mcp-stack-validate-action: orchestrator.
 *
 * Runs the @mukundakatta agent stack against the project in a fixed order:
 *   1. agentfit   — token-budget any committed prompts
 *   2. agentguard — every URL field in tool defs is allowed by the policy
 *   3. agentvet   — every tool definition has name/description/inputSchema
 *   4. agentsnap  — every *.snap.json baseline matches its *.current.json
 *   5. agentcast  — every example JSON validates against its sibling .shape.json
 *
 * Each step is independent: if its inputs are missing it reports "skipped";
 * if any step fails and MCP_FAIL_ON=any, exits non-zero at the end.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';

import { count } from '@mukundakatta/agentfit';
import { policy, check } from '@mukundakatta/agentguard';
import { diff } from '@mukundakatta/agentsnap';
import { validate as vetValidate, adapters as vetAdapters } from '@mukundakatta/agentvet';
import { adapters as castAdapters } from '@mukundakatta/agentcast';

const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const skip = new Set(
  (process.env.MCP_SKIP || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const failMode = (process.env.MCP_FAIL_ON || 'any').toLowerCase();
const reportPath = process.env.MCP_REPORT_PATH || 'mcp-stack-report.json';

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  return writeFile(out, `${name}=${value}\n`, { flag: 'a' });
}

function makeMatcher(pattern) {
  const re =
    '^' +
    pattern
      .split('/')
      .map((seg) => {
        if (seg === '**') return '(?:.*)';
        return seg
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]');
      })
      .join('/') +
    '$';
  const rx = new RegExp(re);
  return (rel) => rx.test(rel.split(sep).join('/'));
}

async function* walkDir(root) {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        ) continue;
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) yield abs;
    }
  }
}

async function expandGlobs(globsRaw) {
  const globs = (globsRaw || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const matches = new Set();
  for (const pattern of globs) {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      const abs = join(cwd, pattern);
      if (existsSync(abs)) matches.add(abs);
      continue;
    }
    const matcher = makeMatcher(pattern);
    for await (const file of walkDir(cwd)) {
      if (matcher(relative(cwd, file))) matches.add(file);
    }
  }
  return [...matches].sort();
}

// --- step 1: agentfit ----------------------------------------------------

async function runAgentfit() {
  if (skip.has('agentfit')) return { name: 'agentfit', status: 'skipped', reason: 'in skip list' };
  const files = await expandGlobs(process.env.MCP_PROMPTS_GLOB || '');
  if (files.length === 0) {
    return { name: 'agentfit', status: 'skipped', reason: 'no matching prompt files' };
  }
  const budget = process.env.MCP_PROMPTS_BUDGET ? parseInt(process.env.MCP_PROMPTS_BUDGET, 10) : null;
  const model = process.env.MCP_PROMPTS_MODEL || 'claude';
  const results = [];
  let errors = 0;
  for (const abs of files) {
    const rel = relative(cwd, abs);
    const text = await readFile(abs, 'utf8');
    const tokens = count(text, { model });
    const overBudget = budget != null && tokens > budget;
    if (overBudget) errors += 1;
    results.push({ file: rel, tokens, budget, over_budget: overBudget });
    const annot = overBudget ? '::error' : '::notice';
    console.log(`${annot} file=${rel}::agentfit estimated ${tokens} tokens${budget != null ? ` (budget ${budget})` : ''}`);
  }
  return {
    name: 'agentfit',
    status: errors > 0 ? 'failed' : 'passed',
    summary: { files: results.length, over_budget: errors, model, budget },
    results,
  };
}

// --- step 2: agentguard --------------------------------------------------

function findUrls(value, path = []) {
  // Walk an arbitrary JSON value; yield {path, url} for every string that
  // parses as an http(s) URL, plus any value at known URL-bearing keys.
  const out = [];
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push({ path: path.join('.'), url: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findUrls(v, [...path, i])));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(...findUrls(v, [...path, k]));
    }
  }
  return out;
}

async function runAgentguard() {
  if (skip.has('agentguard')) return { name: 'agentguard', status: 'skipped', reason: 'in skip list' };
  const policyPath = process.env.MCP_AGENTGUARD_POLICY || '.agentguard.json';
  const policyAbs = join(cwd, policyPath);
  if (!existsSync(policyAbs)) {
    return { name: 'agentguard', status: 'skipped', reason: `no policy at ${policyPath}` };
  }
  let pol;
  try {
    const raw = await readFile(policyAbs, 'utf8');
    pol = policy(JSON.parse(raw));
  } catch (err) {
    return {
      name: 'agentguard',
      status: 'failed',
      summary: { policy_error: err.message, denied: 0 },
      results: [],
    };
  }
  const files = await expandGlobs(process.env.MCP_AGENTGUARD_URLS_GLOB || '');
  let denied = 0;
  let scanned = 0;
  const results = [];
  for (const abs of files) {
    const rel = relative(cwd, abs);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(abs, 'utf8'));
    } catch {
      continue;
    }
    for (const { path: jsonPath, url } of findUrls(parsed)) {
      scanned += 1;
      const decision = check(pol, url);
      if (decision.action === 'deny') {
        denied += 1;
        results.push({ file: rel, json_path: jsonPath, url, reason: decision.reason, detail: decision.detail });
        console.log(`::error file=${rel}::agentguard deny ${jsonPath}=${url}: ${decision.reason} (${decision.detail})`);
      }
    }
  }
  return {
    name: 'agentguard',
    status: denied > 0 ? 'failed' : 'passed',
    summary: { urls_scanned: scanned, denied, policy: policyPath },
    results,
  };
}

// --- step 3: agentvet (tool def shape) -----------------------------------

function extractTools(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object') {
    if (Array.isArray(doc.tools)) return doc.tools;
    if (doc.mcpServers && typeof doc.mcpServers === 'object') {
      const out = [];
      for (const server of Object.values(doc.mcpServers)) {
        if (Array.isArray(server?.tools)) out.push(...server.tools);
      }
      return out;
    }
    if (typeof doc.name === 'string' && (doc.description || doc.parameters || doc.inputSchema)) {
      return [doc];
    }
  }
  return [];
}

async function runAgentvet() {
  if (skip.has('agentvet')) return { name: 'agentvet', status: 'skipped', reason: 'in skip list' };
  const files = await expandGlobs(process.env.MCP_TOOLS_GLOB || '');
  if (files.length === 0) {
    return { name: 'agentvet', status: 'skipped', reason: 'no matching tool files' };
  }
  const baseShape = vetAdapters.shape({ name: 'string', description: 'string' });
  const snakeCase = vetAdapters.fn(
    (a) => typeof a?.name === 'string' && /^[a-z][a-z0-9_]*$/.test(a.name),
    (a) => `name '${a?.name}' must be snake_case`,
  );
  let errors = 0;
  let totalTools = 0;
  const results = [];
  for (const abs of files) {
    const rel = relative(cwd, abs);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(abs, 'utf8'));
    } catch (err) {
      errors += 1;
      results.push({ file: rel, name: null, code: 'E000', message: `invalid JSON: ${err.message}` });
      console.log(`::error file=${rel}::agentvet invalid JSON: ${err.message}`);
      continue;
    }
    const tools = extractTools(parsed);
    tools.forEach((tool, idx) => {
      totalTools += 1;
      const r = vetValidate('tool-shape', baseShape, tool);
      if (!r.valid) {
        errors += 1;
        results.push({ file: rel, index: idx, name: tool?.name ?? null, code: 'E001', message: r.error.validationError });
        console.log(`::error file=${rel}::agentvet [E001] tool[${idx}] ${tool?.name ?? '<no-name>'}: ${r.error.validationError}`);
      }
      if (typeof tool?.name === 'string') {
        const sr = vetValidate('tool-name', snakeCase, tool);
        if (!sr.valid) {
          errors += 1;
          results.push({ file: rel, index: idx, name: tool.name, code: 'E002', message: sr.error.validationError });
          console.log(`::error file=${rel}::agentvet [E002] tool[${idx}]: ${sr.error.validationError}`);
        }
      }
    });
  }
  return {
    name: 'agentvet',
    status: errors > 0 ? 'failed' : 'passed',
    summary: { tools: totalTools, errors },
    results,
  };
}

// --- step 4: agentsnap ---------------------------------------------------

async function runAgentsnap() {
  if (skip.has('agentsnap')) return { name: 'agentsnap', status: 'skipped', reason: 'in skip list' };
  const dir = process.env.MCP_SNAPSHOTS_DIR || 'tests/__agentsnap__';
  const absDir = join(cwd, dir);
  if (!existsSync(absDir)) {
    return { name: 'agentsnap', status: 'skipped', reason: `dir does not exist: ${dir}` };
  }
  const baselines = [];
  for await (const file of walkDir(absDir)) {
    if (file.endsWith('.snap.json')) baselines.push(file);
  }
  if (baselines.length === 0) {
    return { name: 'agentsnap', status: 'skipped', reason: 'no .snap.json files' };
  }
  let drift = 0;
  const results = [];
  for (const baselinePath of baselines) {
    const rel = relative(cwd, baselinePath);
    const currentPath = baselinePath.replace(/\.snap\.json$/, '.current.json');
    if (!existsSync(currentPath)) {
      results.push({ file: rel, status: 'NO_CURRENT' });
      console.log(`::warning file=${rel}::agentsnap missing ${basename(currentPath)}`);
      continue;
    }
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    const r = diff(baseline, current);
    results.push({ file: rel, status: r.status, changes: r.changes });
    if (r.status !== 'PASSED') {
      drift += 1;
      console.log(`::error file=${rel}::agentsnap ${r.status}`);
    }
  }
  return {
    name: 'agentsnap',
    status: drift > 0 ? 'failed' : 'passed',
    summary: { snapshots: baselines.length, drift },
    results,
  };
}

// --- step 5: agentcast ---------------------------------------------------

async function runAgentcast() {
  if (skip.has('agentcast')) return { name: 'agentcast', status: 'skipped', reason: 'in skip list' };
  const files = await expandGlobs(process.env.MCP_SHAPES_GLOB || '');
  if (files.length === 0) {
    return { name: 'agentcast', status: 'skipped', reason: 'no matching example files' };
  }
  let errors = 0;
  let validated = 0;
  const results = [];
  for (const abs of files) {
    const rel = relative(cwd, abs);
    if (abs.endsWith('.shape.json')) continue; // these are spec files, not examples
    const shapePath = abs.replace(/\.json$/, '.shape.json');
    if (!existsSync(shapePath)) continue; // no shape file for this example → skip
    let value;
    let spec;
    try {
      value = JSON.parse(await readFile(abs, 'utf8'));
      spec = JSON.parse(await readFile(shapePath, 'utf8'));
    } catch (err) {
      errors += 1;
      results.push({ file: rel, error: err.message });
      console.log(`::error file=${rel}::agentcast cannot parse: ${err.message}`);
      continue;
    }
    const validator = castAdapters.shape(spec);
    const r = validator(value);
    validated += 1;
    if (!r.valid) {
      errors += 1;
      results.push({ file: rel, shape: relative(cwd, shapePath), error: r.error });
      console.log(`::error file=${rel}::agentcast ${r.error}`);
    } else {
      results.push({ file: rel, shape: relative(cwd, shapePath), valid: true });
    }
  }
  return {
    name: 'agentcast',
    status: errors > 0 ? 'failed' : 'passed',
    summary: { examples: validated, errors },
    results,
  };
}

// --- main ----------------------------------------------------------------

async function main() {
  const steps = [];
  // Run sequentially so output is readable.
  steps.push(await runAgentfit());
  steps.push(await runAgentguard());
  steps.push(await runAgentvet());
  steps.push(await runAgentsnap());
  steps.push(await runAgentcast());

  const passed = (s) => s.status === 'passed' || s.status === 'skipped';

  for (const s of steps) {
    const tag = s.status === 'passed' ? 'OK' : s.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(`[${tag}] ${s.name}${s.summary ? ` ${JSON.stringify(s.summary)}` : ''}${s.reason ? ` (${s.reason})` : ''}`);
    await setOutput(`${s.name}-passed`, passed(s) ? 'true' : 'false');
  }

  const report = {
    summary: {
      total_steps: steps.length,
      passed: steps.filter((s) => s.status === 'passed').length,
      skipped: steps.filter((s) => s.status === 'skipped').length,
      failed: steps.filter((s) => s.status === 'failed').length,
    },
    steps,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await setOutput('report-path', reportPath);

  if (failMode === 'any' && report.summary.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[mcp-stack] fatal: ${err.stack || err.message}`);
  process.exit(2);
});
