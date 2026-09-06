---
title: 'Delegation: Subagents Without Orphans'
description: 'A subtask eats forty turns of exploration and every one lands in the main conversation. Handing it to a child is easy; owning that child is not.'
pubDate: 2026-09-26
tags: ['ai-agents', 'architecture', 'lifecycle']
translationKey: 'agents-21-delegation'
sidebarTitle: '21 · Delegation'
order: 21
---

The agent needs to know which of four caching layers is invalidating early. Answering takes forty turns of grepping, reading, and hypothesis-testing. All forty land in the main conversation, and by the time the answer arrives, the task that prompted the question has been [compacted](/en/blog/building-agents/the-context-budget/) out of the window.

The fix is obvious: hand the investigation to a child agent with its own context, get back only the conclusion.

The fix is also where every ownership question from the last six posts arrives at once — which is why this post is here and not at Part 5.

## A seam, not a feature

> Delegation is a **capability seam**, not a feature. And children come in two shapes with different lifetimes, settling at different boundaries.

**One-shot.** Runs once, produces a result, disposed. The parent waits for it or collects it as a [job](/en/blog/building-agents/background-work/).

**Continuable.** Has a durable session. Accepts follow-up messages. Can go cold and be resumed days later.

Same seam, different machinery. Building the second as a variation of the first — a one-shot run you forgot to dispose — is the mistake; it is a session with a residency period, and residency is the concept that makes it work.

The provider side is thin, and that is the point:

```typescript
interface SubagentProvider {
  readonly name: string;
  readonly capabilities: {
    agentOptions: boolean;   // may the caller override provider/model?
    toolFilter: boolean;     // may the caller restrict the child's tools?
    persona: boolean;
    depthLimit: boolean;
  };
  /** Does the child see the parent's completed turns? */
  readonly inheritsParentContext: boolean;

  start(request: ResolvedStartRequest): Promise<SubagentRun>;
  /** Presence of this method IS the continuable capability. */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<{ seed?: SessionEvent[] }>;
}
```

