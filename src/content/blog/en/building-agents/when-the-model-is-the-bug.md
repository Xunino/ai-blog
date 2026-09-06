---
title: 'When the Model Is the Bug'
description: 'Ninth identical grep. Nothing errored. The system is working perfectly and burning money perfectly — and no exception will ever tell you.'
pubDate: 2026-09-30
tags: ['ai-agents', 'operations', 'architecture']
translationKey: 'agents-25-guards'
sidebarTitle: '25 · Loop hygiene'
order: 25
---

```text
step 14  grep -rn "handleAuth" src/
step 15  grep -rn "handleAuth" src/
step 16  grep -rn "handleAuth" src/
```

Byte-identical, three times. It will do it six more.

Every layer you have built is behaving correctly. The tool runs, returns valid output, and the result reaches the model. No exception, no timeout, no error result, no anomalous metric. Your monitoring is green because nothing is broken.

> There is a class of failure that no error channel will ever surface: **the system is right and the model is wrong.**

Nothing you have built so far can see it, because everything you have built so far watches for *failures*, and this is not one. It needs its own mechanism.

## Two shapes

**Repetition** — the same call with the same input, the result not incorporated. Usually stuck between two hypotheses, or re-reading and hoping for different bytes.

**Hanging** — a tool that never returns. `npm install` behind a dead proxy; a subprocess waiting on stdin nobody will write.

Same visible symptom — busy, not progressing — and different fixes, which is why they are separate mechanisms.

<figure class="dg">
  <img src="/diagrams/part25-model-guards.svg" alt="DeepSeek ships an advisory repeat reminder and cooperative declared tool deadlines; a turn step budget remains a proposed extension." loading="lazy" />
<figcaption><strong>Advise early, enforce late.</strong> Blocking the second identical call breaks every legitimate poll, retry and wait.</figcaption>
</figure>

## Repetition: remind without vetoing

Hash the call, count the repeats:

```typescript
const seen = new Map<string, number>();
const key = (c: ToolCall) => `${c.name}:${stableStringify(c.input)}`;

ctx.events.on('tools/post-execute', async (call, next) => {
  const k = key(call);
  const n = (seen.get(k) ?? 0) + 1;
  seen.set(k, n);

  const result = await next();

  if ([3, 5, 8].includes(n)) {
    ctx.agent.send({ role: 'user', content: [{ type: 'text', text:
      `You have called ${call.name} with identical arguments ${n} times. ` +
      `The result will not change. Either use what it already returned, try a ` +
      `different approach, or tell the user what is blocking you.` }] },
      { boundary: 'next-step', wake: false, source: { kind: 'guard' } });
  }
  return result;
});
```

Three design choices worth defending.

**It runs the call anyway.** The reminder is advisory. Blocking the third identical call assumes repetition is always wrong, and it is not — polling a build, retrying a flaky network read, waiting for a file to appear are all legitimate. Advice preserves those; a block breaks them.

**It arrives as a message, not a tool error.** The model is not making a mistake it can fix by changing arguments. It needs a nudge about *strategy*, and strategy advice belongs in the conversation. Delivered with `wake: false` so it rides along with the next real step rather than costing a turn of its own — the [inject case](/en/blog/building-agents/the-inbox/) from Part 4.

**Three, not two.** Two identical calls is ordinary. The threshold has to sit above normal behaviour or the reminder becomes noise the model learns to ignore, which is the same failure as [prompt fatigue](/en/blog/building-agents/approval-and-permissions/) one layer down.

DeepSeek's implementation resets the chain when a new user prompt is admitted. Calls excluded from tracking are transparent rather than resetting it, and denied calls still count because detection happens in `tools/post-execute`.

## Hanging: a cooperative declared deadline

Only tools whose `ToolDefinition` declares `timeoutMs` get a deadline. The policy wraps `tools/execute`, derives a cancellation signal, and asks downstream work to stop:

