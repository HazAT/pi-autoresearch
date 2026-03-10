# autoresearch for pi

A [pi](https://github.com/badlogic/pi) extension + skill inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Generic autonomous experiment loop — works for any "run, measure, keep or discard" workflow.

## What's included

```
extensions/pi-autoresearch/index.ts   — pi extension (tools + widget + dashboard)
skills/autoresearch-create/SKILL.md — meta-skill to generate domain-specific skills
```

### Extension

| Feature | Description |
|---------|-------------|
| `run_experiment` tool | Runs any command, times wall-clock duration, captures output, detects pass/fail |
| `log_experiment` tool | Records results with session-persisted state (survives restarts, supports branching) |
| Status widget | `🔬 autoresearch 12 runs 8 kept │ best: 42.3s` above the editor |
| `/autoresearch` command | Interactive dashboard with full results table |

### Meta-skill

`/skill:autoresearch-create` asks a few questions (metric, command, files in scope, constraints, ideas) and generates a domain-specific skill ready to use.

## Install

Copy into your pi agent directory:

```bash
# Extension
cp -r extensions/pi-autoresearch ~/.pi/agent/extensions/

# Skill
cp -r skills/autoresearch-create ~/.pi/agent/skills/
```

Then `/reload` in pi.

## Usage

### 1. Generate a domain skill

```
/skill:autoresearch-create
```

> "I want to optimize vitest execution time in this project"

The agent generates a skill like `autoresearch-vitest-speed` and installs it.

### 2. Run it

```
/skill:autoresearch-vitest-speed
```

The agent enters the experiment loop: edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat forever.

### 3. Monitor

- **Widget** — always visible above the editor
- **`/autoresearch`** — full dashboard (press Escape to close)
- **Escape** — interrupt the agent anytime, ask for a summary

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |

## How it works

The **extension** is domain-agnostic infrastructure — it runs commands, tracks results, renders UI. The **skill** encodes domain knowledge — what to optimize, what's in scope, what ideas to try. This separation means one extension serves unlimited domains.

```
┌─────────────────────┐     ┌──────────────────────────┐
│  Extension (global)  │     │  Skill (per-domain)       │
│                     │     │                          │
│  run_experiment     │◄────│  command: pnpm test      │
│  log_experiment     │     │  metric: seconds (lower) │
│  widget + dashboard │     │  scope: vitest configs   │
│                     │     │  ideas: pool, parallel…  │
└─────────────────────┘     └──────────────────────────┘
```

## License

MIT
