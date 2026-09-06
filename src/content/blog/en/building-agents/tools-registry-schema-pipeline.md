---
title: 'A Tool Is Not a Function'
description: 'In a production agent, a tool is a typed contract, an execution policy, a durable result, and a replayable UI projection—not merely a callback.'
pubDate: 2026-09-08
tags: ['ai-agents', 'architecture', 'tools']
translationKey: 'agents-03-tools'
sidebarTitle: '3 · Tools'
order: 3
---

“Ask me before anything destructive” is the request that exposes a naive tool design.

If a tool is only a switch statement, approval code ends up inside `bash`, then inside `write_file`, then inside every integration that can mutate state. The policy is duplicated, and the first newly installed tool becomes the first bypass.

The safer frame is:

> A tool is a contract that enters one shared execution pipeline.

The callback is only the middle.

## The contract has more than an input schema

DeepSeek Harness gives each registered tool several distinct responsibilities:

```typescript
interface ToolDefinition {
  // Model-facing input contract
  name: string;
  description: string;
  parameters: JsonSchema;

  // Canonical machine-facing output contract
  output: {
    schema: JsonSchema;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
  };

  // The effect
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;

  // Runtime policy and presentation
  isConcurrencySafe?(args: unknown): boolean;
  timeoutMs?: number;
  finalizeContent?(exec: ToolExecution, result: ToolExecutionResult): ContentBlock[] | undefined;
  presentCall?(args: unknown): ToolCallView | undefined;
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

This is a reduced view of the real interface, but the separation is exact.

The input schema tells the model how to call the tool and validates an untrusted model payload. The output schema validates the tool's canonical JSON value. `render` turns that value into model-visible content. Presentation methods derive replayable UI intent without changing what the model receives.

That split prevents a common design mistake: returning a preformatted string and later trying to recover structured data, a diff, or a status card from prose.

## The complete execution path

The Harness pipeline is wider than “before, execute, after”:

<figure class="dg">
  <img src="/diagrams/part03-tool-pipeline.svg" alt="A tool call passes through pre-execute policy, monotonic guards, optional approval, around-execute middleware, the tool body, post-execute policy, finalization, and durable result logging." loading="lazy" />
  <figcaption><strong>One call, one governed path.</strong> Native calls, MCP calls, and calls made from model-written code re-enter the same policy boundary.</figcaption>
</figure>

1. **Resolve and validate.** Find the tool in the caller's scoped registry, snapshot the arguments, and validate their JSON shape.
2. **`tools/pre-execute`.** Waterfall listeners may allow, deny, or request approval. Missing or unanswerable approval support turns `ask` into denial.
3. **Monotonic guards.** Registered guards can only make the decision stricter. They cannot use a later listener to turn a denial back into permission.
4. **`tools/execute`.** Around-dispatch middleware supplies deadlines, retry, and measurement while preserving the original caller's cancellation signal.
5. **Tool body.** The accepted call returns a canonical JSON value. Throws are normalized into failed results.
6. **`tools/post-execute`.** Listeners may accept, replace, enrich, or block the normalized result.
7. **Output validation and rendering.** Successful values are checked against the declared output schema and projected into content blocks.
8. **`finalizeContent`.** The owning tool gets one last content-only transform; registry-owned identity and failure fields cannot be rewritten.
9. **`tools/result`.** A frozen, lossless snapshot is emitted for observers, then the agent loop appends one durable `tool/result`.

The placement of policy is the point. Approval does not belong in the shell implementation, because the same shell can be called natively, through model-written code, or from another consumer. It belongs where every invocation converges.

## Denial is still a result

When policy refuses a call, the model needs an explicit observation:

```typescript
{
  content: [{ type: 'text', text: 'The user declined this operation.' }],
  isError: true,
  error: { code: 'APPROVAL_DENIED' }
}
```

Silently dropping the call leaves the conversation structurally incomplete: the assistant emitted a tool-call id, but no matching result exists. Throwing the denial out of the loop is not much better; the model cannot choose a safer route.

A denied effect should not happen, but the fact of denial must remain visible and durable.

## Scheduling is a policy too

When one assistant message contains several calls, the runtime must decide which may overlap.

DeepSeek Harness uses two execution modes:

- **`parallel`**: the tool explicitly returns `true` from `isConcurrencySafe(args)`;
- **`exclusive`**: the default for omitted, throwing, or false classifiers.

<figure class="dg">
  <img src="/diagrams/part03-barrier-scheduler.svg" alt="Parallel-safe calls overlap in a bounded pool; exclusive calls wait for the pool and run alone as ordering barriers." loading="lazy" />
  <figcaption><strong>Parallel is opt-in; exclusive is the safe default.</strong> Dispatch may overlap, but durable results still commit in the model's original order.</figcaption>
</figure>

Three details make this more than `Promise.all`:

**Bounded pool.** At most `maxParallelToolCalls` parallel bodies run at once. A model cannot create unbounded local fan-out with one response.

**Live reclassification.** A later call is classified again immediately before it starts. Registry or policy changes made by an earlier ordered commit can therefore turn a not-yet-started call into an exclusive barrier.

**Ordered commit.** Execution may settle out of order, but post-processing, durable `tool/result` events, and added context commit in model order. Determinism is preserved without giving up safe overlap.

Cancellation stops replenishing the pool, drains work that already started, and writes synthetic error results for calls that never dispatched. That last step keeps replay structurally valid: every assistant tool call still has a result.

## Schema and UI must share the same source

The pending UI card is derived from the arguments stored with `tool/call`. The completed card is derived from those arguments plus the durable result and optional presentation metadata. Neither path should depend on live mutable tool state, because a replay hours later must render the same meaning.

This is why “just return Markdown” ages badly. Model content, canonical machine data, and human presentation are three projections with different consumers.

## Next

**Part 4 — The Inbox.** Once tool execution can take time, the agent needs a precise place for follow-ups, steering, and passive context that arrive while it is working.
