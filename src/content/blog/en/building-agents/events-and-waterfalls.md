---
title: 'Events and Waterfalls'
description: 'Compaction should run just before the request is built — without compaction knowing about the loop, or the loop knowing about compaction.'
pubDate: 2026-09-19
tags: ['ai-agents', 'architecture', 'plugins']
translationKey: 'agents-14-events'
sidebarTitle: '14 · Events'
order: 14
---

[Part 10](/en/blog/building-agents/the-context-budget/) needed compaction to run at a specific moment: after the input is claimed, before the request is assembled. [Part 13](/en/blog/building-agents/plugins-and-capability-seams/) said compaction should be a plugin.

Put those together and there is a gap. `ctx.provide('shell', …)` works because the shell is a *thing the loop asks for*. Compaction is not a thing anyone asks for — it is a thing that needs to happen at a moment in someone else's control flow. There is no service to provide.

You need an extension point: a named moment where the loop announces what it is about to do, and anything listening may observe it, change it, or stop it.

## Three families, and picking wrong is a design error

Before the mechanism, the taxonomy — because most of the mistakes here are choosing the wrong kind, and no amount of good implementation rescues that.

**Durable events** are facts appended to the log. `turn/start`, `assistant/message`, `tool/result`. They survive a reload, they are what a transcript is made of, and adding one is a change to your session format. Use one when *the fact must outlive the process*.

**Live events** carry a reference to something running. `agent/pre-step`, `agent/status`, `agent/inbox/claimed`. They are gone when the process ends and they cannot be replayed, because the thing they pointed at no longer exists. Use one to *observe or intercept work in flight*.

**Capability events** attach policy to a seam. `fs/write-intent`, `tools/pre-execute`. They belong to a capability rather than to the loop, and they exist so a policy plugin can hook the filesystem without importing the agent. Use one when *the concern belongs to the capability, not the loop*.

> Choosing the wrong family is a design error, not a code error.

The two failures are symmetric and both expensive. Make something durable that should be live, and you have written a live `Agent` handle into a log that will be read after that agent is gone. Make something live that should be durable, and the fact disappears on restart — which is how you get a transcript that cannot explain its own contents.

<figure class="dg">
  <img src="/diagrams/part14-events-waterfalls.svg" alt="Each waterfall listener may observe, modify going in, modify coming out, or short-circuit the rest of the chain." loading="lazy" />
<figcaption><strong>The listener decides whether the rest of the chain runs.</strong> That is why this is not just a middleware array — and why the missing <code>next()</code> is the trap.</figcaption>
</figure>

## Waterfall: the listener holds the chain

For interception, plain emit-and-forget is not enough. A listener needs to see the proposed value, alter it, and pass it on — or refuse.

The waterfall shape is worth understanding precisely because it inverts the usual control flow:

```typescript
type Waterfall<T> = (value: T, next: (v?: T) => Promise<T>) => Promise<T>;

class Events {
  private hooks = new Map<string, Waterfall<any>[]>();

  on<T>(name: string, hook: Waterfall<T>): Disposer {
    const list = this.hooks.get(name) ?? [];
    list.push(hook);
    this.hooks.set(name, list);
    return () => { /* remove */ };
  }

  async waterfall<T>(name: string, initial: T): Promise<T> {
    const chain = this.hooks.get(name) ?? [];
    const step = async (i: number, value: T): Promise<T> =>
      i >= chain.length ? value : chain[i](value, (v) => step(i + 1, v ?? value));
    return step(0, initial);
  }
}
```

The important line is `next: (v?: T) => Promise<T>`. **The listener decides whether the rest of the chain runs, and what it sees.** Which gives it four honest options:

```typescript
// 1. Observe — look, change nothing
events.on('agent/pre-step', async (decision, next) => {
  metrics.count('steps');
  return next();
});

// 2. Modify going in
events.on('agent/pre-step', async (decision, next) => {
  return next({ ...decision, messages: withTimestamp(decision.messages) });
});

// 3. Modify coming out
events.on('agent/pre-step', async (decision, next) => {
  const result = await next();
  return result.kind === 'enter' ? { ...result, messages: trim(result.messages) } : result;
});

// 4. Short-circuit — refuse, and nothing downstream runs
events.on('agent/pre-step', async (decision, next) => {
  if (overBudget()) return { kind: 'reject', reason: 'Token budget exhausted.' };
  return next();
});
```

Option 4 is why this is not just a middleware array. A listener can end the chain, and the loop honours it.

