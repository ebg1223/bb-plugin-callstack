// Diagram view: the flow as a top-down flowchart instead of nested stacking.
// Shapes carry meaning:
//   - entry frames (roots) are pills, calls are rounded rects
//   - removed frames get dashed borders, change color rides the border
//   - conditions sit ON the edge as amber ◇ labels (the edge is what's guarded)
//   - loops draw a sky ↻ ring badge on the node
//   - type names travel along edges (the child's `in` type)
// Click a node to open the detail pane below: full types, note, long detail,
// code snippet, and diff. Zoom with the −/+ controls; the canvas scrolls.
import { useMemo, useState } from "react";
import {
  frameLane,
  locFilePath,
  type Frame,
  type StoredFlow,
} from "../flow-schema";
import { cn } from "@/lib/utils";
import {
  DefinitionsBlock,
  DiffBlock,
  LaneDot,
  SharedBadge,
  SnippetBlock,
  TypePill,
  changeBadge,
  changeLabel,
  definitionsFor,
  frameChange,
  onTracePath,
  type FlowCallbacks,
} from "./frame-shared";

const NODE_W = 168;
const NODE_H = 54;
const HGAP = 14;
const VGAP = 46;

interface Positioned {
  id: string;
  frame: Frame;
  depth: number;
  x: number; // left
  y: number; // top
  parent: Positioned | null;
}

/** Classic tidy-tree: subtree width = max(own, sum of children), parents centered. */
function layout(frames: Frame[]): { nodes: Positioned[]; width: number; height: number } {
  const nodes: Positioned[] = [];
  let maxDepth = 0;

  const subtreeWidth = (frame: Frame): number => {
    const kids = frame.calls ?? [];
    if (kids.length === 0) return NODE_W;
    const kidsWidth =
      kids.reduce((sum, kid) => sum + subtreeWidth(kid), 0) +
      HGAP * (kids.length - 1);
    return Math.max(NODE_W, kidsWidth);
  };

  const place = (
    frame: Frame,
    depth: number,
    left: number,
    parent: Positioned | null,
    id: string,
  ) => {
    maxDepth = Math.max(maxDepth, depth);
    const width = subtreeWidth(frame);
    const node: Positioned = {
      id,
      frame,
      depth,
      x: left + width / 2 - NODE_W / 2,
      y: depth * (NODE_H + VGAP),
      parent,
    };
    nodes.push(node);
    let cursor = left;
    (frame.calls ?? []).forEach((kid, index) => {
      const kidWidth = subtreeWidth(kid);
      place(kid, depth + 1, cursor, node, `${id}.${index}`);
      cursor += kidWidth + HGAP;
    });
  };

  let cursor = 0;
  frames.forEach((frame, index) => {
    const width = subtreeWidth(frame);
    place(frame, 0, cursor, null, `${index}`);
    cursor += width + HGAP * 2;
  });

  return {
    nodes,
    width: Math.max(cursor - HGAP * 2, NODE_W),
    height: (maxDepth + 1) * (NODE_H + VGAP) - VGAP,
  };
}

