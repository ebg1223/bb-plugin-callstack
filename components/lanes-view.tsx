// Lanes view: the flow as a sequence diagram. Columns are modules (swimlane
// bands), time runs down in depth-first execution order, and every call is an
// arrow — so a call that crosses columns IS data moving between modules.
import { useMemo, useState } from "react";
import {
  frameLane,
  locFilePath,
  type Frame,
  type StoredFlow,
} from "../flow-schema";
import { cn } from "@/lib/utils";
import {
  laneColor,
  frameChange,
  onTracePath,
  type Change,
  type FlowCallbacks,
} from "./frame-shared";
import { DetailPane } from "./diagram-view";

const COL_W = 158;
const NODE_W = 142;
const NODE_H = 30;
const ROW_H = 42;
const HEADER_H = 24;

const OTHER_LANE = "(other)";

interface Row {
  frame: Frame;
  row: number;
  laneIndex: number;
  parent: Row | null;
}

const borderByChange: Record<Change, string> = {
  added: "border-emerald-500",
  removed: "border-red-500 border-dashed",
  modified: "border-amber-500",
};

export function LanesView({
  flow,
  lanes,
  trace,
  onTrace,
  callbacks,
}: {
  flow: StoredFlow;
  lanes: string[];
  trace: string | null;
  onTrace: (trace: string | null) => void;
  callbacks: FlowCallbacks;
}) {
  const { rows, columns } = useMemo(() => {
    const hasOther = (function findUnlaned(frames: Frame[]): boolean {
      return frames.some(
        (frame) => frameLane(frame) === null || findUnlaned(frame.calls ?? []),
      );
    })(flow.frames);
    const columns = hasOther ? [...lanes, OTHER_LANE] : [...lanes];
    const rows: Row[] = [];
    const walk = (frame: Frame, parent: Row | null) => {
      const lane = frameLane(frame) ?? OTHER_LANE;
      const row: Row = {
        frame,
        row: rows.length,
        laneIndex: Math.max(0, columns.indexOf(lane)),
        parent,
      };
      rows.push(row);
      frame.calls?.forEach((kid) => walk(kid, row));
    };
    flow.frames.forEach((frame) => walk(frame, null));
    return { rows, columns };
  }, [flow.frames, lanes]);

  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const selected = rows.find((row) => row.row === selectedRow) ?? null;

  const width = columns.length * COL_W;
  const height = HEADER_H + rows.length * ROW_H;
  const nodeX = (row: Row) => row.laneIndex * COL_W + (COL_W - NODE_W) / 2;
  const nodeY = (row: Row) => HEADER_H + row.row * ROW_H;

  return (
    <div>
      <div className="overflow-auto rounded-md border border-border/60 bg-muted/20 p-2">
        <div style={{ width, height, position: "relative" }}>
          {columns.map((lane, index) => (
            <div
              key={lane}
              className={cn(
                "absolute rounded",
                index % 2 === 0 ? "bg-muted/40" : "bg-muted/15",
              )}
              style={{ left: index * COL_W + 2, top: 0, width: COL_W - 4, height }}
            >
              <p className="flex items-center justify-center gap-1 pt-1 text-[10px] font-medium text-muted-foreground">
                {lane !== OTHER_LANE && (
                  <span
                    className={cn(
                      "h-2 w-2 rounded-sm",
                      laneColor(lane, columns),
                    )}
                  />
                )}
                {lane}
              </p>
            </div>
          ))}
          <svg
            width={width}
            height={height}
            className="pointer-events-none absolute inset-0"
          >
            {rows
              .filter((row) => row.parent !== null)
              .map((row) => {
                const parent = row.parent!;
                const x1 = nodeX(parent) + NODE_W / 2;
                const y1 = nodeY(parent) + NODE_H;
                const x2 = nodeX(row) + NODE_W / 2;
                const y2 = nodeY(row) + NODE_H / 2;
                const sameLane = row.laneIndex === parent.laneIndex;
                return (
                  <path
                    key={row.row}
                    d={
                      sameLane
                        ? `M ${x1} ${y1} L ${x2} ${y2 - NODE_H / 2}`
                        : `M ${x1} ${y1} C ${x1} ${y2}, ${(x1 + x2) / 2} ${y2}, ${x2 + (x2 > x1 ? -NODE_W / 2 : NODE_W / 2)} ${y2}`
                    }
                    fill="none"
                    className={cn(
                      "stroke-border",
                      frameChange(row.frame) === "added" &&
                        "stroke-emerald-500/60",
                      frameChange(row.frame) === "removed" && "stroke-red-500/60",
                    )}
                    strokeWidth={1.5}
                    strokeDasharray={row.frame.cond ? "5 3" : undefined}
                  />
                );
              })}
          </svg>
          {rows.map((row) => {
            const change = frameChange(row.frame);
            const traced = trace !== null && onTracePath(row.frame, trace);
            const dimmed = trace !== null && !traced;
            const filePath = locFilePath(row.frame.loc);
            const drifted =
              filePath !== null && flow.driftedPaths.includes(filePath);
            return (
              <button
                key={row.row}
                type="button"
                onClick={() =>
                  setSelectedRow((current) =>
                    current === row.row ? null : row.row,
                  )
                }
                title={row.frame.fn}
                className={cn(
                  "absolute flex items-center justify-center gap-1 rounded-md border bg-background px-1.5 shadow-xs",
                  change ? borderByChange[change] : "border-border",
                  selectedRow === row.row && "ring-2 ring-primary/60",
                  traced && "ring-2 ring-violet-500/60",
                  dimmed && "opacity-40",
                  "hover:shadow-sm",
                )}
                style={{
                  left: nodeX(row),
                  top: nodeY(row),
                  width: NODE_W,
                  height: NODE_H,
                }}
              >
                <span
                  className={cn(
                    "truncate font-mono text-[10px] font-medium text-foreground",
                    change === "removed" && "line-through decoration-1",
                  )}
                >
                  {row.frame.fn}
                </span>
                {row.frame.loop && (
                  <span className="text-[9px] text-sky-700 dark:text-sky-400">
                    ↻
                  </span>
                )}
                {drifted && (
                  <span className="text-[9px] text-amber-700 dark:text-amber-400">
                    ⚠
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {selected ? (
        <DetailPane
          key={selected.row}
          frame={selected.frame}
          flow={flow}
          trace={trace}
          onTrace={onTrace}
          callbacks={callbacks}
        />
      ) : (
        <p className="pt-1.5 text-center text-[11px] text-muted-foreground">
          Columns are modules; execution runs down. Arrows crossing columns
          are calls between modules. Click a call to inspect it.
        </p>
      )}
    </div>
  );
}
