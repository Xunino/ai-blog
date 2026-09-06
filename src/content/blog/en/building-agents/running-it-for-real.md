---
title: 'Running It for Real'
description: 'It works. Now it runs for five hundred people and someone asks what it cost this month and where the money went. The answer is already in your log.'
pubDate: 2026-10-04
tags: ['ai-agents', 'operations', 'architecture']
translationKey: 'agents-29-operations'
sidebarTitle: '29 · Operations'
order: 29
---

Five hundred users. The finance question arrives: *what did this cost, and where did it go?*

Then the harder ones. Which failures are ours and which are the provider's. Why some sessions cost forty times others. Whether last week's prompt change helped or hurt. What happens when the process dies mid-turn.

You can answer all of them, and you do not need a metrics pipeline to do it.

<figure class="dg">
  <img src="/diagrams/part29-operations-harness.svg" alt="Every operational number is a fold over the session log, so metrics are recomputable and cannot disagree with the transcript." loading="lazy" />
<figcaption><strong>If a metric cannot be derived, you are missing an event.</strong> Log the event — do not open a second pipe.</figcaption>
</figure>

## Telemetry is a fold

> What you do not log, you cannot debug — and an agent's log **is** the [session log](/en/blog/building-agents/the-session-log/). Telemetry is not a second system. It is one more consumer of the event stream you already have.

Every number below is a reduction over events that already exist:

```typescript
interface TurnMetrics {
  turnId: string;
  steps: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  costUsd: number;
  cacheHitRate: number;
  toolCalls: number;
  toolErrors: number;
  wallClockMs: number;
  stopReason: string;
}

function foldTurn(events: SessionEvent[]): TurnMetrics {
  // usage from assistant/message, timings from turn/start..turn/end,
  // tool counts from tool/call and tool/result. Nothing new is recorded.
}
```

Two consequences, and both matter more than the code.

**Metrics are recomputable.** Fix a bug in the cost calculation and you can rerun it over history. A metrics pipeline that emitted numbers at the time cannot — those numbers are wrong forever.

**There is one source of truth.** The dashboard and the transcript cannot disagree, because the dashboard is derived from the transcript. This is the same discipline as Part 8, applied one layer up, and it is the reason the trap at the end of this post is the one it is.

## Cost, attributed

Total spend is the least useful number you can compute. Attribute it:

```typescript
const cost = (u: Usage, p: Pricing) =>
  (u.input_tokens * p.inPerMTok +
   u.cache_read_input_tokens * p.cacheReadPerMTok +
   u.cache_creation_input_tokens * p.cacheWritePerMTok +
   u.output_tokens * p.outPerMTok) / 1_000_000;
```

Then slice it, because each slice answers a different question:

| Slice | Tells you |
|---|---|
| per user | who to talk to about a workflow |
| per session | which shapes of task are expensive |
| per turn | where a session went wrong |
| per tool | which tool's results dominate input |
| cached vs fresh | whether [Part 9](/en/blog/building-agents/the-prompt-prefix/) is holding |

The two that consistently surprise teams: **cache hit rate** — a session at 30% costs several times one at 90% for identical work — and **tool-result share of input tokens**, which is the leading indicator for [context problems](/en/blog/building-agents/the-context-budget/). When it climbs, a tool that should be spilling is not.

Give the user their own numbers too. `agent stats <session>` printing tokens, cost, cache rate and tool failures is a debugging tool for them and a support-load reduction for you.

## Failure taxonomy

"Error rate" is not one number. Bucket by **who can fix it**:

```typescript
type FailureClass =
  | 'user-cancelled'      // not a failure at all
  | 'model-refused'       // policy decline
  | 'context-overflow'    // ours: budget management
  | 'tool-error'          // usually the user's environment
  | 'provider-error'      // theirs: 5xx, rate limits
  | 'harness-error'       // ours: a bug
  | 'guard-stopped';      // ours, deliberately
```

`user-cancelled` in the same bucket as `provider-error` is the mistake from [Part 5](/en/blog/building-agents/the-llm-layer/), and it poisons every alert built on the total. Someone changing their mind is not an incident.

Alert on `harness-error` and on sudden movement in `context-overflow` or `guard-stopped`. Do not alert on `tool-error` — a failing test *is* a tool error, and it is the agent working.

## Crash accounting