function DetailPane({
  node,
  flow,
  trace,
  onTrace,
  callbacks,
}: {
  node: Positioned;
  flow: StoredFlow;
  trace: string | null;
  onTrace: (trace: string | null) => void;
  callbacks: FlowCallbacks;
}) {
  const [expandedChip, setExpandedChip] = useState<"in" | "out" | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const frame = node.frame;
  const types = flow.types ?? {};
  const inDefs = definitionsFor(frame.in, types);
  const outDefs = definitionsFor(frame.out, types);
  const shownDefs =
    expandedChip === "in" ? inDefs : expandedChip === "out" ? outDefs : [];
  const change = frameChange(frame);
  const filePath = locFilePath(frame.loc);

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
    <div className="mt-2 rounded-md border border-border bg-background p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-[13px] font-medium text-foreground">
          {frame.fn}
        </span>
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
        <span className="ml-auto flex items-center gap-1.5">
          {frame.loc &&
            (callbacks.loadSnippet ? (
              <button
                type="button"
                onClick={() => setShowSnippet((current) => !current)}
                aria-expanded={showSnippet}
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
      {(frame.cond || frame.loop) && (
        <div className="flex flex-wrap gap-1.5 pt-1">
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
      {(frame.in || frame.out) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
          <TypePill
            role="in"
            text={frame.in ?? "()"}
            definitions={inDefs}
            expanded={expandedChip === "in"}
            traced={trace !== null && expandedChip === "in"}
            onToggle={() => toggleChip("in", frame.in)}
          />
          <span className="text-xs text-muted-foreground">→</span>
          <TypePill
            role="out"
            text={frame.out ?? "void"}
            definitions={outDefs}
            expanded={expandedChip === "out"}
            traced={trace !== null && expandedChip === "out"}
            onToggle={() => toggleChip("out", frame.out)}
          />
        </div>
      )}
      <DefinitionsBlock definitions={shownDefs} />
      {frame.note && (
        <p className="pt-1.5 text-[11px] italic text-muted-foreground">
          {frame.note}
        </p>
      )}
      {frame.detail && (
        <p className="whitespace-pre-wrap pt-1.5 text-[11px] leading-4 text-muted-foreground">
          {frame.detail}
        </p>
      )}
      {showSnippet && frame.loc && callbacks.loadSnippet && (
        <SnippetBlock loc={frame.loc} load={callbacks.loadSnippet} />
      )}
      {showDiff && filePath && callbacks.loadDiff && (
        <DiffBlock path={filePath} load={callbacks.loadDiff} />
      )}
    </div>
  );
}

const nodeBorder: Record<string, string> = {
  added: "border-emerald-500",
  removed: "border-red-500 border-dashed",
  modified: "border-amber-500",
};

export function DiagramView({
  flow,
  lanes,
  sharedFns,
  trace,
  onTrace,
  callbacks,
}: {
  flow: StoredFlow;
  lanes: string[];
  sharedFns: Record<string, string[]>;
  trace: string | null;
  onTrace: (trace: string | null) => void;
  callbacks: FlowCallbacks;
}) {
  const { nodes, width, height } = useMemo(
    () => layout(flow.frames),
    [flow.frames],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  // Full edge labels only where attention is: the hovered/selected node's
  // incoming edge, or edges carrying the traced type. Everything else
  // collapses to a small marker so the graph stays readable.
  const labelExpanded = (node: Positioned) =>
    node.id === hoveredId ||
    node.id === selectedId ||
    (trace !== null && (node.frame.in?.includes(trace) ?? false));

  return (
    <div>
      <div className="mb-1 flex justify-end gap-1">
        <button
          type="button"
          onClick={() => setZoom((current) => Math.max(0.5, current - 0.15))}
          aria-label="Zoom out"
          className="rounded border border-border px-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoom((current) => Math.min(1.2, current + 0.15))}
          aria-label="Zoom in"
          className="rounded border border-border px-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          +
        </button>
      </div>
      <div className="overflow-auto rounded-md border border-border/60 bg-muted/20 p-3">
        <div
          style={{
            width: width * zoom,
            height: height * zoom,
            position: "relative",
          }}
        >
          <div
            style={{
              width,
              height,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              position: "absolute",
            }}
          >
            <svg
              width={width}
              height={height}
              className="pointer-events-none absolute inset-0"
            >
              {nodes
                .filter((node) => node.parent !== null)
                .map((node) => {
                  const parent = node.parent!;
                  const x1 = parent.x + NODE_W / 2;
                  const y1 = parent.y + NODE_H;
                  const x2 = node.x + NODE_W / 2;
                  const y2 = node.y;
                  return (
                    <path
                      key={node.id}
                      d={`M ${x1} ${y1} C ${x1} ${y1 + VGAP / 2}, ${x2} ${y2 - VGAP / 2}, ${x2} ${y2}`}
                      fill="none"
                      className={cn(
                        "stroke-border",
                        frameChange(node.frame) === "added" &&
                          "stroke-emerald-500/60",
                        frameChange(node.frame) === "removed" &&
                          "stroke-red-500/60",
                      )}
                      strokeWidth={1.5}
                      strokeDasharray={
                        frameChange(node.frame) === "removed" ? "4 3" : undefined
                      }
                    />
                  );
                })}
            </svg>
            {/* Edge labels: markers by default, full text on hover/selection/trace. */}
            {nodes
              .filter((node) => node.parent !== null && (node.frame.in || node.frame.cond))
              .map((node) => {
                const parent = node.parent!;
                const midX = (parent.x + node.x) / 2 + NODE_W / 2;
                const midY = (parent.y + NODE_H + node.y) / 2;
                const expanded = labelExpanded(node);
                return (
                  <div
                    key={`label-${node.id}`}
                    className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5"
                    style={{ left: midX, top: midY }}
                  >
                    {node.frame.cond &&
                      (expanded ? (
                        <span className="max-w-[130px] truncate rounded bg-amber-500/15 px-1 font-mono text-[9px] text-amber-700 dark:text-amber-400">
                          ◇ {node.frame.cond}
                        </span>
                      ) : (
                        <span
                          title={`if ${node.frame.cond}`}
                          className="text-[9px] leading-none text-amber-600/80 dark:text-amber-400/80"
                        >
                          ◇
                        </span>
                      ))}
                    {node.frame.in && expanded && (
                      <span className="max-w-[130px] truncate rounded bg-violet-500/10 px-1 font-mono text-[9px] text-violet-700 dark:text-violet-300">
                        {node.frame.in}
                      </span>
                    )}
                  </div>
                );
              })}
            {nodes.map((node) => {
              const change = frameChange(node.frame);
              const traced = trace !== null && onTracePath(node.frame, trace);
              const dimmed = trace !== null && !traced;
              const drifted =
                locFilePath(node.frame.loc) !== null &&
                flow.driftedPaths.includes(locFilePath(node.frame.loc)!);
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() =>
                    setSelectedId((current) =>
                      current === node.id ? null : node.id,
                    )
                  }
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() =>
                    setHoveredId((current) =>
                      current === node.id ? null : current,
                    )
                  }
                  title={node.frame.fn}
                  className={cn(
                    "absolute flex flex-col items-center justify-center gap-0.5 border bg-background px-2 text-center shadow-xs",
                    node.depth === 0 ? "rounded-full" : "rounded-md",
                    change ? nodeBorder[change] : "border-border",
                    selectedId === node.id && "ring-2 ring-primary/60",
                    traced && "ring-2 ring-violet-500/60",
                    dimmed && "opacity-40",
                    "hover:shadow-sm",
                  )}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: NODE_W,
                    height: NODE_H,
                  }}
                >
                  <span className="flex w-full items-center justify-center gap-1">
                    <LaneDot lane={frameLane(node.frame)} lanes={lanes} />
                    <span
                      className={cn(
                        "truncate font-mono text-[11px] font-medium text-foreground",
                        change === "removed" && "line-through decoration-1",
                      )}
                    >
                      {node.frame.fn}
                    </span>
                  </span>
                  {node.frame.out &&
                    (labelExpanded(node) ||
                      (trace !== null && onTracePath(node.frame, trace))) && (
                      <span className="w-full truncate font-mono text-[9px] text-violet-700/80 dark:text-violet-300/80">
                        → {node.frame.out}
                      </span>
                    )}
                  <span className="absolute -right-1.5 -top-1.5 flex gap-0.5">
                    {node.frame.loop && (
                      <span
                        title={`loop: ${node.frame.loop}`}
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-sky-500/15 text-[9px] text-sky-700 dark:text-sky-400"
                      >
                        ↻
                      </span>
                    )}
                    {drifted && (
                      <span
                        title="File changed since publish"
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/20 text-[9px] text-amber-700 dark:text-amber-400"
                      >
                        ⚠
                      </span>
                    )}
                    {node.frame.detail && (
                      <span
                        title="Has details — click to read"
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground"
                      >
                        ⓘ
                      </span>
                    )}
                    {(sharedFns[node.frame.fn] ?? []).filter(
                      (name) => name !== flow.name,
                    ).length > 0 && (
                      <SharedBadge
                        others={(sharedFns[node.frame.fn] ?? []).filter(
                          (name) => name !== flow.name,
                        )}
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {selected ? (
        <DetailPane
          key={selected.id}
          node={selected}
          flow={flow}
          trace={trace}
          onTrace={onTrace}
          callbacks={callbacks}
        />
      ) : (
        <p className="pt-1.5 text-center text-[11px] text-muted-foreground">
          Click a node to inspect types, code, and details.
        </p>
      )}
    </div>
  );
}
