---
title: 'The Session Log Is the Source of Truth'
description: 'The model history is projected from an append-only log — not maintained alongside it. Getting this backwards is the most expensive mistake in the system.'
pubDate: 2026-09-13
tags: ['ai-agents', 'architecture', 'persistence']
translationKey: 'agents-08-session-log'
sidebarTitle: '8 · Session log'
order: 8
---

Restart the process. The conversation is gone.

That is the obvious one, and the obvious fix is to write `messages` to a file and read it back. Do that, ship it, and three weeks later you get the requests that reveal why the obvious fix was wrong:

- *"Go back to what you said five turns ago and try a different approach from there."*
- *"Show me exactly what the model saw when it decided to delete that file."*
- *"The agent claims it ran the tests. Did it?"*
- *"Summarise this conversation so it fits in the window, but keep the transcript intact."*

None of these are answerable from an array of messages. Not because the array is in memory — because the array is *lossy*. It holds what the model needs for the next request, which is a strict subset of what happened.

## The inversion

> **Model-visible ⟺ logged.** Anything that reaches a model request must be reconstructable from the log. The message history is a **projection** of the log — not a second copy maintained alongside it.

Read that twice, because the direction is the whole post. Most people build:

```text
messages[]  ──append──►  log file        (log is a copy of history)
```

What you want is:

```text
log[]  ──deriveMessages()──►  messages    (history is a view of the log)
```

The difference shows up the moment the two could disagree. In the first design they *will* disagree, and you will find out during an incident, when the log you are reading is not what the model saw.

## Events, not messages

The log's unit is an **event**, and events record more kinds of fact than messages do:

```typescript
type SessionEvent =
  | { seq: number; at: number; kind: 'turn/start'; turnId: string }
  | { seq: number; at: number; kind: 'turn/end'; turnId: string; reason: StopReason }
  | { seq: number; at: number; kind: 'step/start'; stepId: string }
  | { seq: number; at: number; kind: 'user/message'; content: ContentBlock[]; source: MessageSource }
  | { seq: number; at: number; kind: 'assistant/chunk'; delta: unknown }
  | { seq: number; at: number; kind: 'assistant/message'; content: ContentBlock[]; usage: Usage }
  | { seq: number; at: number; kind: 'tool/call'; id: string; name: string; input: unknown }
  | { seq: number; at: number; kind: 'tool/result'; id: string; content: string; isError: boolean }
  | { seq: number; at: number; kind: 'request/header'; provider: string; model: string };
```

Three properties carry the design. **Append-only** — corrections are appended, never edited, which is what makes replay meaningful. **Monotonic `seq`** — ordering does not depend on timestamps, and "fork at 47" becomes a precise instruction. **Some events are model-visible, most are not** — which is why the log can hold more than the conversation.

The storage can be a JSONL file. Genuinely — one JSON object per line, appended:

```typescript
class SessionLog {
  private events: SessionEvent[] = [];
  private seq = 0;

  append<K extends SessionEvent['kind']>(kind: K, payload: Omit<...>): SessionEvent {
    const event = { seq: this.seq++, at: Date.now(), kind, ...payload } as SessionEvent;
    this.events.push(event);
    appendFileSync(this.path, JSON.stringify(event) + '\n');
    return event;
  }

  read(): readonly SessionEvent[] { return this.events; }
}
```

Sophistication here is premature. The design is the log; the storage is a detail you can upgrade when a profiler tells you to.

<figure class="dg">
  <img src="/diagrams/part08-session-log-projection.svg" alt="The append-only log is the source of truth; model history is projected from it, and other readers fold the same stream into their own state." loading="lazy" />
<figcaption><strong>History is a view, not a copy.</strong> One source of truth, several readers — each a pure fold over the same stream.</figcaption>
</figure>

## The projection

`deriveMessages` walks events and builds what the API wants. It is the only place that knows the mapping:

```typescript
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of projectCurrentSurface(events)) {
    const message = deriveEventMessage(event);
    if (message !== null) messages.push(message);
  }
  return messages;
}
```

The real projection is incremental and understands surface replacement, but the rule is this small: `user/message`, `assistant/message`, and `tool/result` project their own canonical messages; turn boundaries, chunks, request headers, usage, and other log-only events do not. The DeepSeek adapter later expands each canonical tool result into its required standalone `role: 'tool'` wire message.