`spawn` (fresh child) and `fork` (seeded with the parent's completed turns) differ by one field. Out-of-process providers — another product entirely, over a protocol — implement the same interface and simply advertise fewer capabilities.

**Check capabilities before dispatch, and fail loudly:**

```typescript
function assertCapabilities(p: SubagentProvider, req: StartRequest) {
  for (const [need, cap] of [
    [req.persona !== undefined, 'persona'],
    [req.toolFilter !== undefined, 'toolFilter'],
    [req.agentOptions !== undefined, 'agentOptions'],
    [req.maxDepth !== undefined, 'depthLimit'],
  ] as const) {
    if (need && !p.capabilities[cap]) {
      throw new SubagentError(`provider "${p.name}" does not support "${cap}"`);
    }
  }
}
```

Silently ignoring a `persona` the provider cannot honour gives you a child running the wrong role, with no error anywhere. Same principle as [Part 17](/en/blog/building-agents/configuration-must-fail-loudly/): accepted-then-ignored is the worst outcome available.

<figure class="dg">
  <img src="/diagrams/part21-delegation-subagents.svg" alt="A one-shot child settles at publication; a continuable child settles earlier, at inbox acceptance, after which the caller signal cancels nothing." loading="lazy" />
<figcaption><strong>Two lifetimes, two settle points.</strong> Conflate them and a cancelled caller tears down a continuable child mid-thought.</figcaption>
</figure>

## Two boundaries

Here is the detail that surprises people, and it is the sharpest thing in this post.

**One-shot settles at publication.**

```typescript
async function start(name: string, request: StartRequest): Promise<SubagentRun> {
  const provider = expectProvider(name);
  assertCapabilities(provider, request);
  assertDepth(request);
  const descriptor = snapshotDescriptor({ mode: 'one-shot', provider: name });  // before any await
  return provider.start({ ...request, descriptor });
}
```

`start()` fulfils only once a real child exists. Before that, the provider owns the setup and must roll it all back on failure. After it, the caller owns a run and must dispose it. The caller therefore holds either a live child or nothing — never a half-built one.

**Continuable settles at inbox acceptance.**

```typescript
async function startContinuable(spec: ContinuableSpec): Promise<{ childId; messageId }> {
  const childId = newSessionId();
  const descriptor = snapshotDescriptor({ mode: 'continuable', provider: spec.provider,
                                          model: resolved.model, persona: spec.persona });
  const release = holdOwnership(spec.parent, childId);      // ← see below
  try {
    const prepared = await provider.prepareContinuable({ sessionId: childId, parent: spec.parent });
    return await locks.run(childId, async () => {
      const activation = await materialize({ childId, seed: prepared.seed, descriptor });
      const messageId = submit(activation, spec.prompt);     // ← resolves HERE
      return { childId, messageId };
    });
  } catch (err) { release(); throw err; }
}
```

It resolves when the prompt is **accepted into the inbox** — before the turn starts, before the message reaches the session log. From that instant the caller's `signal` cancels nothing: the manager owns the activation independently.

Two lifetimes, two settle points. Conflate them and you get a continuable child that a cancelled caller tears down mid-thought.

## Activation

A continuable child is a durable session with **at most one** live activation:

```text
persisted Session                 durable, survives process teardown
  └── Activation (≤ 1)            process-local residency period
        ├── one AgentHandle
        ├── the Agent's inbox     the only turn queue
        └── ownedChildren: Set<SessionId>
```

Because a session has at most one activation, **the child's session id identifies the live child**. No second runtime-incarnation reference, no generation counter.

State is derived, exactly as in [Part 15](/en/blog/building-agents/who-owns-the-agent/):

```typescript
function stateOf(a: Activation): 'running' | 'waiting' | 'settled' {
  if (a.handle.agent.status === 'running' || a.accepted.size > 0) return 'running';
  if (a.ownedChildren.size > 0) return 'waiting';
  return 'settled';
}
```

### Holding the parent open

`holdOwnership` above is the subtlest line in the system and worth its own paragraph.

If the parent is *itself* a continuable child and currently idle, it can decide it has nothing left to do and settle **while its child is being created**. Delivery then finds a dead parent identity.

So: insert `childId` into the parent's `ownedChildren` *before* the first `await`. A parent cannot settle while that set is non-empty. On failure, `release()` removes it and wakes the parent to re-evaluate.

## Adjacency

Who may message whom? The permissive answer — anyone with an id — makes the system unreasonable by the third generation.

> Authority is **exact adjacency**, checked against the **live** sender object.

```typescript
async function sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[]) {
  if (agents.get(sender.id) !== sender) {
    throw new SubagentError('requires the exact live sender agent');   // stale object
  }
  const senderActivation = activations.get(sender.id);
  if (senderActivation?.handle.agent === sender && senderActivation.parentSession === targetId) {
    return sendToParent(senderActivation, content);                    // child → parent
  }
  if (sender.session.header.parentSession === targetId) {
    throw new SubagentError('not a resident continuable child; cannot message parent');
  }
  return deliverToChild(sender, targetId, content);                    // parent → child
}
```

Note the two middle branches. Both ask "is the target my parent?" and they answer differently: the first checks the **resident activation**, the second checks the **durable header**. An agent whose header names a parent but which is not residently continuable — a one-shot child, say — lands in the second branch and is refused, rather than silently falling through to the child path.

Allowed: parent → direct child, and resident child → direct parent. Refused: siblings, grandparents, self, stale objects, one-shot children.

And routing by residency, which is where cold resume enters:

| Target activation | Delivery |
|---|---|
| `running` | steer at the nearest step boundary |
| `waiting` | wake and steer the same activation |
| none | **cold-resume** a new activation, then steer |

## Cold resume without the provider

A child that has gone cold is resumed from its own log. No provider is involved:

```typescript
async function coldResume(parent: Agent, childId: SessionId, content: ContentBlock[]) {
  const observation = await query.observeSession(childId);
  authorizeLineage(parent, childId, observation.header.parentSession);

  // Fold ONLY this child's own suffix.
  const descriptor = foldDescriptor(observation.events.slice(observation.inheritedEventCount));
  if (descriptor?.mode !== 'continuable') throw new SubagentError('NOT_RESUMABLE');

  const activation = await materialize({
    childId,
    agentOptions: { provider: descriptor.provider, model: descriptor.model },
    composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
  });
  return submit(activation, content);
}
```

**`inheritedEventCount` is the bug you would otherwise ship.** A `fork` child is seeded with the parent's log. If that parent was itself a continuable child, the replayed log **contains the parent's descriptor**. Fold the whole array and you resume with the ancestor's model and persona. Slice at the inherited boundary — the field [Part 8](/en/blog/building-agents/the-session-log/) introduced for exactly this — and the child's own descriptor wins.

Which is also why the continuable descriptor snapshots the resolved model and persona: at resume time the original parent may be long gone, so the descriptor must be self-sufficient.

## Teardown ordering, and one race

Disposal is [Part 15](/en/blog/building-agents/who-owns-the-agent/)'s child-first release, with one addition that is a genuine bug fix:

```typescript
async function finishDisposal(a: Activation) {
  a.handle.agent.cancel({ kind: 'parent' });                 // top-down, before any await
  await Promise.allSettled([...a.ownedChildren].map(disposeChild));
  await a.handle.agent.whenIdle();
  await flushSession(a).catch(logWarn);

  notifySettlement(a, terminalOutcome(a));    // ← BEFORE releasing ownership
  releaseOwnership(a.childId);                // ← even on failure
  await a.handle.dispose();
}
```

Swap those two lines and here is what happens: ownership is released, the parent's settlement watcher wakes one microtask later, finds itself childless and quiet, and disposes itself — and its `cancel()` clears the inbox holding the notice you just delivered. The notice is sent successfully and destroyed before it is read.

And release ownership **even when teardown failed**. A retained failed child pins its entire ancestry in `waiting` forever.

The notice itself gets its own provenance kind — not `agent-message`:

```typescript
source: { kind: 'subagent-settled', childId, summary: 'Child ran out of context.' }
```

Because the cases that most need a notice — token ceiling, model failure, cancellation, teardown — are exactly the ones where the child never got to choose its words. Labelling the runtime's account as something the child said credits it with words it never wrote.

## Depth, and deterministic delegation

A child that can delegate can recurse. Cap it, from the **persisted** header:

```typescript
function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const depth = delegationDepthOf(parent) + 1;         // from the durable header
  if (maxDepth !== undefined && depth > maxDepth) throw new DepthError(depth, maxDepth);
  return depth;
}
```

Reading the persisted header rather than an in-memory field means a resumed parent cannot pretend to be top-level. Default 3. And the tool stays visible at the cap — each attempt is refused with an error the model can read, rather than a capability vanishing silently.

Worth naming the alternative: when the fan-out is *known in advance*, a **workflow script** — deterministic control flow, agents as steps — beats model-driven delegation. The model decides *what* each step does; your code decides *how many* there are and in what order. Reach for delegation when the shape is unknown, for a script when it is not.

## The trap

The trap is letting any agent message any agent by id.

It looks like generality and it is the end of comprehensibility. Once a grandchild can message an uncle, "what can reach this agent?" has no answer short of reading everything, deadlock becomes possible between agents with no declared relationship, and the ownership graph — the thing keeping teardown correct — stops describing the communication graph.

One edge. If two agents need to coordinate and are not adjacent, that is a signal the *hierarchy* is wrong, not that the rule is.

## Next

**Part 22 — Approval and permissions.** The agent is about to `git push --force`. You want to be asked. You do not want to be asked before every `ls`.
