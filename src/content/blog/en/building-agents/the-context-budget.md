---
title: 'The Context Budget'
description: 'One grep returned 200KB and killed the conversation. Context is spent by tool results, not by the model — so manage it where results are produced.'
pubDate: 2026-09-15
tags: ['ai-agents', 'llm', 'performance']
translationKey: 'agents-10-context-budget'
sidebarTitle: '10 · Context budget'
order: 10
---

```text
> grep -rn "id" src/
[204,881 bytes]
```

That is the whole incident. One command, one result, and a conversation that had been going fine for twenty minutes is now three turns from the ceiling. The agent has learned nothing useful and can no longer afford to learn anything else.

On a real session, tool results are 60–85% of the tokens. The model's own output is 5–15%; user input is under 5%.

> **Context is consumed by tool results, not by the model's words.** Manage it where results are produced, not where the window runs out.

Everyone's first instinct is summarisation. It is the *last* lever, and the only one that loses information you cannot get back.

<figure class="dg">
  <img src="/diagrams/part10-context-budget.svg" alt="Four levers in order: cap, spill, prune and only then summarise, which is the only one that destroys information." loading="lazy" />
<figcaption><strong>Summarising is the last lever, not the first.</strong> Three cheaper ones come before it, and two of them lose nothing at all.</figcaption>
</figure>

## Lever one: cap at the source

The cheapest fix is a limit on the pipeline's `post` phase, applied to every tool at once — which is the payoff for having built [a pipeline](/en/blog/building-agents/tools-registry-schema-pipeline/) in Part 3.

```typescript
const MAX_RESULT_BYTES = 20_000;

registry.addPostHook(async (tool, result) => {
  if (result.length <= MAX_RESULT_BYTES) return result;
  const head = result.slice(0, MAX_RESULT_BYTES);
  const dropped = result.length - MAX_RESULT_BYTES;
  return `${head}\n\n[truncated: ${dropped} more bytes]`;
});
```

The `[truncated]` marker is not politeness. Without it the model reads a `grep` that stops at line 400 and concludes there are no more matches. Truncation the model cannot see is worse than truncation it can, because it turns a budget problem into a correctness problem.

## Lever two: spill, don't truncate

Truncation throws away the tail. Often the tail is where the answer was.

Spilling writes the full result somewhere durable and puts a *handle* in the conversation:

```typescript
registry.addPostHook(async (tool, result, ctx) => {
  if (result.length <= MAX_RESULT_BYTES) return result;

  const ref = await spillStore.write(result);      // content-addressed
  const lines = result.split('\n');

  return [
    `[Large result: ${result.length} bytes, ${lines.length} lines — stored as ${ref}]`,
    `First 40 lines:`,
    lines.slice(0, 40).join('\n'),
    ``,
    `Use read_spill({ ref: "${ref}", offset, limit }) to read more.`,
  ].join('\n');
});
```

Plus the tool that reads it back. Now nothing is lost — it moved from the context to a place the model can page through deliberately. A 200KB `grep` costs a few hundred tokens and stays fully available.

This is the pattern to reach for whenever a result is *large but structured*: search hits, file listings, logs, test output. The model rarely needs all of it; it needs to know it exists and be able to look.

## Lever three: prune stale results

Some results were useful once and are now dead weight. The classic: the agent reads a file, edits it, reads it again. The first read is 3,000 tokens describing a version of the file that no longer exists.

Pruning replaces the body of superseded results with a marker, in place:

```typescript
function pruneSupersededReads(events: SessionEvent[]): SessionEvent[] {
  const latestReadOf = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'tool/call' && e.name === 'read') {
      latestReadOf.set((e.input as { path: string }).path, e.seq);
    }
  }
  // ...replace the content of every earlier read of the same path with a marker
}
```

Two rules keep this honest.

**Prune the projection, never the log.** The pruned version is what `deriveMessages` produces. The log keeps everything — that is the whole [point of Part 8](/en/blog/building-agents/the-session-log/). If pruning edited the log, your transcript would stop matching what happened.

