import { expect, test } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  collectChanges,
  collectFilePaths,
  collectFns,
  collectLanes,
  countDescendants,
  frameLane,
  locFilePath,
  locLine,
} from "./flow-schema";

test("subtree summaries", () => {
  const tree = {
    fn: "root",
    calls: [
      { fn: "a", change: "added" as const },
      { fn: "b", calls: [{ fn: "c", change: "removed" as const }] },
    ],
  };
  expect(countDescendants(tree)).toBe(3);
  expect(collectChanges(tree.calls)).toEqual(["added", "removed"]);
  expect(collectChanges([{ fn: "x", change: "same" as const }])).toEqual([]);
});

test("lanes and fn collection", () => {
  expect(frameLane({ fn: "a", module: "billing", loc: "src/x/y.ts:1" })).toBe(
    "billing",
  );
  expect(frameLane({ fn: "a", loc: "src/orders/service.ts:1" })).toBe("orders");
  expect(frameLane({ fn: "a", loc: "top.ts:1" })).toBe(null);
  expect(frameLane({ fn: "a" })).toBe(null);
  expect(
    collectLanes([
      { fn: "a", loc: "src/orders/a.ts", calls: [{ fn: "b", module: "pay" }] },
      { fn: "c", loc: "src/orders/c.ts" },
    ]),
  ).toEqual(["orders", "pay"]);
  expect(
    collectFns([{ fn: "a", calls: [{ fn: "b" }, { fn: "a" }] }]),
  ).toEqual(["a", "b"]);
});

test("loc parsing", () => {
  expect(locFilePath("src/a.ts:12")).toBe("src/a.ts");
  expect(locFilePath("src/fraud/check.ts (new)")).toBe("src/fraud/check.ts");
  expect(locFilePath("HTTP handler")).toBe(null);
  expect(locFilePath("/etc/passwd.txt:1")).toBe(null);
  expect(locFilePath("../../secrets/key.pem:1")).toBe(null);
  expect(locFilePath("src/../../key.pem:1")).toBe(null);
  expect(locFilePath("C:/windows/system.ini:1")).toBe(null);
  expect(locLine("src/a.ts:12")).toBe(12);
  expect(locLine("src/a.ts")).toBe(null);
  expect(
    collectFilePaths([
      { fn: "a", loc: "src/a.ts:1", calls: [{ fn: "b", loc: "src/b.ts:2" }] },
      { fn: "c", loc: "src/a.ts:9" },
    ]),
  ).toEqual(["src/a.ts", "src/b.ts"]);
});

test("publish → list → cli round trip", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "callstack" });
  await plugin(bb);

  const out = await harness.behavior.callAgentTool(
    "callstack_publish",
    {
      name: "checkout: submit",
      status: "proposed",
      types: { OrderDraft: "{ items: LineItem[] }" },
      frames: [
        {
          fn: "POST /api/checkout",
          in: "CheckoutRequest",
          calls: [
            { fn: "OrderService.submit", change: "modified", cond: "total > 0" },
          ],
        },
      ],
    },
    { threadId: "th_1" },
  );
  expect(JSON.stringify(out)).toContain("Published flow");

  const rpc = await harness.behavior.callRpc("listFlows", { threadId: "th_1" });
  expect(rpc.flows).toHaveLength(1);
  expect(rpc.flows[0].frames[0].calls[0].fn).toBe("OrderService.submit");
  expect(rpc.flows[0].types.OrderDraft).toBe("{ items: LineItem[] }");
  expect(rpc.flows[0].archived).toBe(false);

  const cli = await harness.behavior.runCli(["list", "--thread", "th_1"]);
  expect(cli.exitCode).toBe(0);
  expect(cli.stdout).toContain("checkout: submit [proposed]");

  // Archive via tool, restore via rpc, republish reactivates.
  await harness.behavior.callAgentTool(
    "callstack_archive",
    { name: "checkout: submit", archived: true },
    { threadId: "th_1" },
  );
  let flows = (
    await harness.behavior.callRpc("listFlows", { threadId: "th_1" })
  ).flows;
  expect(flows[0].archived).toBe(true);
  const archivedCli = await harness.behavior.runCli([
    "list",
    "--thread",
    "th_1",
  ]);
  expect(archivedCli.stdout).toContain("[archived]");

  await harness.behavior.callRpc("setArchived", {
    threadId: "th_1",
    name: "checkout: submit",
    archived: false,
  });
  flows = (await harness.behavior.callRpc("listFlows", { threadId: "th_1" }))
    .flows;
  expect(flows[0].archived).toBe(false);

  await harness.behavior.callAgentTool(
    "callstack_archive",
    { name: "checkout: submit" },
    { threadId: "th_1" },
  );
  await harness.behavior.callAgentTool(
    "callstack_publish",
    { name: "checkout: submit", frames: [{ fn: "POST /api/checkout" }] },
    { threadId: "th_1" },
  );
  flows = (await harness.behavior.callRpc("listFlows", { threadId: "th_1" }))
    .flows;
  expect(flows[0].archived).toBe(false);

  const del = await harness.behavior.callAgentTool(
    "callstack_delete",
    { name: "checkout: submit" },
    { threadId: "th_1" },
  );
  expect(JSON.stringify(del)).toContain("Deleted");
  const after = await harness.behavior.callRpc("listFlows", { threadId: "th_1" });
  expect(after.flows).toHaveLength(0);

  // Snippet rpc degrades cleanly when the thread has no workspace.
  harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "th_1", environmentId: null }),
  );
  const snippet = await harness.behavior.callRpc("snippet", {
    threadId: "th_1",
    loc: "src/x.ts:5",
  });
  expect(snippet.error).toBe("Thread has no workspace.");

  // Publish lints: no workspace (env is null) + a type nothing references.
  const linted = await harness.behavior.callAgentTool(
    "callstack_publish",
    {
      name: "lint demo",
      types: { Unused: "{ a: 1 }" },
      frames: [{ fn: "handler", loc: "src/x.ts:5", in: "Request" }],
    },
    { threadId: "th_1" },
  );
  const message = JSON.stringify(linted);
  expect(message).toContain("no workspace resolved");
  expect(message).toContain("never referenced");
  expect(message).toContain("Unused");

  // Lone-concurrent lint: mis-nested group members get flagged.
  const misNested = await harness.behavior.callAgentTool(
    "callstack_publish",
    {
      name: "concurrency lint",
      frames: [
        {
          fn: "handler",
          calls: [
            { fn: "months", calls: [{ fn: "derive", concurrent: true }] },
            { fn: "derive2", concurrent: true },
          ],
        },
      ],
    },
    { threadId: "th_1" },
  );
  const misNestedText = JSON.stringify(misNested);
  expect(misNestedText).toContain("no adjacent concurrent sibling");
  expect(misNestedText).toContain("derive");
  expect(misNestedText).toContain("derive2");

  // A proper adjacent pair does not warn.
  const paired = await harness.behavior.callAgentTool(
    "callstack_publish",
    {
      name: "concurrency ok",
      frames: [
        {
          fn: "handler",
          calls: [
            { fn: "a", concurrent: true },
            { fn: "b", concurrent: true },
          ],
        },
      ],
    },
    { threadId: "th_1" },
  );
  expect(JSON.stringify(paired)).not.toContain("no adjacent concurrent sibling");
});

