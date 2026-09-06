---
title: 'The Inbox: Two Boundaries, One Durable Queue'
description: 'Follow-up, steering, and passive context differ in when they may enter the loop and whether they wake it. The inbox makes those choices explicit.'
pubDate: 2026-09-09
tags: ['ai-agents', 'architecture', 'concurrency']
translationKey: 'agents-04-inbox'
sidebarTitle: '4 · The inbox'
order: 4
---

An agent is halfway through the wrong approach. You type: “Stop editing that module; inspect `config/` first.”

A one-shot `run(task)` function has nowhere to put the correction. Killing the process throws away work; waiting makes the correction stale. The runtime needs a delivery boundary between “input accepted” and “input enters a model request.”

DeepSeek Harness calls that boundary the inbox.

## One inbox, two durable lists

The real structure is more precise than one FIFO. Each agent owns one `Inbox` with two ordered lists:

- **`next-turn`** holds ordinary follow-up prompts. At a turn boundary, the driver claims at most one.
- **`next-step`** holds steering and injected context. At every step boundary, the driver claims the complete pending batch.

At the beginning of a turn, `claim('next-turn')` returns all pending next-step messages first and then one next-turn message. Between steps, `claim('next-step')` drains only next-step input.

<figure class="dg">
  <img src="/diagrams/part04-inbox-funnel.svg" alt="Follow-ups enter the next-turn list; steering and injected context enter the next-step list; one claim operation drains the eligible batch." loading="lazy" />
  <figcaption><strong>One mutation surface, two semantic boundaries.</strong> Separate lists prevent a passive context update from becoming an accidental user turn.</figcaption>
</figure>

Every mutation is appended as `agent/inbox/spliced` before the in-memory projection changes. Insert, replace, remove, clear, and claim therefore survive restart and can be replayed. The live inbox is a projection of durable splice events, not an unrelated queue beside the log.

## Three delivery operations

The public operations are deliberately small:

| Operation | Target | Wakes an idle agent? | Meaning |
|---|---|---:|---|
| `followup(message)` | `next-turn` | Yes | Start a normal later turn. |
| `steer(message)` | `next-step` | Yes | Redirect the nearest possible step; if idle, open a turn. |
| `inject(message)` | `next-step` | No | Add model-facing context without creating work by itself. |

That last row is easy to get wrong. `inject` does **not** target `next-turn`. It targets the next step, but remains passive. If the agent is running, it can be claimed at a later step boundary. If the agent is idle, it stays parked until a follow-up or steer wakes the driver.

```typescript
followup(message) { send(message, 'next-turn', true); }
steer(message)    { send(message, 'next-step', true); }
inject(message)   { send(message, 'next-step', false); }
```

The target and wake flag answer independent questions:

1. **When may this content be admitted?**
2. **May this content create activity by itself?**

Conflating them is how a file watcher starts surprise model calls, or a user correction waits until the next conversation.

## Steering is cooperative

Steering does not splice text into a request already on the wire. It enters at the nearest later pre-step boundary:

<figure class="dg">
  <img src="/diagrams/part04-steering-sequence.svg" alt="A user sends steering while tools run; the current work reaches its boundary, then the next pre-step claims the correction." loading="lazy" />
  <figcaption><strong>Steering changes the next request, not the request already in flight.</strong> Cancellation is a separate operation when current work must stop immediately.</figcaption>
</figure>

This distinction keeps message history coherent. The model request and its tool results remain one completed step; the correction becomes a sourced user message in the next one. If the user wants both “stop now” and “do this instead,” the surface combines cancellation with preserved inbox input rather than pretending steering can time-travel.

## The acceptance race

There is a dangerous interval between accepting waking input and the asynchronous driver doing useful work. If status stays `idle` until a later microtask, a lifecycle owner can observe “idle,” dispose the agent, and strand a prompt the API already accepted.

DeepSeek Harness closes that window synchronously:

1. append the inbox insertion;
2. reserve a new driver immediately by changing the internal phase to `running`;
3. publish the status transition;
4. start the asynchronous turn.

`whenIdle()` follows the current activity promise and rechecks if replacement work was installed before the observed activity retired. A wake arriving behind maintenance or an already-aborted activity is latched and replayed when that activity converges to idle.

The invariant is stronger than “check the queue twice”:

> If a waking delivery is accepted, ownership of future activity changes synchronously.

## Cancellation and the inbox

`cancel(cause)` aborts the active operation and clears pending inbox work by default. `cancel(cause, { keepInbox: true })` aborts the current activity but preserves queued prompts and steering for a later turn.

A waking message submitted after an active cancellation is reclassified to `next-turn`, because it cannot join an operation whose signal is already aborted. A disposal cancellation does not replay the wake: teardown must not accidentally start a new model turn while trying to reach quiescence.

These rules are why inbox delivery belongs inside the agent lifecycle rather than in a UI component. Terminal, Web, SDK, webhook, and subagent settlement all need the same ordering.

## Next

**Part 5 — The LLM Layer.** A production loop does not consume provider-specific SSE directly; it needs one canonical stream vocabulary and exact terminal semantics.
