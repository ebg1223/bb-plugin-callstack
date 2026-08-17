// Flow card: header (status, drift, trace, archive) + a view toggle between
// the nested tree (compact, reading order) and the diagram (spatial, shapes).
import { useState } from "react";
import {
  collectLanes,
  frameLane,
  locFilePath,
  type Frame,
  type StoredFlow,
} from "../flow-schema";
import { cn } from "@/lib/utils";
import { isStale, timeAgo } from "../lib/staleness";
import { DiagramView } from "./diagram-view";
import { LanesView } from "./lanes-view";
import {
  DefinitionsBlock,
  DiffBlock,
  LaneDot,
  LaneLegend,
  SharedBadge,
  SnippetBlock,
  TypePill,
  changeBadge,
  changeLabel,
  definitionsFor,
  edgeColor,
  flowHasChanges,
  frameChange,
  onTracePath,
  touchesChange,
  type FlowCallbacks,
} from "./frame-shared";

export type { FlowCallbacks, Snippet } from "./frame-shared";

function FrameNode({
  frame,
  flow,
  lanes,
  sharedFns,
  trace,
  onTrace,
  focusChanges,
  callbacks,
}: {
  frame: Frame;
  flow: StoredFlow;
  lanes: string[];
  sharedFns: Record<string, string[]>;
  trace: string | null;
  onTrace: (trace: string | null) => void;
  focusChanges: boolean;
  callbacks: FlowCallbacks;
}) {
  const otherFlows = (sharedFns[frame.fn] ?? []).filter(
    (name) => name !== flow.name,
  );
  const [open, setOpen] = useState(true);
  const [expandedChip, setExpandedChip] = useState<"in" | "out" | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const kids = frame.calls ?? [];
  const change = frameChange(frame);
  const types = flow.types ?? {};
  const inDefs = definitionsFor(frame.in, types);
  const outDefs = definitionsFor(frame.out, types);
  const shownDefs =
    expandedChip === "in" ? inDefs : expandedChip === "out" ? outDefs : [];
  const filePath = locFilePath(frame.loc);
  const drifted = filePath !== null && flow.driftedPaths.includes(filePath);
  const traced = trace !== null && onTracePath(frame, trace);
  const dimmed = trace !== null && !traced;

  const toggleChip = (chip: "in" | "out", edge: string | undefined) => {
    if (expandedChip === chip) {
      setExpandedChip(null);
      onTrace(null);
      return;
    }
    setExpandedChip(chip);
    const defs = chip === "in" ? inDefs : outDefs;
    onTrace(defs.length > 0 ? defs[0][0] : edge ?? null);
  };

  return (
    <div className={cn(dimmed && "opacity-40")}>
      <div
        className={cn(
          "rounded-md border border-border bg-background shadow-xs",
          "border-l-2",
          change ? edgeColor[change] : "border-l-border",
          change === "removed" && "opacity-70",
          traced && "ring-1 ring-violet-500/60",
        )}
      >
        {(frame.cond || frame.loop || frame.concurrent) && (
          <div className="flex flex-wrap gap-1.5 border-b border-border/60 px-2.5 py-1">
            {frame.concurrent && (
              <span
                title="Starts together with adjacent concurrent siblings — no sequence implied"
                className="rounded bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground"
              >
                ∥ concurrent
              </span>
            )}
            {frame.cond && (
              <span className="rounded bg-amber-500/10 px-1.5 py-px font-mono text-[11px] text-amber-700 dark:text-amber-400">
                if {frame.cond}
              </span>
            )}
            {frame.loop && (
              <span className="rounded bg-sky-500/10 px-1.5 py-px font-mono text-[11px] text-sky-700 dark:text-sky-400">
                ↻ {frame.loop}
              </span>
            )}
          </div>
        )}
        <div className="px-2.5 py-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {kids.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                aria-label={open ? `Collapse ${frame.fn}` : `Expand ${frame.fn}`}
                className="-ml-0.5 w-3.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {open ? "▾" : "▸"}
              </button>
            )}
            <LaneDot lane={frameLane(frame)} lanes={lanes} />
            <span
              className={cn(
                "font-mono text-[13px] font-medium text-foreground",
                change === "removed" && "line-through decoration-1",
              )}
            >
              {frame.fn}
            </span>
            <SharedBadge others={otherFlows} />
            {change && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] font-medium",
                  changeBadge[change],
                )}
              >
                {changeLabel[change]}
              </span>
            )}
            {drifted && (
              <span
                className="rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400"
                title="This file changed since the flow was published"
              >
                ⚠ drifted
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5">
              {frame.loc &&
                (callbacks.loadSnippet ? (
                  <button
                    type="button"
                    onClick={() => setShowSnippet((current) => !current)}
                    aria-expanded={showSnippet}
                    title="Show code at this location"
                    className="truncate text-[11px] text-muted-foreground/70 underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    {frame.loc}
                  </button>
                ) : (
                  <span className="truncate text-[11px] text-muted-foreground/70">
                    {frame.loc}
                  </span>
                ))}
              {change && change !== "removed" && filePath && callbacks.loadDiff && (
                <button
                  type="button"
                  onClick={() => setShowDiff((current) => !current)}
                  aria-expanded={showDiff}
                  className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  diff
                </button>
              )}
            </span>
          </div>
          {(frame.in || frame.out) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <TypePill
                role="in"
                text={frame.in ?? "()"}
                definitions={inDefs}
                expanded={expandedChip === "in"}
                traced={traced && expandedChip === "in"}
                onToggle={() => toggleChip("in", frame.in)}
              />
              <span className="text-xs text-muted-foreground">→</span>
              <TypePill
                role="out"
                text={frame.out ?? "void"}
                definitions={outDefs}
                expanded={expandedChip === "out"}
                traced={traced && expandedChip === "out"}
                onToggle={() => toggleChip("out", frame.out)}
              />
            </div>
          )}
          <DefinitionsBlock definitions={shownDefs} />
          {showSnippet && frame.loc && callbacks.loadSnippet && (
            <SnippetBlock loc={frame.loc} load={callbacks.loadSnippet} />
          )}
          {showDiff && filePath && callbacks.loadDiff && (
            <DiffBlock path={filePath} load={callbacks.loadDiff} />
          )}
          {frame.note && (
            <p className="pt-1 text-[11px] italic text-muted-foreground">
              {frame.note}
            </p>
          )}
          {frame.detail && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowDetail((current) => !current)}
                aria-expanded={showDetail}
                className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                ⓘ {showDetail ? "hide details" : "details"}
              </button>
              {showDetail && (
                <p className="whitespace-pre-wrap pt-1 text-[11px] leading-4 text-muted-foreground">
                  {frame.detail}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {open && kids.length > 0 && (
        <div className="ml-3.5 space-y-1.5 border-l border-border pl-3 pt-1.5">
          <FrameList
            frames={kids}
            flow={flow}
            lanes={lanes}
            sharedFns={sharedFns}
            trace={trace}
            onTrace={onTrace}
            focusChanges={focusChanges}
            callbacks={callbacks}
          />
        </div>
      )}
    </div>
  );
}

/** A run of sibling frames with no changes anywhere below, collapsed to a stub. */
function CollapsedRun({
  frames,
  flow,
  lanes,
  sharedFns,
  trace,
  onTrace,
  callbacks,
}: {
  frames: Frame[];
  flow: StoredFlow;
  lanes: string[];
  sharedFns: Record<string, string[]>;
  trace: string | null;
  onTrace: (trace: string | null) => void;
  callbacks: FlowCallbacks;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!expanded)
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        ▸ {frames.length} unchanged call{frames.length === 1 ? "" : "s"}
      </button>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="block text-[11px] text-muted-foreground hover:text-foreground"
      >
        ▾ hide unchanged
      </button>
      {frames.map((frame, index) => (
        <FrameNode
          key={`${frame.fn}-${index}`}
          frame={frame}
          flow={flow}
          lanes={lanes}
          sharedFns={sharedFns}
          trace={trace}
          onTrace={onTrace}
          focusChanges={false}
          callbacks={callbacks}
        />
      ))}
    </>
  );
}