```typescript
ctx.events.on('tools/execute', async (call, next) => {
  const ms = call.tool.timeoutMs;
  if (ms === undefined) return next();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DeadlineExceeded(ms)), ms);

  try {
    return await nextWithSignal(anySignal([call.signal, ctl.signal]));
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      return {
        isError: true,
        content: `Tool call timed out after ${ms}ms.`,
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
});
```

**This is cooperative, not a hard kill.** If downstream code ignores the signal, the wrapper remains inside `await next()` and cannot return a timeout result until that work eventually settles. Hard process-tree termination belongs to the capability implementation, not this generic policy.

**The message is for the model.** "Timeout" teaches it nothing. "Was stopped, may have been waiting for input, try a narrower scope" gives it three actionable hypotheses.

**Slow is not hung.** A deliberate `npm run build` legitimately takes eight minutes. That is what [background jobs](/en/blog/building-agents/background-work/) are for — the deadline is for work that should be fast and is not, not for work that is known to be long.

## Proposed extension: step budgets

Repetition detection catches identical calls. It misses the productive-looking wander: read this file, then that one, then another, forty steps deep, never converging.

A per-turn ceiling could catch it:

```typescript
ctx.events.on('agent/pre-step', async (decision, next) => {
  const n = ctx.turn.stepCount;
  const max = ctx.config.maxStepsPerTurn ?? 50;

  if (n >= max) {
    return { kind: 'reject',
      reason: `Step budget (${max}) exhausted. Summarise progress and stop.` };
  }
  if (n === Math.floor(max * 0.8)) {
    ctx.agent.inject(`You are at step ${n} of ${max} for this turn. Start converging: ` +
                     `finish what you can and report what remains.`);
  }
  return next();
});
```

The warning at 80% is the part that matters. A hard stop at the limit produces a turn that ends mid-thought with no summary. A warning first lets the model land the plane — and an agent that reports *"I have investigated four of six layers, here is what I found, here is what is left"* is far more useful than one that simply stops.

DeepSeek Harness explicitly lists **no built-in turn budget** as a current limitation of the agent loop. The existing `agent/turn-stopping` and `agent/pre-step` extension points are where a deployment-specific policy could implement one; it is not part of permission presets today.

## Making it visible

Guards produce a signal nothing else does. Log it:

```typescript
interface HygieneMetrics {
  repeatCallsDetected: number;
  deadlinesExceeded: number;
  stepBudgetsExhausted: number;
  wastedToolCalls: number;      // identical repeats — pure loss
}
```

`wastedToolCalls` is the honest one, and it is worth putting on a dashboard because it is *directly convertible to money*. A rise in it after a model change or a prompt edit is the fastest signal you have that something regressed in a way tests cannot catch.

## What the grown-up version looks like

DeepSeek Harness has a small `guard/` group with two shipped policies: a repeat-tool reminder and a cooperative `tools/execute` timeout wrapper. The group exists because the concern is genuinely distinct from everything around it.

The framing in its README is the thing to steal: guards keep the loop **productive**, which is a different job from keeping it **correct**. Correctness is tests, types, and error handling. Productivity is noticing that a correct system is going nowhere.

They are plugins. The reminder thresholds are configurable; the timeout comes from each tool definition. A hard repetition veto and a turn-wide step budget are not implemented.

## The trap

The trap is enforcing too early.

The reasoning is tempting: if two identical calls signal a loop, block the second and save the money. Then you break the agent polling a build, the one retrying a flaky fetch, the one waiting for a file a background job is writing. All legitimate, all now impossible.

**Advise first, enforce late.** A reminder at three costs a few tokens and preserves every legitimate pattern. A hard stop at fifty catches the genuine runaway. The gap between them is where real agents do real work, and narrowing it in the name of efficiency costs you more in broken workflows than it saves in tokens.

The other trap is the inverse: shipping without guards because the agent seems fine in testing. Your test sessions are short. Loops need length, ambiguity, and a task the model cannot quite solve — which is Tuesday afternoon in production.

## Next

**Part 26 — Surfaces and distribution.** The same agent has to run in a terminal, in a browser, behind JSON-RPC, and from a webhook. And then someone asks how to install it on a machine without Node.
