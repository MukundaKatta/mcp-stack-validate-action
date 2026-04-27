# mcp-stack-validate-action

[![Marketplace](https://img.shields.io/badge/Marketplace-mcp--stack--validate-green?logo=github)](https://github.com/marketplace/actions/mcp-stack-validate-action)
[![CI](https://github.com/MukundaKatta/mcp-stack-validate-action/actions/workflows/test.yml/badge.svg)](https://github.com/MukundaKatta/mcp-stack-validate-action/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

One CI gate that runs the entire [@mukundakatta agent stack](https://www.npmjs.com/~mukundakatta) against your MCP / LLM-tool repo:

| Step | Library | What it checks |
|---|---|---|
| 1 | [agentfit](https://www.npmjs.com/package/@mukundakatta/agentfit) | every committed prompt is under the token budget |
| 2 | [agentguard](https://www.npmjs.com/package/@mukundakatta/agentguard) | every URL field in your tool registry is on the allowlist |
| 3 | [agentvet](https://www.npmjs.com/package/@mukundakatta/agentvet) | every tool definition has a name, description, snake_case |
| 4 | [agentsnap](https://www.npmjs.com/package/@mukundakatta/agentsnap) | every recorded trace matches its baseline |
| 5 | [agentcast](https://www.npmjs.com/package/@mukundakatta/agentcast) | every example payload validates against its shape spec |

Drop one action into a workflow instead of wiring five.

## Quick start

```yaml
- uses: actions/checkout@v4
- uses: MukundaKatta/mcp-stack-validate-action@v1
```

The action gracefully skips any step whose inputs aren't present (no policy file → skip agentguard, no snapshots dir → skip agentsnap, etc.). With zero config, it lints any tool defs and prompts it can find and reports the rest as `SKIP`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `mcp-config-path` | `mcp.json` | Path to MCP config (kept for forward compat). |
| `tools-glob` | `**/tools/*.json,**/mcp.json,**/.mcp.json` | Globs of tool-definition JSON files (agentvet + agentguard). |
| `prompts-glob` | `**/prompts/*.md,**/prompts/*.txt` | Globs of prompt files for token counting (agentfit). |
| `prompts-token-budget` | _(empty)_ | Fail when any single prompt exceeds this many tokens. Empty = report only. |
| `prompts-model` | `claude` | Model family for token estimation (`claude` / `gpt` / `gemini` / `llama`). |
| `agentguard-policy-path` | `.agentguard.json` | Path to agentguard policy. Skipped if missing. |
| `agentguard-urls-glob` | `**/tools/*.json,**/mcp.json,**/.mcp.json` | Files to scan for URL fields. |
| `snapshots-dir` | `tests/__agentsnap__` | Dir of `*.snap.json` baselines + `*.current.json` runs. |
| `shapes-glob` | `**/examples/*.json` | Globs of example payloads (paired with sibling `*.shape.json`). |
| `skip` | _(empty)_ | Comma-separated steps to skip: `agentfit,agentguard,agentsnap,agentvet,agentcast`. |
| `fail-on` | `any` | `any` = fail on any step failure; `none` = report only. |
| `comment-on-pr` | `true` | Post a unified summary on the PR. |
| `report-path` | `mcp-stack-report.json` | Where to write the unified JSON report. |
| `node-version` | `20` | Node version. |

## Outputs

| Output | Description |
|---|---|
| `agentfit-passed`, `agentguard-passed`, `agentsnap-passed`, `agentvet-passed`, `agentcast-passed` | `true` if the step passed (or was skipped). |
| `report-path` | Path to the unified JSON report. |

## Permissions

To post PR comments:

```yaml
permissions:
  pull-requests: write
  contents: read
```

## File layout this action expects

A typical MCP project that opts in to all five checks:

```
.
- mcp.json                            # tool defs (agentvet + agentguard)
- .agentguard.json                    # network policy (agentguard)
- prompts/
  - system.md                         # token-counted (agentfit)
- examples/
  - search-result.json                # value (agentcast)
  - search-result.shape.json          # spec (agentcast)
- tests/
  - __agentsnap__/
    - search_flow.snap.json           # baseline (agentsnap)
    - search_flow.current.json        # produced by your test run (agentsnap)
```

## Sibling actions

If you only want one of the checks:

- [`agentvet-action`](https://github.com/MukundaKatta/agentvet-action) — tool-def linter only
- [`agentsnap-action`](https://github.com/MukundaKatta/agentsnap-action) — snapshot diff only

## License

MIT