function FrameList({
  frames,
  flow,
  lanes,
  sharedFns,
  trace,
  onTrace,
  focusChanges,
  callbacks,
}: {
  frames: Frame[];
  flow: StoredFlow;
  lanes: string[];
  sharedFns: Record<string, string[]>;
  trace: string | null;
  onTrace: (trace: string | null) => void;
  focusChanges: boolean;
  callbacks: FlowCallbacks;
}) {
  if (!focusChanges)
    return (
      <>
        {frames.map((frame, index) => (
          <FrameNode
            key={`${frame.fn}-${index}`}
            frame={frame}
            flow={flow}
            lanes={lanes}
            sharedFns={sharedFns}
            trace={trace}
            onTrace={onTrace}
            focusChanges={focusChanges}
            callbacks={callbacks}
          />
        ))}
      </>
    );
  // Group consecutive unchanged siblings into collapsible stubs.
  const segments: (
    | { kind: "frame"; frame: Frame; index: number }
    | { kind: "run"; frames: Frame[]; index: number }
  )[] = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (touchesChange(frame)) {
      segments.push({ kind: "frame", frame, index });
    } else {
      const last = segments[segments.length - 1];
      if (last?.kind === "run") last.frames.push(frame);
      else segments.push({ kind: "run", frames: [frame], index });
    }
  }
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "frame" ? (
          <FrameNode
            key={`f-${segment.index}`}
            frame={segment.frame}
            flow={flow}
            lanes={lanes}
            sharedFns={sharedFns}
            trace={trace}
            onTrace={onTrace}
            focusChanges
            callbacks={callbacks}
          />
        ) : (
          <CollapsedRun
            key={`r-${segment.index}`}
            frames={segment.frames}
            flow={flow}
            lanes={lanes}
            sharedFns={sharedFns}
            trace={trace}
            onTrace={onTrace}
            callbacks={callbacks}
          />
        ),
      )}
    </>
  );
}

