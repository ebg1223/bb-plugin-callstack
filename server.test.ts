import { expect, test } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  collectFilePaths,
  collectFns,
  collectLanes,
  frameLane,
  locFilePath,
  locLine,
} from "./flow-schema";

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
});