The process dies mid-turn. What was lost?

Because the log is append-only and flushed as events are appended, you lose at most the events after the last flush. On restart, a session whose last event is `step/start` with no `step/end` was interrupted — and that is a recoverable, *nameable* state:

```typescript
function classifyOnLoad(events: SessionEvent[]): 'clean' | 'interrupted' {
  const last = events.at(-1);
  return !last || last.kind === 'turn/end' ? 'clean' : 'interrupted';
}
```

Append a `turn/end` with reason `interrupted` and tell the model plainly on resume: *"the previous turn was interrupted by a restart; verify the state of anything you were changing."* Silently resuming produces an agent that believes an edit landed when it did not.

Two things that genuinely can be lost and should be stated: a message accepted into the [inbox](/en/blog/building-agents/the-inbox/) but not yet logged, and the tail of a stream. Both are small windows. Neither is zero, and pretending otherwise is how you get an incident where the transcript and reality disagree.

## Retention and consent

Session logs are a rich record: source code, file paths, sometimes credentials someone pasted. Decide these before the first user, not after the first request:

- **Where do logs live?** Local by default is a defensible answer. Uploaded by default is a decision that needs consent.
- **How long?** A default retention with an explicit `agent sessions prune` and a documented policy.
- **What leaves the machine?** If telemetry is sent anywhere, publish the schema. *"Anonymous usage data"* is not a schema.
- **Can a user delete?** One command, and it must actually delete — including the search index from [Part 12](/en/blog/building-agents/cross-session-recall/).

Opt-in for anything that leaves the machine. The uncomfortable specificity of writing down exactly what you collect is the point of the exercise.

## Feedback, attached to the evidence

A thumbs-down is nearly useless. A thumbs-down **attached to a session id** is an eval case:

```typescript
{ kind: 'feedback/given', turnId, rating: 'negative', comment, at }
```

In the log, so it travels with the evidence. Now the loop from [Part 28](/en/blog/building-agents/evals/) closes: negative feedback → find the session → extract the task → add it to the eval set → measure the fix. That pipeline is the difference between a product that improves and one that accumulates complaints.

## Publish the limits

Ship an honest statement of what the agent can do and what confines it. Not legal boilerplate — the list a reviewer needs to decide whether to allow it:

- What the sandbox does and does not contain, per platform.
- What runs without approval in each preset.
- What leaves the machine, and when.
- Known failure modes.

Most projects have this scattered across a README, a changelog and someone's memory. Writing it in one place is a few hours, and it is the artifact that gets you through a security review.

## What the grown-up version looks like

DeepSeek Harness derives session telemetry from the log rather than emitting a parallel stream, and every package README carries a **Known Limitations and Deferred Work** section — required, enforced by a gate, with an explicit allowlist for the few packages that are genuinely exempt.

That convention is the one to steal from this whole post. It makes "what does this not do?" a thing you write down while building, in the same file as what it does. The alternative is discovering your limitations from a user, in an issue, with an audience.

## The trap

The trap is a metrics system next to the log.

It happens naturally: you need a dashboard, so you emit metrics — StatsD, OpenTelemetry, a table. Now there are two records of what happened, they disagree in edge cases, and the one you show finance is not the one you use to debug.

The log already contains every fact. Derive from it. If a metric cannot be derived, that is a signal you are missing an *event*, and the fix is to log the event — not to open a second pipe.

## The series

Twenty-nine parts, and the loop from Part 1 is unchanged:

```typescript
const response = await client.chat.completions.create({ ...request, messages });
messages.push(response.choices[0].message);
if (!response.choices[0].message.tool_calls?.length) break;
messages.push(...toolResults);
```

Everything since has been the consequence of keeping those four lines alive: alive for an hour instead of a minute, for a stranger instead of you, on a repository you cannot afford to break.

If one thing survives, make it this: **model-visible ⟺ logged**. Nearly everything else in this series is downstream of getting that direction right. Resume, fork, transcripts, compaction, recall, telemetry, replay testing, crash recovery — all of them are cheap when history is projected from a log, and all of them are separate hard problems when it is not.

And the two habits worth more than any component: **fail loudly** — silent capability loss is the failure mode that costs weeks — and **measure the thing you claim to care about**, because an agent that gets quietly worse will not tell you, and neither will your tests.