export function FlowView({
  flow,
  now,
  sharedFns = {},
  callbacks = {},
}: {
  flow: StoredFlow;
  /** Current time; the panel ticks it so staleness and "ago" stay live. */
  now: number;
  /** fn → names of active flows containing it (for convergence badges). */
  sharedFns?: Record<string, string[]>;
  callbacks?: FlowCallbacks;
}) {
  const [trace, setTrace] = useState<string | null>(null);
  const [view, setView] = useState<"tree" | "diagram" | "lanes">("tree");
  const stale = isStale(flow, now);
  const focusChanges = flowHasChanges(flow);
  const lanes = collectLanes(flow.frames);
  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card p-3",
        (flow.archived || stale) && "opacity-60",
      )}
    >
      <header className="mb-2 border-b border-border/60 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{flow.name}</h3>
          {flow.status && (
            <span
              className={cn(
                "rounded-full px-2 py-px text-[10px] font-medium",
                flow.status === "proposed"
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {flow.status}
            </span>
          )}
          {flow.driftedPaths.length > 0 && (
            <span
              className="rounded-full bg-amber-500/15 px-2 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400"
              title={`Changed since publish: ${flow.driftedPaths.join(", ")}`}
            >
              ⚠ {flow.driftedPaths.length} file
              {flow.driftedPaths.length === 1 ? "" : "s"} drifted
            </span>
          )}
          {stale && (
            <span className="rounded-full bg-muted px-2 py-px text-[10px] text-muted-foreground">
              stale
            </span>
          )}
          {trace && (
            <button
              type="button"
              onClick={() => setTrace(null)}
              className="rounded-full bg-violet-500/10 px-2 py-px text-[10px] font-medium text-violet-700 hover:bg-violet-500/20 dark:text-violet-300"
            >
              tracing {trace} ✕
            </button>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className="text-[11px] text-muted-foreground/70"
              title={new Date(flow.updatedAt).toLocaleString()}
            >
              {timeAgo(flow.updatedAt, now)}
            </span>
            <span className="flex overflow-hidden rounded border border-border text-[10px]">
              {(["tree", "diagram", "lanes"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  className={cn(
                    "px-1.5 py-px",
                    view === mode
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode}
                </button>
              ))}
            </span>
            {callbacks.onSetArchived && (
              <button
                type="button"
                onClick={() =>
                  callbacks.onSetArchived?.(flow.name, !flow.archived)
                }
                className="rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {flow.archived ? "Restore" : "Archive"}
              </button>
            )}
          </span>
        </div>
        {flow.description && (
          <p className="pt-1 text-xs text-muted-foreground">
            {flow.description}
          </p>
        )}
      </header>
      {view === "diagram" ? (
        <DiagramView
          key={flow.updatedAt}
          flow={flow}
          lanes={lanes}
          sharedFns={sharedFns}
          trace={trace}
          onTrace={setTrace}
          callbacks={callbacks}
        />
      ) : view === "lanes" ? (
        <LanesView
          key={flow.updatedAt}
          flow={flow}
          lanes={lanes}
          trace={trace}
          onTrace={setTrace}
          callbacks={callbacks}
        />
      ) : (
        <div className="space-y-1.5">
          <FrameList
            frames={flow.frames}
            flow={flow}
            lanes={lanes}
            sharedFns={sharedFns}
            trace={trace}
            onTrace={setTrace}
            focusChanges={focusChanges}
            callbacks={callbacks}
          />
        </div>
      )}
      <LaneLegend lanes={lanes} />
    </section>
  );
}

export function FlowLegend() {
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span className="text-emerald-600 dark:text-emerald-400">+ added</span>
      <span className="text-amber-600 dark:text-amber-400">~ modified</span>
      <span className="text-red-600 dark:text-red-400">− removed</span>
      <span className="text-violet-700 dark:text-violet-300">
        type pill (click to trace; dotted = has definition)
      </span>
      <span className="text-amber-700 dark:text-amber-400">
        ⚠ drifted = file changed since publish
      </span>
      <span>loc = click for code</span>
      <span>◇ edge condition · ↻ loop · ⓘ details</span>
    </p>
  );
}
