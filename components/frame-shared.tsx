// Primitives shared by the tree and diagram views: change styling, type
// pills, snippet + diff blocks, and the small pure helpers over frames.
import { useEffect, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { Frame, StoredFlow } from "../flow-schema";
import { cn } from "@/lib/utils";

export type Change = "added" | "removed" | "modified";

export interface Snippet {
  path: string | null;
  startLine: number | null;
  targetLine: number | null;
  lines: string[];
  error: string | null;
}

export interface FlowCallbacks {
  onSetArchived?: (name: string, archived: boolean) => void;
  loadSnippet?: (loc: string) => Promise<Snippet>;
  loadDiff?: (
    path: string,
  ) => Promise<{ patch: string | null; error: string | null }>;
}

export const edgeColor: Record<Change, string> = {
  added: "border-l-emerald-500",
  removed: "border-l-red-500",
  modified: "border-l-amber-500",
};

export const changeBadge: Record<Change, string> = {
  added: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  removed: "bg-red-500/10 text-red-600 dark:text-red-400",
  modified: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

export const changeLabel: Record<Change, string> = {
  added: "+ added",
  removed: "− removed",
  modified: "~ modified",
};

export function frameChange(frame: Frame): Change | null {
  return frame.change && frame.change !== "same"
    ? (frame.change as Change)
    : null;
}

/** True if this frame or any descendant carries a change marker. */
export function touchesChange(frame: Frame): boolean {
  return frameChange(frame) !== null || (frame.calls ?? []).some(touchesChange);
}

export function flowHasChanges(flow: StoredFlow): boolean {
  return flow.frames.some(touchesChange);
}

/** Definitions from the types map whose name appears in this edge string. */
export function definitionsFor(
  edge: string | undefined,
  types: Record<string, string>,
): [string, string][] {
  if (!edge) return [];
  return Object.entries(types).filter(([name]) => edge.includes(name));
}

// Lane colors are structural (module identity), deliberately avoiding violet
// (types) and the change colors' semantics — dots, not fills, keep them quiet.
const lanePalette = [
  "bg-sky-500",
  "bg-teal-500",
  "bg-rose-500",
  "bg-indigo-500",
  "bg-lime-500",
  "bg-orange-500",
];

export function laneColor(lane: string, lanes: string[]): string {
  const index = lanes.indexOf(lane);
  return lanePalette[(index >= 0 ? index : 0) % lanePalette.length];
}

export function LaneDot({
  lane,
  lanes,
}: {
  lane: string | null;
  lanes: string[];
}) {
  if (!lane || lanes.length < 2) return null;
  return (
    <span
      title={`module: ${lane}`}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-sm",
        laneColor(lane, lanes),
      )}
    />
  );
}

export function LaneLegend({ lanes }: { lanes: string[] }) {
  if (lanes.length < 2) return null;
  return (
    <p className="flex flex-wrap gap-x-2.5 gap-y-1 pt-1.5 text-[10px] text-muted-foreground">
      {lanes.map((lane) => (
        <span key={lane} className="flex items-center gap-1">
          <span
            className={cn("h-2 w-2 rounded-sm", laneColor(lane, lanes))}
          />
          {lane}
        </span>
      ))}
    </p>
  );
}

export function SharedBadge({ others }: { others: string[] }) {
  if (others.length === 0) return null;
  return (
    <span
      title={`Also in: ${others.join(", ")}`}
      className="rounded-full bg-muted px-1 py-px text-[10px] text-muted-foreground"
    >
      ⇄
    </span>
  );
}

export function onTracePath(frame: Frame, trace: string): boolean {
  return (
    (frame.in?.includes(trace) ?? false) ||
    (frame.out?.includes(trace) ?? false)
  );
}

export function TypePill({
  role,
  text,
  definitions,
  expanded,
  traced,
  onToggle,
}: {
  role: "in" | "out";
  text: string;
  definitions: [string, string][];
  expanded: boolean;
  traced: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={
        definitions.length > 0
          ? `${role} type — click to trace + show definition`
          : `${role} type — click to trace through the flow`
      }
      className={cn(
        "rounded-full px-2 py-px font-mono text-[11px]",
        "bg-violet-500/10 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300",
        traced && "ring-1 ring-violet-500",
        definitions.length > 0 &&
          "underline decoration-dotted underline-offset-2",
      )}
    >
      {text}
    </button>
  );
}

export function DefinitionsBlock({
  definitions,
}: {
  definitions: [string, string][];
}) {
  if (definitions.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1 rounded border-l-2 border-violet-500/50 bg-muted/50 p-2">
      {definitions.map(([name, definition]) => (
        <div key={name} className="font-mono text-[11px] leading-4">
          <span className="font-medium text-violet-700 dark:text-violet-300">
            {name}
          </span>{" "}
          <span className="whitespace-pre-wrap text-muted-foreground">
            {definition}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SnippetBlock({
  loc,
  load,
}: {
  loc: string;
  load: (loc: string) => Promise<Snippet>;
}) {
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load(loc).then((result) => {
      if (!cancelled) setSnippet(result);
    });
    return () => {
      cancelled = true;
    };
  }, [loc, load]);
  if (snippet === null)
    return <p className="pl-5 text-[11px] text-muted-foreground">Loading…</p>;
  if (snippet.error)
    return (
      <p className="pl-5 text-[11px] text-muted-foreground">{snippet.error}</p>
    );
  return (
    <pre className="mt-1 overflow-x-auto rounded border border-border bg-muted/40 p-2 text-[11px] leading-4">
      {snippet.lines.map((line, index) => {
        const lineNumber = (snippet.startLine ?? 1) + index;
        return (
          <div
            key={lineNumber}
            className={cn(
              lineNumber === snippet.targetLine && "-mx-2 bg-violet-500/10 px-2",
            )}
          >
            <span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground/50">
              {lineNumber}
            </span>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function DiffBlock({
  path,
  load,
}: {
  path: string;
  load: (
    path: string,
  ) => Promise<{ patch: string | null; error: string | null }>;
}) {
  const [state, setState] = useState<{
    patch: string | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load(path).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [path, load]);
  if (state === null)
    return (
      <p className="pl-5 text-[11px] text-muted-foreground">Loading diff…</p>
    );
  if (!state.patch)
    return (
      <p className="pl-5 text-[11px] text-muted-foreground">
        {state.error ?? "No diff available."}
      </p>
    );
  const files = parsePatchFiles(state.patch).flatMap((parsed) => parsed.files);
  if (files.length === 0)
    return (
      <p className="pl-5 text-[11px] text-muted-foreground">
        Could not parse diff.
      </p>
    );
  const root = document.documentElement;
  const dark = root.dataset.bbCodeThemeDark;
  const light = root.dataset.bbCodeThemeLight;
  return (
    <div className="mt-1 overflow-hidden rounded border border-border text-xs">
      <FileDiff
        fileDiff={files[0]}
        options={dark && light ? { theme: { dark, light } } : undefined}
      />
    </div>
  );
}
