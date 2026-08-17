---
name: call-stack-driven-development
description: Work call-stack-first — frame code understanding and changes as types moving through call stacks, and publish flow diagrams to the thread's Call Stacks panel with callstack_publish. Use when tracing code paths, planning a change in an existing codebase, or whenever the user asks about what calls what, conditions, loops, or how types move through the system.
---

# Call-stack-driven development

The user works at the level of the call stack, not the syntax: what calls
what, under which conditions, in which loops, and which types move through
each edge. Types moving through a call stack ARE the program's shape. Your job
is to keep a shared, visible picture of that shape in the thread's Call
Stacks panel, and to frame plans and changes against it.

## The loop

1. **Trace before you plan.** When a task touches existing code, read the code
   and reconstruct the CURRENT call stack for the relevant path(s):
   entry point → callees, with the conditions, loops, and in/out types on each
   frame. Publish it with `callstack_publish` (`status: "current"`).
2. **Plan as a call stack.** Express the change as a PROPOSED flow: republish
   with `status: "proposed"` and mark each frame's `change` —
   `added`, `modified`, `removed`, or omit for unchanged. Additive change,
   edit, or removal should be legible at a glance.
3. **Discuss against the picture.** When the user pushes back or the plan
   shifts, update the flow first, then the prose. The panel is the contract;
   keep it truthful.
4. **After implementing, reconcile.** Republish the flow to match what the
   code actually does now (drop stale `change` markers or republish as
   `current`). Archive superseded flows with `callstack_archive` — never let
   a flow that no longer matches reality sit unarchived in the panel.

The panel tracks drift automatically: publishing snapshots a content hash of
every file named in a `loc`, and frames whose files changed since publish get
a "drifted" marker. A drifted flow is a prompt to re-verify and republish (or
archive) it. Accurate `loc` paths (workspace-relative) are what make drift
tracking, code snippets, and diff previews work — always include them.

## Publishing flows

`callstack_publish` takes one flow:
`{ name, description?, status?, frames, types? }`. Frames nest via `calls`.
Republishing the same `name` replaces the flow (and reactivates it if
archived). `callstack_archive` moves a superseded flow to the panel's History
section, preserving the before/after trail — prefer it over
`callstack_delete`, which erases the flow entirely.

`types` maps type names to their definitions, e.g.
`{ "OrderDraft": "{ items: LineItem[]; couponCode?: string }" }`. Include an
entry for every type the change touches; the panel makes any in/out chip that
mentions a defined name expandable on click. Keep definitions to the fields
that matter for this flow, not the full declaration.

Field guidance:

- `fn` — qualified name the user can grep for (`OrderService.submit`).
- `loc` — `path/to/file.ts:142`; include it whenever known.
- `in` / `out` — the types crossing this edge (`OrderDraft` → `Promise<Order>`).
  These matter more than anything else; never omit them when known.
- `cond` — the condition guarding the call (`order.total > limit`). Put it on
  the frame that is conditionally CALLED.
- `loop` — loop context (`for each line item`).
- `change` — only on proposed/edited flows.
- `note` — one short sentence max; prefer structure over prose.
- `detail` — longer prose for frames that need it: invariants, rationale,
  edge cases, links to related code. Hidden behind a ⓘ toggle in the panel,
  so it never clutters the diagram — use it freely where a note is not
  enough, instead of bloating `note`.

## Representing reality correctly

The flow document has primitives whose consistency IS the correctness of the
picture — use them deliberately:

- **`fn` is identity.** Use the exact same `fn` string for the same function
  everywhere — across frames and across flows. The panel marks frames shared
  by multiple flows with a ⇄ badge; that convergence signal only works when
  names match character-for-character. Qualified, greppable names
  (`OrderService.submit`) are both.
- **`module` is the swimlane.** Set it to the logical subsystem ("orders",
  "billing") when the directory name would mislead; otherwise omit it and the
  panel derives the lane from the loc's containing directory. Use the same
  module string across flows for the same subsystem.
- **Reality vs proposal.** `status: "current"` + no change markers = the code
  as it is (verify by reading it, not from memory). `status: "proposed"` +
  per-frame `change` markers = the delta. Never mix: a "current" flow with
  change markers is a contradiction.
- **Take publish warnings seriously.** The publish result lints the flow
  against the workspace: unreadable `loc` paths (wrong or non-relative paths)
  and defined-but-unreferenced types come back as warnings. Fix and republish
  immediately — a wrong `loc` silently disables drift tracking and code
  preview for that frame.

## Granularity

- One flow per meaningful path; use multiple flows when work spans distinct
  paths (e.g. `checkout: submit`, `checkout: webhook`). They may share frames —
  that is fine and shows where paths converge.
- 3–5 levels deep is usually right. Elide plumbing (logging, metrics, trivial
  delegation) and frames the change never touches. Depth on the interesting
  branch, not uniform depth.
- Peripheries: the top frame is usually the input side (HTTP handler, CLI,
  event); the leaves or `out` types end at persistence or user-facing output.
  Make both ends visible so the user can follow data in → data out.

## Example

```json
{
  "name": "checkout: submit",
  "status": "proposed",
  "description": "Add fraud check before payment capture.",
  "types": {
    "OrderDraft": "{ items: LineItem[]; total: Money; couponCode?: string }",
    "FraudVerdict": "\"pass\" | \"review\" | \"block\""
  },
  "frames": [
    {
      "fn": "POST /api/checkout",
      "loc": "src/routes/checkout.ts:18",
      "in": "CheckoutRequest",
      "out": "201 OrderResponse",
      "calls": [
        {
          "fn": "OrderService.submit",
          "loc": "src/orders/service.ts:142",
          "in": "OrderDraft",
          "out": "Promise<Order>",
          "calls": [
            {
              "fn": "FraudCheck.evaluate",
              "loc": "src/fraud/check.ts (new)",
              "in": "OrderDraft",
              "out": "FraudVerdict",
              "change": "added",
              "cond": "order.total > 500"
            },
            {
              "fn": "PaymentGateway.capture",
              "loc": "src/payments/gateway.ts:77",
              "in": "PaymentIntent",
              "out": "Promise<CaptureResult>",
              "change": "modified",
              "note": "now receives FraudVerdict to pick 3DS flow"
            }
          ]
        }
      ]
    }
  ]
}
```
