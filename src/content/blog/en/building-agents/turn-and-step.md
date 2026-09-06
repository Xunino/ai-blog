---
title: 'Turn and Step: When Is It Actually Done?'
description: 'A model response, a step, and a user turn end at different boundaries. Confusing them creates dropped steering, broken audit trails, and premature teardown.'
pubDate: 2026-09-07
tags: ['ai-agents', 'architecture']
translationKey: 'agents-02-turn-and-step'
sidebarTitle: '2 · Turn and step'
order: 2
---

The loop in [Part 1](/en/blog/building-agents/an-agent-is-a-while-loop/) stops when the assistant returns no tool calls. That is a fact about one model response. It is not yet a fact about the surrounding unit of work.

The distinction matters as soon as input can arrive while the agent is running.

<figure class="dg">
  <img src="/diagrams/part02-race-condition.svg" alt="A response finishes while new steering is waiting; a naive loop exits before claiming it." loading="lazy" />
  <figcaption><strong>A natural model stop is only a candidate boundary.</strong> The runtime still has to account for input already accepted for the next step.</figcaption>
</figure>

## Two lifetimes

DeepSeek Harness names two units:

> A **step** is one model request plus the tool calls produced by that request.  
> A **turn** is zero or more steps opened around one admitted unit of interactive work.

A tool-calling response normally leaves the step without a terminal turn outcome. Its results are appended, then the next step sends those observations back to the model. A text response, a max-token finish, a policy block, or a concluding tool result can produce a candidate turn outcome.

Before committing that outcome, the driver checks the next-step inbox and gives `agent/turn-stopping` listeners one final checkpoint. Steering or injected context already accepted for the current turn can therefore cause another step. An ordinary follow-up queued for `next-turn` does not get merged into the current turn; it opens another durable boundary after the current one closes.

<figure class="dg">
  <img src="/diagrams/part02-turn-container.svg" alt="A turn contains zero or more steps; next-step input may extend it, while next-turn input opens the following turn." loading="lazy" />
  <figcaption><strong>Step asks “did this request settle?” Turn asks “does this interaction still owe a request?”</strong></figcaption>
</figure>

## The actual state machine

Reduced to its control decisions, the production flow looks like this:

```typescript
async function runTurn() {
  append('turn/start');
  let target: 'next-turn' | 'next-step' = 'next-turn';
  let outcome: TurnOutcome | null = null;

  try {
    while (true) {
      // At turn start: all next-step input + one queued follow-up.
      // Between steps: next-step input only.
      const claimed = inbox.claim(target);
      const decision = await preStep(claimed);

      if (decision.kind === 'reject') {
        outcome = { kind: 'blocked' };
        break;
      }
      if (isFirstStep() && decision.messages.length === 0) {
        outcome = { kind: 'completed' }; // zero-step turn
        break;
      }

      append('step/start');
      outcome = await runModelAndTools(decision); // null means another request is owed
      append('step/end');

      if (outcome && inbox.nextStep.length === 0) {
        await emitTurnStoppingCheckpoint();
      }
      if (outcome && inbox.nextStep.length === 0) break;
      target = 'next-step';
    }
  } finally {
    append('turn/end', outcome);
  }
}
```

This code is intentionally a reduction. The important ordering comes from the real implementation:

- `turn/start` is durable before the first claim;
- `step/start` exists only after `agent/pre-step` admits non-empty work;
- admitted user messages are appended before the model request;
- `step/end` is appended even when request processing fails;
- `turn/end` is appended from `finally`, including abort and error outcomes.

The log therefore records the boundary the system attempted, not just the work that reached the model.

## Zero-step turns are not missing data

Two paths can open a turn and spend no model request.

First, a `pre-step` policy can reject the claimed batch. The turn ends as `blocked`. The claimed message is no longer pending and no `user/message` is appended, because the model never saw it.

Second, waking input can be removed or rewritten to an empty enter decision before the first step begins. The turn still ends as `completed`. That empty boundary matters: a wake was accepted, a driver was reserved, and the durable log explains why no model call followed.

Calling both cases “nothing happened” throws away the audit trail.

## What is actually owed

At the turn level, only work that must feed another request keeps the current turn open:

| Pending fact | Consequence |
|---|---|
| The assistant emitted tool calls | Execute them and return their results in another step. |
| A tool result added next-step context | Claim it before the turn closes. |
| Steering entered the next-step inbox | Admit it at the nearest later step boundary. |
| A terminal listener injected more next-step work | Re-evaluate rather than committing the candidate stop. |

Background jobs and subagents have their own ownership lifecycles. A parent turn does **not** remain open merely because a child exists; otherwise a delegated long-running task would pin the parent model loop. Child settlement can later inject context or wake new work, and parent disposal still has to drain owned children. Turn completion and agent-tree quiescence are different questions.

## Why the names matter

If “turn” means “one HTTP request” in one package and “one user interaction” in another, cancellation, metrics, and persistence become impossible to interpret. Stable terminology gives every subsystem the same coordinates:

- retries can happen inside one step or at a fresh durable boundary according to policy;
- usage can be attributed to a specific `(turn, step)`;
- a UI can group chunks, calls, and results under the interaction that owns them;
- crash repair can see whether a log ended inside a turn or at a stable boundary.

## Next

**Part 3 — A Tool Is Not a Function.** The next boundary is the path between a model asking for an effect and the system allowing that effect to happen.
