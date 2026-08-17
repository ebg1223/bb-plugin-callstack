// bb-plugin-callstack frontend — the Call Stacks thread panel.
// Shows the flows the agent published for this thread; refreshes live when
// the backend signals a change.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { collectFns, type StoredFlow } from "./flow-schema";
import {
  FlowLegend,
  FlowView,
  type FlowCallbacks,
} from "./components/flow-view";

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function CallStacksPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [flows, setFlows] = useState<StoredFlow[] | null>(null);
  const now = useMinuteClock();

  const refresh = useCallback(() => {
    void rpc
      .call("listFlows", { threadId })
      .then((result) => setFlows(result.flows));
  }, [rpc, threadId]);

  useEffect(refresh, [refresh]);
  useRealtime(`flows:${threadId}`, refresh);

  // fn → active flow names containing it; entries with 2+ flows drive the
  // convergence (⇄) badges.
  const sharedFns = useMemo(() => {
    const byFn: Record<string, string[]> = {};
    for (const flow of flows ?? []) {
      if (flow.archived) continue;
      for (const fn of collectFns(flow.frames)) (byFn[fn] ??= []).push(flow.name);
    }
    return Object.fromEntries(
      Object.entries(byFn).filter(([, names]) => names.length > 1),
    );
  }, [flows]);

  const callbacks: FlowCallbacks = useMemo(
    () => ({
      onSetArchived: (name, archived) => {
        void rpc
          .call("setArchived", { threadId, name, archived })
          .then(refresh);
      },
      loadSnippet: (loc) => rpc.call("snippet", { threadId, loc }),
      loadDiff: (path) => rpc.call("diffHunk", { threadId, path }),
    }),
    [rpc, threadId, refresh],
  );

  if (flows === null)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (flows.length === 0)
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>No call stacks published for this thread yet.</p>
        <p>
          Ask the agent to trace a code path — the
          call-stack-driven-development skill has it publish flows here via
          the callstack_publish tool.
        </p>
      </div>
    );

  const active = flows.filter((flow) => !flow.archived);
  const archived = flows.filter((flow) => flow.archived);
  return (
    <div className="space-y-3">
      {active.map((flow) => (
        <FlowView
          key={flow.name}
          flow={flow}
          now={now}
          sharedFns={sharedFns}
          callbacks={callbacks}
        />
      ))}
      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            History ({archived.length})
          </summary>
          <div className="space-y-3 pt-2">
            {archived.map((flow) => (
              <FlowView
                key={flow.name}
                flow={flow}
                now={now}
                callbacks={callbacks}
              />
            ))}
          </div>
        </details>
      )}
      <FlowLegend />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "callstacks",
    title: "Call stacks",
    icon: "Layers",
    component: CallStacksPanel,
  });
});