**Leave a marker.** `[earlier read of src/a.ts — superseded]` is honest. Silent removal makes the model believe it never read the file, so it reads it again, and you have built a loop.

## Lever four: summarise, last

When the first three are not enough, you compress. This is the only lever that destroys information, so it comes last and needs the most care.

The threshold matters more than the technique:

```typescript
const TRIGGER_RATIO = 0.7;    // NOT 0.95

async function maybeCompact(log: SessionLog, model: ModelInfo) {
  const used = await countTokens(deriveMessages(log.read()));
  if (used < model.contextWindow * TRIGGER_RATIO) return;
  await compact(log);
}
```

Why 70%: **summarisation is itself a model request, and it needs room.** It must read the history being summarised and write a summary. Trigger at 95% and the operation that saves you cannot fit in what is left. This is the single most common way compaction fails in production — not a bad summary, but no summary at all, because it was attempted from inside the emergency.

What survives compaction is a design decision, not a prompt. In rough order of importance: the original task, decisions made and why, file paths touched, unresolved questions, the last few turns verbatim. What goes: intermediate tool output, superseded reads, exploration that led nowhere.

And the boundary rule: **compact a balanced region.** A summary must not swallow a tool call without its result or cross an open turn boundary; that produces a history the adapter cannot replay safely.

## Recovering from overflow

Despite all four levers you will still hit the ceiling, because a single tool result can exceed the window on its own.

Handle it as a recovery path, not an error path:

```typescript
const finish = await llm.request(req, signal);

if (finish.kind === 'error' && finish.error.code === 'context_overflow') {
  const freed = await emergencyPrune(log);      // aggressive: drop all tool bodies
  if (!freed) return finish;                    // nothing left to free — real failure
  return llm.request({ ...req, messages: deriveMessages(log.read()) }, signal);
}
```

Retry **only if pruning actually freed something.** Without that check, an overflow caused by one enormous message becomes an infinite loop of identical failing requests. The condition is not "did we try to prune" but "did the token count go down".

## Metering

You cannot manage a budget you do not measure. Log per turn:

```typescript
interface TurnBudget {
  turnId: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolResultTokens: number;   // the number that actually predicts trouble
  windowUsedRatio: number;
}
```

`toolResultTokens` is the leading indicator. When it climbs as a share of input, you are heading for a compaction whether or not the ratio looks safe yet — and the fix is usually a tool that should be spilling and is not.

## What the grown-up version looks like

DeepSeek Harness splits this across three capability families — `compaction`, `spill`, and `token-meter` — each implemented by several small packages. The integration detail is the interesting part.

Compaction hooks two events: `agent/pre-step`, to check pressure *before* the request is built, and `agent/request-error`, to catch canonical context overflow it did not predict. The first is the planned path, the second is the recovery path, and they are deliberately different code.

The recovery path has a rule worth copying verbatim: it opens a fresh retry turn **only when pruning or summarisation advanced the replacement generation.** Otherwise the original error stands. That is the "did it actually free something" check, made structural.

And spill is a seam with its own storage provider, not a hardcoded temp directory — so the same policy works when the [execution world](/en/blog/building-agents/the-execution-world/) moves to a remote sandbox.

## The trap

The trap is summarising only when the window is full.

It feels responsible — do not compress until you must, keep fidelity as long as possible. And it fails exactly when it matters, because compaction is a model request and by then there is no room for one. The agent stalls in a state where the only operation that could rescue it is the one that no longer fits.

The related trap is treating compaction as the whole answer. If a single `grep` can consume 40% of your window, no summarisation strategy saves you — you have a tool-result problem wearing a context-management costume. Cap and spill first; summarise what is left.

## Next

**Part 11 — Skills.** Your agent needs to know your company's release process. Put it in the system prompt and every session pays for it, including the one that only touches CSS.
