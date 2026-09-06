---
title: 'The LLM Layer Is a Protocol Boundary'
description: 'DeepSeek SSE is provider wire data. The agent loop needs canonical blocks, stable failures, replay state, and exactly one terminal finish.'
pubDate: 2026-09-10
tags: ['ai-agents', 'llm', 'architecture']
translationKey: 'agents-05-llm-layer'
sidebarTitle: '5 · The LLM layer'
order: 5
---

For four parts, one call has stood in for the entire model subsystem:

```typescript
const response = await client.chat.completions.create(request);
```

That is enough for a demo. A harness that supports more than one adapter needs a boundary between provider wire formats and the rest of the agent.

DeepSeek Harness puts a provider-neutral `ctx.llm` service at that boundary. The loop, session log, compactor, and UI speak one canonical vocabulary; the DeepSeek adapter alone owns HTTP, SSE, wire messages, thinking fields, and provider error mapping.

## Canonical chunks, not provider events

The shared stream protocol is a tagged sequence:

```typescript
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
      type: 'tool-call-delta';
      index: number;
      id: ToolCallId;
      name?: string;
      argumentsDelta: string;
    }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```

The block index is essential because text, reasoning, and several tool calls can arrive as interleaved deltas. Tool arguments remain raw JSON strings until execution time. Parsing partial JSON inside the adapter would turn ordinary fragmentation into false syntax errors.

<figure class="dg">
  <img src="/diagrams/part05-sse-pipeline.svg" alt="DeepSeek SSE payloads are parsed into indexed text, reasoning, and tool-call deltas, then closed as canonical blocks before usage and finish." loading="lazy" />
  <figcaption><strong>The adapter translates; the loop assembles.</strong> Provider-specific fields stop at this seam.</figcaption>
</figure>

The DeepSeek translator keeps one open text block, one reasoning block, and a map of tool-call blocks keyed by the wire call index. A tool call's id and name establish identity; later empty or null fields do not erase them. Argument fragments accumulate as text.

DeepSeek may attach usage to the finish-bearing chunk or send a trailing usage-only chunk. The adapter keeps the latest usage and defers every `block-end`, then `usage`, then the terminal `finish` until the `[DONE]` sentinel. Nothing is allowed after finish.

## Exactly one terminal finish

The Harness vocabulary separates successful stop reasons from failed terminal outcomes:

| Finish kind | Meaning in the loop |
|---|---|
| `stop` | The model completed without requesting another tool round. |
| `tool-calls` | The assembled assistant message contains calls to dispatch. |
| `max-tokens` | A valid partial assistant message reached the output cap. |
| `aborted` | Caller cancellation ended the provider attempt. |
| `error` | Transport, protocol, provider, or mapped finish failure. |

<figure class="dg">
  <img src="/diagrams/part05-terminal-finishes.svg" alt="Every model attempt terminates once as stop, tool-calls, max-tokens, aborted, or error." loading="lazy" />
  <figcaption><strong>Cancellation is not a provider incident.</strong> Keeping `aborted` distinct prevents user interrupts from polluting reliability metrics and retry policy.</figcaption>
</figure>

On the DeepSeek wire, `stop`, `tool_calls`, and `length` map to `stop`, `tool-calls`, and `max-tokens`. An unknown value such as `content_filter` becomes an `error` carrying a stable uppercase code; it is not silently treated as a successful empty answer.

If the SSE source ends before `[DONE]`, or a payload is malformed, the adapter raises a typed `LlmError`. The outer LLM runtime normalizes adapter throws into the same terminal `error` or `aborted` chunk shape. Consumers therefore do not need a second exception protocol for ordinary provider failure.

## Assembly is stricter than concatenation

`BlockAssembler` enforces stream invariants while rebuilding complete content:

- deltas must refer to an open block of the matching type;
- each block closes once;
- usage precedes finish;
- finish occurs exactly once;
- nothing follows finish.

The loop logs every raw canonical chunk as `assistant/chunk`. After successful assembly it appends one `assistant/message` whose `sourceEventSeqs` cite the exact chunks that produced it.

On cancellation, the assembler can still return interrupted blocks. If visible content arrived before the abort, the loop appends an `assistant/message` marked `interrupted: true`. The next request can then contain the same prefix the user already saw instead of pretending the partial response never existed.

## Replay the meaning, not arbitrary wire bytes

“Echo the raw response verbatim” is good advice for a tiny single-provider loop, but it is not a sufficient architecture.

DeepSeek Harness stores canonical assistant blocks:

- visible text remains `text`;
- thinking remains a separate `reasoning` block;
- each call retains its id, name, and raw argument string.

The DeepSeek adapter serializes those blocks back to `content`, `reasoning_content`, and `tool_calls`. Each tool result becomes its own `role: 'tool'` wire message correlated by `tool_call_id`.

Adapters may also attach opaque `replayState` when a provider requires private continuation metadata. That state travels only when the same adapter instance owns both the historical and target route; switching adapters drops it deliberately. Canonical conversation meaning is portable, provider-private state is not assumed to be.

## Retry belongs outside the adapter

The LLM service performs one provider attempt. It records a stable failure code such as `RATE_LIMIT`, `AUTH`, or `CONTEXT_WINDOW_EXCEEDED`, but it does not automatically replay the request.

Retry execution belongs at the agent's durable failed-step boundary. A retry plugin can combine the adapter's policy with session state, cancellation, and context-overflow recovery. Hiding retries inside HTTP code would make usage, timing, and partial-output semantics invisible to the loop.

## Request preparation is part of the seam

Before dispatch, `prepareCall()` resolves the exact adapter generation and model metadata, validates reasoning effort and modalities, materializes adapter-owned defaults, and deep-freezes the request. The same captured adapter performs terminal dispatch.

That atomicity matters during hot reload. Without it, model capability could be resolved from one configuration generation while the HTTP request uses another.

## Next

**Part 6 — MCP: Tools From a Process You Do Not Control.** Provider normalization solves model diversity; the next boundary is dynamically discovered tools owned by another process.