The loop's change is small and total:

```typescript
- const response = await client.chat.completions.create({ ...req, messages: state.messages });
+ const response = await ctx.llm.stream({ ...req, messages: session.deriveMessages() });
```

There is no `state.messages` any more. There is nowhere for a second truth to live.

## Why keep the chunks

`assistant/chunk` is in that event list and it is not model-visible. Storing every streaming delta looks like pure waste — you already have the assembled `assistant/message`.

Keep them. They are what make the transcript *replayable* rather than merely readable. A UI reconstructing a session can play back the typing. A debugging session can see that the model started writing one thing and revised. And when a stream is cancelled mid-flight, the chunks are the only record of the prefix that existed — the assembled message never happened.

The cost is disk, which is the cheapest thing you own. The `assistant/message` event carries `sourceEventSeqs` listing which chunks produced it, so the link is explicit rather than inferred from adjacency.

## What this buys, immediately

**Resume.** Read the file, rebuild, continue. Three lines.

**Fork at a turn boundary.** Copy events up to a `seq`, start a new session with that prefix:

```typescript
function fork(source: SessionLog, atSeq: number, newId: string): SessionLog {
  const seed = source.read().filter((e) => e.seq <= atSeq);
  return SessionLog.create(newId, {
    seed,
    inheritedEventCount: seed.length,     // where inherited history ends
    parentSession: source.id,
  });
}
```

`inheritedEventCount` looks like bookkeeping and is not. It is the boundary between *events this session inherited* and *events this session produced*, and several later features depend on being able to ask that question. Fold a piece of state across the whole log and you will read the parent's value; fold across the suffix and you get this session's own. [Delegation](/en/blog/building-agents/delegation-subagents/) has a nasty bug that is exactly this distinction.

Fork only at a turn boundary. Mid-turn, tool calls are outstanding and results are unmatched — you would be branching from a state the model can never be in.

**Honest answers about the past.** "Did it run the tests?" is a `grep` over `tool/call` events. "What did the model see?" is `deriveMessages(events.filter(e => e.seq <= n))`.

**Projections.** Once events are the substrate, derived state is a fold: token totals, a turn outline for the UI, a title, cost per turn. Each is a small reducer over the same stream, computed rather than maintained. And because folds are pure, they can be cached with a watermark and recomputed when it moves.

## Versioning, before you need it

The log is durable, which means today's format will be read by tomorrow's code:

```typescript
const SESSION_FORMAT_VERSION = 0;   // pre-release: no compatibility promise
```

Two rules that cost nothing now and save a migration later.

**Adding an event kind is not a version bump.** Old code encountering an unknown kind should skip it — as long as it is not model-visible. If it *is* model-visible, skipping it silently means replaying a conversation the model never had, so those must be refused rather than ignored. Mark events with an `ignorable` flag and make the default *refuse*.

**Bump only for structural change** — renaming `seq`, changing how content nests. Adding fields is not structural.

## Attachments belong here too

A user pastes an image. It is model-visible, so it must be logged — but a base64 blob in a JSONL line makes the log unreadable and unbounded.

Store the bytes content-addressed, log the reference:

```typescript
{ kind: 'user/message', content: [{ type: 'image', attachmentId: 'sha256:9f2a…' }, …] }
```

The projection resolves ids to content when building the request. The log stays text, the bytes are deduplicated for free, and "model-visible ⟺ logged" still holds — the reference is enough to reconstruct exactly what was sent.

## The trap

The trap is keeping the array "for convenience".

It is completely reasonable in the moment. You have a working loop with `state.messages`; you add the log next to it; you will remove the array later. It is a five-minute refactor.

Then a code path appends to the array and not the log. Or the log and not the array. The bug does not surface as a crash — it surfaces as a transcript that disagrees with what the model saw, and you will not notice until you are reading that transcript to explain an incident, at which point the artifact you are using to explain what happened is itself wrong.

Delete the array in the same commit that adds the log. There is only one source of truth, or there are two sources and you have a race.

## Next

**Part 9 — The prompt prefix.** Your bill triples and latency doubles while traffic stays flat. The culprit is one line: a timestamp at the top of the system prompt.
