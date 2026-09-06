---
title: 'Who Owns the Agent'
description: 'The public Agent can receive work and be cancelled. The AgentHandle can end its lifetime. That asymmetry is the ownership boundary.'
pubDate: 2026-09-20
tags: ['ai-agents', 'architecture', 'lifecycle']
translationKey: 'agents-15-ownership'
sidebarTitle: '15 · Ownership'
order: 15
---

One agent in one process can treat process exit as teardown. A web host with forty agents cannot.

When a user closes a tab, you need exact answers. Does the current request stop? Does queued work survive? Who closes the session writer? Can an unrelated plugin destroy an agent because it knows the session id?

DeepSeek Harness answers those questions with an intentionally asymmetric API.

## The disposer is a capability

```typescript
interface AgentHandle {
  readonly agent: Agent;
  dispose(): Promise<void>;
}

interface AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  get(id: SessionId): Agent | undefined;
}
```

`ctx.agents.get(id)` returns the public `Agent`. The caller that created or resumed it receives the `AgentHandle`.

That difference is not convenience. It is authority.

> The public agent may accept messages and cooperative cancellation. Only a handle holder may end the agent's lifetime.

Putting `dispose(id)` on the registry would turn a predictable identifier into ambient teardown authority. Returning a disposer only to the owner makes lifetime control explicit in the type system.

<figure class="dg">
  <img src="/diagrams/part15-who-owns-agent.svg" alt="An AgentHandle owns terminal teardown, while the public Agent exposes messaging, cancellation, quiescence and maintenance." loading="lazy" />
<figcaption><strong>Cancellation is an operation; disposal is ownership.</strong> They must not be the same method.</figcaption>
</figure>

## The public lifecycle has two states

DeepSeek Harness exposes only:

```typescript
type AgentStatus = 'idle' | 'running';
```

`running` begins synchronously when waking input reserves the driver. `idle` means no turn driver is scheduled or active. Disposal removes the agent from the registry; it is not a third observable status.

This closes the classic microtask race. Once an idle agent accepts waking input, observers see `running` immediately. They do not need a second accepted-message counter to guess whether work is waiting to start.

Nor do child agents add a `waiting` state here. Child residency, lineage, and settlement belong to the subagent subsystem. The core `Agent` reports only whether its own driver is active.

## Quiescence is a promise, not a status label

```typescript
await agent.whenIdle();
```

`whenIdle()` waits for the current whole-agent activity to converge to quiescence. If replacement work starts before the observed driver retires, the promise follows that replacement work too.

That is stronger than polling `status`. A caller can observe `running`, begin waiting, and still get the correct result if a late wake is admitted during cancellation convergence. The driver owns that race; consumers do not reconstruct it from events.

`whenIdle()` does not identify the settlement of one particular message. It answers a lifecycle question: is this agent currently quiet?

## Creation is one rollback-covered transaction

The concrete loop creates a private session, a concrete agent, and an agent-scoped context before either id becomes public. Optional setup runs inside that private world. Persistence write ownership is acquired before publication.

Only after setup succeeds does the loop enter both registries, announce `session/created` and `agent/created`, emit `agent/session-start`, and start the driver.

If setup throws, publication is vetoed, the owner disappears, or the commit fails, the transaction rolls back without leaving a half-registered agent or session.

> Publication is the boundary: before it, setup must be fully reversible; after it, the returned handle owns teardown.

The factory provider is a second, structural owner. Agents depend on services supplied by that provider, so unloading it stops and drains every live handle it created. Consumer disposal and provider unload converge on the same teardown path.

## Cancel is not disposal

The public `Agent` exposes cooperative cancellation:

```typescript
agent.cancel({ kind: 'user' }, { keepInbox: true });
```

Cancellation aborts the current turn or maintenance task. By default it also clears queued and steering work. `keepInbox: true` preserves pending work so a user can interrupt the current direction without erasing what has already been accepted.

Cancellation is a no-op when nothing is active; it does not arm a future request. The first cancellation cause wins for the current activity.

Disposal is terminal. The handle's memoized `dispose()` aborts with a `disposed` cause, waits for the driver to become quiescent, closes the session write path, unwinds the agent scope, detaches the agent, and then detaches the session. Exact-object detach guards prevent a stale disposer from removing a later agent that reused the same id.

## Maintenance owns the idle phase

Some work belongs to an agent but not to a conversational turn: title generation, a summary, or another housekeeping calculation.

```typescript
await agent.runMaintenance(async (signal) => {
  return generateTitle(agent.session, signal);
});
```

`runMaintenance()` synchronously claims the true idle phase. Public status remains `idle`, but waking input stays in the inbox until the task settles. Cancellation reaches the task through its signal, and `whenIdle()` follows both the maintenance task and any waking work released behind it.

This avoids inventing fake turns just to serialize housekeeping with conversation work.

## The trap

The trap is treating `dispose()` as cleanup that any conscientious component may call.

Cleanup is usually harmless when duplicated. Lifetime authority is not. If two unrelated components can tear down an agent, an error path in one feature can silently terminate work owned by another.

Keep the operations separate:

- use `cancel()` to stop or redirect current work;
- use `whenIdle()` to wait for quiescence;
- use `runMaintenance()` for serialized non-turn work;
- use the owned handle's `dispose()` to end the lifetime.

## Next

**Part 16 — Scope and presets.** One session needs full access; another, in the same process, must be read-only. There is no global that can express that.
