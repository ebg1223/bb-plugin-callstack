// bb-plugin-callstack — call-stack-driven development.
//
// The agent publishes "flow" documents (call stacks with types moving through
// them) via the callstack_publish tool; the thread panel renders them. Flows
// are keyed (threadId, name): one chat owns its own set of call stacks.
//
// Drift tracking: at publish time we snapshot a content hash per file named in
// frame locs. When the thread goes idle (the agent just finished a turn — the
// moment code may have changed) we re-hash and mark files whose content
// changed, so stale frames are flagged in the panel automatically.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  collectFilePaths,
  flowSchema,
  locFilePath,
  locLine,
  storedFlowSchema,
  type StoredFlow,
} from "./flow-schema";

export const rpcContract = defineRpcContract({
  listFlows: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ flows: z.array(storedFlowSchema) }),
  },
  setArchived: {
    input: z
      .object({
        threadId: z.string(),
        name: z.string(),
        archived: z.boolean(),
      })
      .strict(),
    output: z.object({ found: z.boolean() }),
  },
  snippet: {
    input: z.object({ threadId: z.string(), loc: z.string() }).strict(),
    output: z.object({
      path: z.string().nullable(),
      startLine: z.number().nullable(),
      targetLine: z.number().nullable(),
      lines: z.array(z.string()),
      error: z.string().nullable(),
    }),
  },
  diffHunk: {
    input: z.object({ threadId: z.string(), path: z.string() }).strict(),
    output: z.object({
      patch: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
});

const channel = (threadId: string) => `flows:${threadId}`;

const SNIPPET_CONTEXT_LINES = 8;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS flows (
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, name)
    )`,
    `ALTER TABLE flows ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE flows ADD COLUMN file_hashes TEXT`,
    `ALTER TABLE flows ADD COLUMN drifted TEXT`,
  ]);

  const listFlows = (threadId: string): StoredFlow[] =>
    (
      db
        .prepare(
          `SELECT data, updated_at, archived, drifted FROM flows WHERE thread_id = ? ORDER BY updated_at`,
        )
        .all(threadId) as {
        data: string;
        updated_at: number;
        archived: number;
        drifted: string | null;
      }[]
    ).map((row) => ({
      ...JSON.parse(row.data),
      updatedAt: row.updated_at,
      archived: row.archived === 1,
      driftedPaths: row.drifted ? JSON.parse(row.drifted) : [],
    }));

  const setArchived = (threadId: string, name: string, archived: boolean) => {
    const result = db
      .prepare(`UPDATE flows SET archived = ? WHERE thread_id = ? AND name = ?`)
      .run(archived ? 1 : 0, threadId, name);
    bb.realtime.publish(channel(threadId), { threadId });
    return result.changes > 0;
  };

  /** Resolve the thread's workspace (host + root) for file access. */
  async function workspaceFor(
    threadId: string,
  ): Promise<{ hostId: string; root: string; environmentId: string } | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.path) return null;
    return {
      hostId: environment.hostId,
      root: environment.path,
      environmentId: environment.id,
    };
  }

  /** Content hash per relative path; null marks a file we could not read. */
  async function hashFiles(
    threadId: string,
    paths: string[],
  ): Promise<Record<string, string | null> | null> {
    if (paths.length === 0) return {};
    const workspace = await workspaceFor(threadId);
    if (!workspace) return null;
    const hashes: Record<string, string | null> = {};
    for (const path of paths) {
      try {
        const file = await bb.sdk.files.read({
          hostId: workspace.hostId,
          path: `${workspace.root}/${path}`,
          rootPath: workspace.root,
        });
        hashes[path] = file.sha256;
      } catch {
        hashes[path] = null;
      }
    }
    return hashes;
  }

  /** Re-hash a flow's files and store which paths changed since publish. */
  async function refreshDrift(threadId: string): Promise<void> {
    const rows = db
      .prepare(
        `SELECT name, file_hashes, drifted FROM flows
         WHERE thread_id = ? AND archived = 0 AND file_hashes IS NOT NULL`,
      )
      .all(threadId) as {
      name: string;
      file_hashes: string;
      drifted: string | null;
    }[];
    let changed = false;
    for (const row of rows) {
      const baseline = JSON.parse(row.file_hashes) as Record<
        string,
        string | null
      >;
      const current = await hashFiles(threadId, Object.keys(baseline));
      if (!current) continue;
      const drifted = Object.keys(baseline)
        .filter((path) => baseline[path] !== current[path])
        .sort();
      const stored = row.drifted ?? "[]";
      const next = JSON.stringify(drifted);
      if (next !== stored) {
        db.prepare(
          `UPDATE flows SET drifted = ? WHERE thread_id = ? AND name = ?`,
        ).run(next, threadId, row.name);
        changed = true;
      }
    }
    if (changed) bb.realtime.publish(channel(threadId), { threadId });
  }

  bb.events.on("thread.idle", ({ thread }) => {
    refreshDrift(thread.id).catch((error) => {
      bb.log.warn(`drift check failed for ${thread.id}: ${error}`);
    });
  });

  bb.rpc.register(rpcContract, {
    listFlows: ({ threadId }) => ({ flows: listFlows(threadId) }),
    setArchived: ({ threadId, name, archived }) => ({
      found: setArchived(threadId, name, archived),
    }),
    async snippet({ threadId, loc }) {
      const empty = { path: null, startLine: null, targetLine: null, lines: [] };
      const path = locFilePath(loc);
      if (!path) return { ...empty, error: "Location has no file path." };
      const workspace = await workspaceFor(threadId);
      if (!workspace) return { ...empty, error: "Thread has no workspace." };
      try {
        const file = await bb.sdk.files.read({
          hostId: workspace.hostId,
          path: `${workspace.root}/${path}`,
          rootPath: workspace.root,
        });
        const content =
          file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content;
        const allLines = content.split("\n");
        const targetLine = locLine(loc);
        const center = targetLine ?? 1;
        const startLine = Math.max(1, center - SNIPPET_CONTEXT_LINES);
        const endLine = Math.min(
          allLines.length,
          center + SNIPPET_CONTEXT_LINES,
        );
        return {
          path,
          startLine,
          targetLine,
          lines: allLines.slice(startLine - 1, endLine),
          error: null,
        };
      } catch {
        return { ...empty, path, error: `Could not read ${path}.` };
      }
    },
    async diffHunk({ threadId, path }) {
      if (locFilePath(path) !== path)
        return { patch: null, error: "Invalid path." };
      const workspace = await workspaceFor(threadId);
      if (!workspace) return { patch: null, error: "Thread has no workspace." };
      try {
        const environment = await bb.sdk.environments.get({
          environmentId: workspace.environmentId,
        });
        const targets: ({ type: "uncommitted" } | { type: "all"; mergeBaseBranch: string })[] =
          [{ type: "uncommitted" }];
        if (environment.mergeBaseBranch)
          targets.push({
            type: "all",
            mergeBaseBranch: environment.mergeBaseBranch,
          });
        for (const target of targets) {
          const result = await bb.sdk.environments.diffPatch({
            environmentId: workspace.environmentId,
            target,
            paths: [path],
          });
          if (result.outcome === "available") {
            const patch = result.patches.find((entry) => entry.path === path);
            if (patch && patch.patch.trim()) return { patch: patch.patch, error: null };
          }
        }
        return { patch: null, error: `No pending diff for ${path}.` };
      } catch (error) {
        return { patch: null, error: `Diff failed: ${error}` };
      }
    },
  });

  bb.agents.registerTool({
    name: "callstack_publish",
    description:
      "Publish or replace a call-stack flow diagram for this thread's Call Stacks panel. " +
      "A flow is a named call tree: each frame has fn, optional loc (file:line), " +
      "in/out types, cond (condition guarding the call), loop context, a change " +
      "marker (same|added|modified|removed) for before/after views, and nested calls. " +
      "The flow-level types map (typeName → definition) makes type pills expandable. " +
      "Republishing the same name replaces it.",
    instructions:
      "When working call-stack-first (see the call-stack-driven-development skill), " +
      "publish flows with callstack_publish after tracing code and whenever the " +
      "planned or actual call path changes, so the user's panel stays current.",
    experimental_statusLabels: {
      pending: "Publishing call stack",
      completed: "Published call stack",
    },
    parameters: flowSchema,
    async execute(flow, { threadId }) {
      if (!threadId) return "No thread context; flow not stored.";
      const paths = collectFilePaths(flow.frames);
      const hashes = await hashFiles(threadId, paths).catch(() => null);

      // Lint the flow against reality so the agent can self-correct now
      // rather than the user discovering a wrong picture later.
      const warnings: string[] = [];
      if (hashes) {
        const missing = Object.entries(hashes)
          .filter(([, sha]) => sha === null)
          .map(([path]) => path);
        if (missing.length > 0)
          warnings.push(
            `loc paths not readable in the workspace (are they workspace-relative and spelled right?): ${missing.join(", ")}`,
          );
      } else if (paths.length > 0) {
        warnings.push(
          "no workspace resolved for this thread — drift tracking and code preview are disabled for this flow.",
        );
      }
      const edgeText: string[] = [];
      const walkEdges = (frames: typeof flow.frames) => {
        for (const frame of frames) {
          if (frame.in) edgeText.push(frame.in);
          if (frame.out) edgeText.push(frame.out);
          if (frame.calls) walkEdges(frame.calls);
        }
      };
      walkEdges(flow.frames);
      const edges = edgeText.join(" ");
      const unusedTypes = Object.keys(flow.types ?? {}).filter(
        (name) => !edges.includes(name),
      );
      if (unusedTypes.length > 0)
        warnings.push(
          `types defined but never referenced by any frame's in/out: ${unusedTypes.join(", ")}`,
        );

      db.prepare(
        `INSERT INTO flows (thread_id, name, data, updated_at, archived, file_hashes, drifted)
         VALUES (?, ?, ?, ?, 0, ?, '[]')
         ON CONFLICT(thread_id, name) DO UPDATE SET
           data = excluded.data, updated_at = excluded.updated_at,
           archived = 0, file_hashes = excluded.file_hashes, drifted = '[]'`,
      ).run(
        threadId,
        flow.name,
        JSON.stringify(flow),
        Date.now(),
        hashes ? JSON.stringify(hashes) : null,
      );
      bb.realtime.publish(channel(threadId), { threadId });
      const base = `Published flow "${flow.name}". The user can view it in the Call Stacks thread panel.`;
      return warnings.length > 0
        ? `${base}\nWarnings — fix and republish if these are mistakes:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
        : base;
    },
  });

  bb.agents.registerTool({
    name: "callstack_archive",
    description:
      "Archive a call-stack flow (moves it to the panel's History section) or restore it with archived: false. " +
      "Prefer archiving over deleting once a flow is superseded, so the before/after trail is preserved. " +
      "Republishing an archived name reactivates it.",
    parameters: z.object({
      name: z.string().min(1),
      archived: z.boolean().default(true),
    }),
    async execute({ name, archived }, { threadId }) {
      if (!threadId) return "No thread context.";
      return setArchived(threadId, name, archived)
        ? `${archived ? "Archived" : "Restored"} flow "${name}".`
        : `No flow named "${name}".`;
    },
  });

  bb.agents.registerTool({
    name: "callstack_delete",
    description:
      "Delete a previously published call-stack flow from this thread's panel by name.",
    parameters: z.object({ name: z.string().min(1) }),
    async execute({ name }, { threadId }) {
      if (!threadId) return "No thread context.";
      const result = db
        .prepare(`DELETE FROM flows WHERE thread_id = ? AND name = ?`)
        .run(threadId, name);
      bb.realtime.publish(channel(threadId), { threadId });
      return result.changes > 0 ? `Deleted flow "${name}".` : `No flow named "${name}".`;
    },
  });

  bb.cli.register({
    name: "callstack",
    summary: "Inspect call-stack flows published to threads",
    commands: [
      {
        name: "list",
        summary: "List flows for a thread",
        usage: "bb callstack list [--thread <threadId>]",
      },
      {
        name: "show",
        summary: "Print one flow as JSON",
        usage: "bb callstack show <name> [--thread <threadId>]",
      },
      {
        name: "clear",
        summary: "Delete one flow, or all flows for the thread",
        usage: "bb callstack clear [<name>] [--thread <threadId>]",
      },
    ],
    async run(argv, ctx) {
      const threadFlag = argv.indexOf("--thread");
      const threadId =
        threadFlag >= 0 ? argv[threadFlag + 1] : ctx.threadId ?? undefined;
      if (!threadId)
        return {
          exitCode: 1,
          stderr: "No thread context; pass --thread <threadId>.",
        };
      const args = argv.filter(
        (a, i) => a !== "--thread" && i !== threadFlag + 1,
      );
      const [cmd, name] = args;
      if (cmd === "list") {
        const flows = listFlows(threadId);
        return {
          exitCode: 0,
          stdout:
            flows
              .map(
                (f) =>
                  `${f.name}${f.status ? ` [${f.status}]` : ""}${f.archived ? " [archived]" : ""}${f.driftedPaths.length > 0 ? ` [drifted: ${f.driftedPaths.length}]` : ""}`,
              )
              .join("\n") || "(no flows)",
        };
      }
      if (cmd === "show") {
        if (!name) return { exitCode: 1, stderr: "Usage: bb callstack show <name>" };
        const flow = listFlows(threadId).find((f) => f.name === name);
        if (!flow) return { exitCode: 1, stderr: `No flow named "${name}".` };
        return { exitCode: 0, stdout: JSON.stringify(flow, null, 2) };
      }
      if (cmd === "clear") {
        const result = name
          ? db
              .prepare(`DELETE FROM flows WHERE thread_id = ? AND name = ?`)
              .run(threadId, name)
          : db.prepare(`DELETE FROM flows WHERE thread_id = ?`).run(threadId);
        bb.realtime.publish(channel(threadId), { threadId });
        return { exitCode: 0, stdout: `Deleted ${result.changes} flow(s).` };
      }
      return {
        exitCode: 1,
        stderr: "Usage: bb callstack <list|show|clear> — see bb callstack help",
      };
    },
  });
}