**Serial events** are the simpler sibling: every listener runs, in order, none can stop the others, and there is no `next()`. Use them for terminal checkpoints — `agent/turn-stopping` is serial because "the turn is ending" is not a decision anyone may veto, it is a last chance to act.

## The decision type

`agent/pre-step` carries the most interesting payload in the system, and its shape is worth copying:

```typescript
type StepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true };
```

A rejection closes the turn as **blocked with zero steps spent** — the case from [Part 2](/en/blog/building-agents/turn-and-step/) that only exists because turn and step are separate. The pre-step decision itself carries no free-form reason.

An `enter` carries the messages that will become the request. This is the compaction seat:

```typescript
events.on('agent/pre-step', async (decision, next) => {
  const result = await next();
  if (result.kind !== 'enter') return result;
  if (!overThreshold(log)) return result;
  await compact(log);
  return { ...result, messages: deriveMessages(log.read()) };
});
```

Compaction knows nothing about the loop. The loop knows nothing about compaction. Deleting the plugin removes the behaviour and nothing else.

## Preserve what you did not mean to change

One convention prevents a whole class of bug that is nearly invisible.

A listener that wraps `next()` gets a decision built by everything downstream. If it constructs a replacement from scratch, it silently discards their work:

```typescript
// Wrong — drops startsRequestSeries and any field added later
const result = await next();
return { kind: 'enter', messages: myMessages };

// Right — spread, then override only what you own
const result = await next();
return { ...result, messages: myMessages };
```

The first version is not obviously wrong when you write it, and the field it drops was probably added by a plugin loaded after yours. Symptom: a feature that works alone and stops working when another plugin is enabled. Nothing errors, nothing logs, and the bisect is painful because the culprit is the plugin that *still works*.

## Bridging to other processes

Users want hooks too — a shell command on every tool call, a script that vetoes writes to `main`. Same waterfall, one process boundary:

```typescript
events.on('tools/pre-execute', async (call, next) => {
  const hook = config.hooks?.[call.tool.name];
  if (!hook) return next();

  const proc = await execFile(hook.command, { input: JSON.stringify(call), timeout: 5_000 });
  const verdict = JSON.parse(proc.stdout) as { allow: boolean; reason?: string };

  return verdict.allow
    ? next()
    : { kind: 'reject', reason: verdict.reason ?? 'Blocked by hook.' };
});
```

The waterfall contract survives serialisation, which is the whole reason it works: observe, modify, reject are all expressible as JSON in and JSON out. Two details that are not optional — a **timeout**, because a hanging hook otherwise hangs the agent, and a rule for what a **crashed hook** means. Fail-open and a broken hook silently disables your policy; fail-closed and a typo bricks the agent. Pick deliberately, write it down.

## What the grown-up version looks like

DeepSeek Harness names its extension points and generates a catalog of them — every event, its family, its payload, its producers and consumers. The catalog is generated from the source and checked in CI, so an event added without documentation fails the build.

That sounds like process overhead. It is the difference between an extension surface and a set of hooks somebody happened to add: a plugin author can read one page and know every moment they can attach to, without reading the loop.

The turn flow from Part 2, annotated with families:

```text
turn/start                          durable
  agent/inbox/claimed               live
  agent/pre-step         waterfall  live      ← reject | enter
  step/start                        durable
  agent/request          waterfall  live      ← rewrite the outgoing request
  llm/stream             waterfall  live      ← wrap the stream
  assistant/chunk*                  durable
  tools/pre-execute      waterfall  capability
  tools/post-execute     waterfall  capability
  tool/result*                      durable
  step/end                          durable
  agent/turn-stopping    serial     live      ← terminal checkpoint
turn/end                            durable
```

Durable events are the transcript. Waterfalls are where behaviour attaches. One serial checkpoint at the end.

## The trap

The trap is a listener that forgets `next()`.

```typescript
events.on('agent/pre-step', async (decision, next) => {
  if (shouldLog(decision)) logger.info('step', decision);
  return decision;                              // ← should be next()
});
```

That is a logging hook. It also silently disables compaction, budget enforcement, and every other listener registered after it. No error. No warning. A feature simply stops existing, and the plugin that broke it is the one that looks most harmless.

Defences, in order of how much they help: make `next()` the only way to produce a return value in your types where the language allows it; log a warning in development when a chain returns without the tail running; and in review, treat *any* listener that returns without calling `next()` as a deliberate short-circuit that must say so in a comment.

## Next

**Part 15 — Who owns the agent.** The user closes the tab. What stops? What about the tool that is mid-run, and the subprocess it spawned? And who has the *right* to order the stop?