test("reality lints: fn existence, stale lines, status, near-miss names", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "callstack" });
  await plugin(bb);
  harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "th_2", environmentId: "env_1" }),
  );
  harness.sdk.stub("environments.get", async () => ({
    id: "env_1",
    hostId: "host_1",
    path: "/ws",
  }));
  harness.sdk.stub("files.read", async () => ({
    content: "function alpha() { return 1; }\n",
    contentEncoding: "utf8",
    sha256: "abc",
  }));

  const result = await harness.behavior.callAgentTool(
    "callstack_publish",
    {
      name: "flow one",
      status: "current",
      frames: [
        { fn: "beta", loc: "src/a.ts:99", change: "added" },
        { fn: "alpha", loc: "src/a.ts:1" },
      ],
    },
    { threadId: "th_2" },
  );
  const text = JSON.stringify(result);
  expect(text).toContain("fn not found in its loc file");
  expect(text).toContain("beta");
  expect(text).toContain("past the end of the file");
  expect(text).toContain('status \\"current\\" but change markers');
  expect(text).toContain("Thread state: 1 active flow(s)");

  // proposed with no markers warns; near-miss fn names across flows warn.
  const second = await harness.behavior.callAgentTool(
    "callstack_publish",
    {
      name: "flow two",
      status: "proposed",
      frames: [{ fn: "Alpha", loc: "src/a.ts:1" }],
    },
    { threadId: "th_2" },
  );
  const secondText = JSON.stringify(second);
  expect(secondText).toContain('status \\"proposed\\" but no frame');
  expect(secondText).toContain("nearly match");
  expect(secondText).toContain("Thread state: 2 active flow(s)");
});

test("auto-archive lifecycle", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "callstack" });
  await plugin(bb);

  await harness.behavior.callAgentTool(
    "callstack_publish",
    { name: "old flow", frames: [{ fn: "a" }] },
    { threadId: "th_9" },
  );

  // thread.archived archives its flows.
  await harness.behavior.emitThreadEvent("thread.archived", {
    thread: makeThreadResponse({ id: "th_9" }),
  });
  let flows = (await harness.behavior.callRpc("listFlows", { threadId: "th_9" }))
    .flows;
  expect(flows[0].archived).toBe(true);

  // Republish reactivates; the daily sweep archives once past the cutoff.
  await harness.behavior.callAgentTool(
    "callstack_publish",
    { name: "old flow", frames: [{ fn: "a" }] },
    { threadId: "th_9" },
  );
  const db = bb.storage.database();
  db.prepare(`UPDATE flows SET updated_at = ? WHERE thread_id = 'th_9'`).run(
    Date.now() - 15 * 24 * 60 * 60 * 1000,
  );
  await harness.behavior.runSchedule("auto-archive");
  flows = (await harness.behavior.callRpc("listFlows", { threadId: "th_9" }))
    .flows;
  expect(flows[0].archived).toBe(true);

  // thread.deleted removes the rows entirely.
  await harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "th_9" }),
  });
  flows = (await harness.behavior.callRpc("listFlows", { threadId: "th_9" }))
    .flows;
  expect(flows).toHaveLength(0);

  // "off" disables the sweep.
  await harness.behavior.setSettings({ autoArchiveDays: "off" });
  await harness.behavior.callAgentTool(
    "callstack_publish",
    { name: "kept", frames: [{ fn: "b" }] },
    { threadId: "th_9" },
  );
  db.prepare(`UPDATE flows SET updated_at = ? WHERE thread_id = 'th_9'`).run(
    Date.now() - 99 * 24 * 60 * 60 * 1000,
  );
  await harness.behavior.runSchedule("auto-archive");
  flows = (await harness.behavior.callRpc("listFlows", { threadId: "th_9" }))
    .flows;
  expect(flows[0].archived).toBe(false);
});
