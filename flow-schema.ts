// The portable core of the plugin: the flow document format.
// A "flow" is one call stack with types moving through it — the shared
// representation the agent produces and the renderer draws. No bb imports
// here so the schema + types can be reused outside BB.
import { z } from "zod";

export type FrameChange = "same" | "added" | "modified" | "removed";

export interface Frame {
  /** Function/method name, e.g. "OrderService.submit" */
  fn: string;
  /** Source location, e.g. "src/orders/service.ts:142" */
  loc?: string;
  /** Input type(s) flowing in, e.g. "OrderDraft" */
  in?: string;
  /** Output/return type, e.g. "Promise<Order>" */
  out?: string;
  /** Condition under which this call happens, e.g. "user.isAdmin" */
  cond?: string;
  /** Loop context, e.g. "for each line item" */
  loop?: string;
  /** Diff status for before/after views; omitted = "same" */
  change?: FrameChange;
  /**
   * Sibling order is temporal order (depth-first execution). Mark consecutive
   * siblings concurrent: true when they start together (Promise.all, parallel
   * jobs) — the panel brackets them and stops implying a sequence.
   */
  concurrent?: boolean;
  /**
   * Logical module/subsystem for swimlane coloring ("orders", "billing").
   * When omitted, the panel derives it from the loc's containing directory.
   */
  module?: string;
  /** One short clarifying note */
  note?: string;
  /** Longer prose: invariants, rationale, edge cases. Shown on demand. */
  detail?: string;
  /** Callees, in call order */
  calls?: Frame[];
}

export interface Flow {
  /** Stable name; republishing the same name replaces the flow */
  name: string;
  description?: string;
  /** "current" = as the code is today; "proposed" = after the change */
  status?: "current" | "proposed";
  frames: Frame[];
  /**
   * Definitions for the types named in frames' in/out, keyed by type name
   * (e.g. "OrderDraft" → "{ items: LineItem[]; couponCode?: string }").
   * Chips in the panel expand these on click.
   */
  types?: Record<string, string>;
}

export const frameSchema: z.ZodType<Frame> = z.lazy(() =>
  z.object({
    fn: z.string().min(1).max(200),
    loc: z.string().max(300).optional(),
    in: z.string().max(300).optional(),
    out: z.string().max(300).optional(),
    cond: z.string().max(300).optional(),
    loop: z.string().max(300).optional(),
    change: z.enum(["same", "added", "modified", "removed"]).optional(),
    concurrent: z.boolean().optional(),
    module: z.string().min(1).max(60).optional(),
    note: z.string().max(500).optional(),
    detail: z.string().max(2000).optional(),
    calls: z.array(frameSchema).max(50).optional(),
  }),
);

export const flowSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  status: z.enum(["current", "proposed"]).optional(),
  frames: z.array(frameSchema).min(1).max(50),
  types: z
    .record(z.string().min(1).max(200), z.string().min(1).max(2000))
    .optional(),
});

export interface StoredFlow extends Flow {
  updatedAt: number;
  archived: boolean;
  /** Files referenced by frame locs whose content changed since publish */
  driftedPaths: string[];
}

export const storedFlowSchema = flowSchema.extend({
  updatedAt: z.number(),
  archived: z.boolean(),
  driftedPaths: z.array(z.string()),
});

/**
 * "src/orders/service.ts:142" → "src/orders/service.ts"; null if loc is not
 * path-shaped. Only workspace-relative paths pass: absolute paths, drive
 * letters, backslashes, and ".." traversal are rejected because locs come
 * from agent output and are used for file reads.
 */
export function locFilePath(loc: string | undefined): string | null {
  if (!loc) return null;
  const match = /^([^\s:]+\.[A-Za-z0-9]+)/.exec(loc);
  if (!match) return null;
  const path = match[1];
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path))
    return null;
  if (path.split("/").some((segment) => segment === "..")) return null;
  return path;
}

/** Line number from a loc like "src/file.ts:142", if present. */
export function locLine(loc: string): number | null {
  const match = /:(\d+)/.exec(loc);
  return match ? Number(match[1]) : null;
}

/** Swimlane for a frame: explicit module, else the loc's containing directory. */
export function frameLane(frame: Frame): string | null {
  if (frame.module) return frame.module;
  const path = locFilePath(frame.loc);
  if (!path) return null;
  const segments = path.split("/");
  return segments.length > 1 ? segments[segments.length - 2] : null;
}

/** Unique lanes across a frame tree, in first-appearance order. */
export function collectLanes(frames: Frame[]): string[] {
  const lanes: string[] = [];
  const walk = (frame: Frame) => {
    const lane = frameLane(frame);
    if (lane && !lanes.includes(lane)) lanes.push(lane);
    frame.calls?.forEach(walk);
  };
  frames.forEach(walk);
  return lanes;
}

/** Unique fn names across a frame tree. */
export function collectFns(frames: Frame[]): string[] {
  const fns = new Set<string>();
  const walk = (frame: Frame) => {
    fns.add(frame.fn);
    frame.calls?.forEach(walk);
  };
  frames.forEach(walk);
  return [...fns];
}

export function countDescendants(frame: Frame): number {
  return (frame.calls ?? []).reduce(
    (count, kid) => count + 1 + countDescendants(kid),
    0,
  );
}

/** Distinct non-"same" change markers anywhere in these frames' subtrees. */
export function collectChanges(frames: Frame[]): FrameChange[] {
  const found = new Set<FrameChange>();
  const walk = (frame: Frame) => {
    if (frame.change && frame.change !== "same") found.add(frame.change);
    frame.calls?.forEach(walk);
  };
  frames.forEach(walk);
  return [...found];
}

export function collectFilePaths(frames: Frame[]): string[] {
  const paths = new Set<string>();
  const walk = (frame: Frame) => {
    const path = locFilePath(frame.loc);
    if (path) paths.add(path);
    frame.calls?.forEach(walk);
  };
  frames.forEach(walk);
  return [...paths];
}
