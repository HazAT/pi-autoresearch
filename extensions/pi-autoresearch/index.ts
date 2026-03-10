/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - `/autoresearch` command — interactive experiment dashboard
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateTail } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, truncateToWidth, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExperimentResult {
  commit: string;
  metric: number;
  status: "keep" | "discard" | "crash";
  description: string;
  timestamp: number;
}

interface ExperimentState {
  results: ExperimentResult[];
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  runTag: string | null;
  totalExperiments: number;
}

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
});

const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The measured metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMetric(value: number | null, unit: string): string {
  if (value === null) return "—";
  return unit === "s" ? `${value.toFixed(1)}s` : value.toFixed(6);
}

function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  let state: ExperimentState = {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "s",
    runTag: null,
    totalExperiments: 0,
  };

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    state = {
      results: [],
      bestMetric: null,
      bestDirection: "lower",
      metricName: "metric",
      metricUnit: "s",
      runTag: null,
      totalExperiments: 0,
    };

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
        continue;
      const details = msg.details as LogDetails | undefined;
      if (details?.state) {
        state = details.state;
      }
    }

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    if (state.totalExperiments === 0) {
      ctx.ui.setWidget("autoresearch", undefined);
      return;
    }

    const kept = state.results.filter((r) => r.status === "keep").length;
    const crashed = state.results.filter((r) => r.status === "crash").length;
    const best = formatMetric(state.bestMetric, state.metricUnit);

    ctx.ui.setWidget("autoresearch", (_tui, theme) => {
      const parts = [
        theme.fg("accent", "🔬 autoresearch"),
        theme.fg("muted", ` ${state.totalExperiments} runs`),
        theme.fg("success", ` ${kept} kept`),
        crashed > 0 ? theme.fg("error", ` ${crashed} crashed`) : "",
        theme.fg("dim", " │ "),
        theme.fg("warning", `best: ${best}`),
        state.runTag
          ? theme.fg("dim", ` │ ${state.runTag}`)
          : "",
      ];
      return new Text(parts.join(""), 0, 0);
    });
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      "Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Use for any autoresearch experiment.",
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const timeout = (params.timeout_seconds ?? 600) * 1000;

      onUpdate?.({
        content: [{ type: "text", text: `Running: ${params.command}` }],
        details: { phase: "running" },
      });

      const t0 = Date.now();

      const result = await pi.exec(
        "bash",
        ["-c", params.command],
        { signal, timeout, cwd: ctx.cwd }
      );

      const durationSeconds = (Date.now() - t0) / 1000;
      const output = (result.stdout + "\n" + result.stderr).trim();
      const passed = result.code === 0 && !result.killed;

      const details: RunDetails = {
        command: params.command,
        exitCode: result.code,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut: !!result.killed,
        tailOutput: output.split("\n").slice(-80).join("\n"),
      };

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!passed) {
        text += `💥 FAILED (exit code ${result.code}) in ${durationSeconds.toFixed(1)}s\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
      }

      if (state.bestMetric !== null && passed) {
        const delta = durationSeconds - state.bestMetric;
        if (isBetter(durationSeconds, state.bestMetric, state.bestDirection)) {
          text += `🎉 NEW BEST! Improved by ${Math.abs(delta).toFixed(1)}s over previous best (${formatMetric(state.bestMetric, state.metricUnit)})\n`;
        } else {
          text += `❌ Slower by ${delta.toFixed(1)}s vs best (${formatMetric(state.bestMetric, state.metricUnit)}). Consider reverting.\n`;
        }
      }

      text += `\nLast 80 lines of output:\n${details.tailOutput}`;

      const truncation = truncateTail(text, {
        maxLines: 150,
        maxBytes: 40000,
      });

      return {
        content: [{ type: "text", text: truncation.content }],
        details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", "⏳ Running experiment..."),
          0,
          0
        );
      }

      const d = result.details as RunDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        if (expanded) text += "\n" + theme.fg("dim", d.tailOutput.slice(-500));
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`);
        if (expanded) text += "\n" + theme.fg("dim", d.tailOutput.slice(-500));
        return new Text(text, 0, 0);
      }

      let text =
        theme.fg("success", "✅ ") +
        theme.fg("accent", `${d.durationSeconds.toFixed(1)}s`);

      if (expanded) {
        text += "\n" + theme.fg("dim", d.tailOutput.slice(-1000));
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "Use status 'keep' if the metric improved, 'discard' if worse, 'crash' if it failed.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const experiment: ExperimentResult = {
        commit: params.commit.slice(0, 7),
        metric: params.metric,
        status: params.status,
        description: params.description,
        timestamp: Date.now(),
      };

      state.results.push(experiment);
      state.totalExperiments++;

      if (
        params.status === "keep" &&
        params.metric > 0 &&
        (state.bestMetric === null ||
          isBetter(params.metric, state.bestMetric, state.bestDirection))
      ) {
        state.bestMetric = params.metric;
      }

      updateWidget(ctx);

      let text = `Logged #${state.totalExperiments}: ${experiment.status} — ${experiment.description}`;
      if (state.bestMetric !== null) {
        text += `\nBest so far: ${formatMetric(state.bestMetric, state.metricUnit)} (${state.totalExperiments} experiments)`;
      }

      return {
        content: [{ type: "text", text }],
        details: { experiment, state: { ...state } } as LogDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.totalExperiments}`) +
        " " +
        theme.fg("muted", exp.description);

      if (s.bestMetric !== null) {
        text +=
          theme.fg("dim", " │ best: ") +
          theme.fg("warning", formatMetric(s.bestMetric, s.metricUnit));
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // /autoresearch command — dashboard
  // -----------------------------------------------------------------------

  pi.registerCommand("autoresearch", {
    description: "Show autoresearch experiment dashboard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/autoresearch requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new DashboardComponent(state, theme, () => done());
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard UI
// ---------------------------------------------------------------------------

class DashboardComponent {
  private state: ExperimentState;
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(state: ExperimentState, theme: Theme, onClose: () => void) {
    this.state = state;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    const th = this.theme;

    lines.push("");
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          th.fg("accent", " 🔬 autoresearch ") +
          th.fg("borderMuted", "─".repeat(Math.max(0, width - 22))),
        width
      )
    );
    lines.push("");

    if (this.state.totalExperiments === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No experiments yet.")}`,
          width
        )
      );
    } else {
      const kept = this.state.results.filter((r) => r.status === "keep").length;
      const discarded = this.state.results.filter((r) => r.status === "discard").length;
      const crashed = this.state.results.filter((r) => r.status === "crash").length;
      const best = formatMetric(this.state.bestMetric, this.state.metricUnit);

      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", "Total:")} ${th.fg("text", String(this.state.totalExperiments))}` +
            `  ${th.fg("success", `${kept} kept`)}` +
            `  ${th.fg("warning", `${discarded} discarded`)}` +
            `  ${th.fg("error", `${crashed} crashed`)}`,
          width
        )
      );
      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", "Best:")} ${th.fg("accent", best)}`,
          width
        )
      );

      if (this.state.runTag) {
        lines.push(
          truncateToWidth(
            `  ${th.fg("muted", "Tag:")} ${th.fg("dim", this.state.runTag)}`,
            width
          )
        );
      }

      lines.push("");

      // Table header
      const col = { idx: 4, commit: 9, metric: 10, status: 9 };
      const descW = Math.max(10, width - col.idx - col.commit - col.metric - col.status - 10);

      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", "#".padEnd(col.idx))}` +
            `${th.fg("muted", "commit".padEnd(col.commit))}` +
            `${th.fg("muted", "metric".padEnd(col.metric))}` +
            `${th.fg("muted", "status".padEnd(col.status))}` +
            `${th.fg("muted", "description")}`,
          width
        )
      );
      lines.push(
        truncateToWidth(`  ${th.fg("borderMuted", "─".repeat(width - 4))}`, width)
      );

      for (let i = 0; i < this.state.results.length; i++) {
        const r = this.state.results[i];
        const color =
          r.status === "keep"
            ? "success"
            : r.status === "crash"
              ? "error"
              : "warning";
        const isBest =
          r.status === "keep" &&
          this.state.bestMetric !== null &&
          Math.abs(r.metric - this.state.bestMetric) < 0.01;

        lines.push(
          truncateToWidth(
            `  ${th.fg("dim", String(i + 1).padEnd(col.idx))}` +
              `${th.fg("accent", r.commit.padEnd(col.commit))}` +
              `${th.fg(isBest ? "warning" : "text", formatMetric(r.metric, this.state.metricUnit).padEnd(col.metric))}` +
              `${th.fg(color, r.status.padEnd(col.status))}` +
              `${th.fg("muted", r.description.slice(0, descW))}`,
            width
          )
        );
      }
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
