---
title: 'Evals: Measuring What Tests Cannot'
description: 'Every snapshot is green and the agent solves fewer problems than last month. No test catches it, because no test asks whether it is any good.'
pubDate: 2026-10-03
tags: ['ai-agents', 'testing', 'operations']
translationKey: 'agents-28-evals'
sidebarTitle: '28 · Evals'
order: 28
---

The suite from [Part 27](/en/blog/building-agents/testing-nondeterminism/) is green. Every snapshot matches, every invariant holds, coverage is fine.

And the agent is worse. Users say so. It takes more turns to get to the same place, gives up on things it used to finish, and asks questions it used to answer.

Nothing is broken. Something is *worse*, and your entire test suite is structurally incapable of noticing, because every test asserts on behaviour you froze — and quality is not a behaviour you froze.

<figure class="dg">
  <img src="/diagrams/part28-evals-telemetry.svg" alt="Tests ask whether behaviour changed and need determinism; evals ask whether the agent is good and need repetition against a live model." loading="lazy" />
<figcaption><strong>An eval is a thermometer, not a target.</strong> The moment it becomes the goal it stops measuring what you built it to measure.</figcaption>
</figure>

## Two questions, two systems

> **Tests ask "did it change?"** and require determinism to be meaningful.
> **Evals ask "is it good?"** and require randomness to be meaningful.

Conflating them produces the two familiar failures. Snapshot tests against a live model: flaky, expensive, and every model release rewrites your fixtures. Evals as a CI gate: a bill, a queue, and a *pass* that means nothing because one run of a stochastic system is not a measurement.

Build both. Neither substitutes for the other.

## What an eval is made of

Three parts. Only the second one is hard.

**Tasks with checkable outcomes.** Not "write good code" — a task where success is a program's verdict:

```typescript
interface EvalTask {
  id: string;
  prompt: string;
  fixture: string;                              // a repo snapshot to work in
  check(workspace: string): Promise<boolean>;   // deterministic
}

const tasks: EvalTask[] = [
  {
    id: 'fix-failing-test',
    prompt: 'The test suite is failing. Fix it.',
    fixture: 'fixtures/broken-parser',
    check: async (ws) => (await run('npm test', ws)).exitCode === 0,
  },
  {
    id: 'add-endpoint',
    prompt: 'Add DELETE /users/:id following the existing patterns.',
    fixture: 'fixtures/api-server',
    check: async (ws) => (await run('npm test -- delete-user', ws)).exitCode === 0,
  },
];
```

**Repetition.** One run is an anecdote. Three is a weak signal. Five is usable:

```typescript
async function evaluate(task: EvalTask, runs = 5): Promise<TaskResult> {
  const outcomes = await Promise.all(
    Array.from({ length: runs }, async () => {
      const ws = await materializeFixture(task.fixture);
      const agent = await createAgent({ workspace: ws });
      const start = Date.now();
      await agent.run(task.prompt);
      return {
        passed: await task.check(ws),
        cost: agent.metrics.costUsd,
        turns: agent.metrics.turns,
        ms: Date.now() - start,
      };
    }),
  );
  const passes = outcomes.filter((o) => o.passed).length;
  return {
    id: task.id,
    passRate: passes / runs,
    medianCost: median(outcomes.map((o) => o.cost)),
    costPerSolve: passes === 0 ? Infinity : sum(outcomes.map((o) => o.cost)) / passes,
  };
}
```

**Cost per solve.** The metric people forget, and the one that decides things. An agent that solves 90% at $0.40 and one that solves 95% at $2.10 are a real trade — and you cannot have that conversation without the number.

## Sourcing tasks that mean something

The temptation is to write tasks. Do not, mostly — you will write tasks you already know it handles.

**Mine your logs.** You have a [session log](/en/blog/building-agents/the-session-log/) of everything the agent has ever done. Find the sessions that went badly, turn them into tasks. These are, by construction, the failures you actually have.

**Mine your bug reports.** Every *"it did X when it should have done Y"* is an eval case with the check already written by the reporter.

**Keep a holdout.** Split into a set you iterate against and a set you touch only to report. Without the split you will hill-climb into the training set — improving the number and not the agent, which is worse than no measurement because it is confidently wrong.

## Where public benchmarks fit

SWE-bench Verified, Terminal-Bench, Aider's polyglot leaderboard. They are useful and they are not your eval.

**Use them for:** choosing a model to start with; sanity-checking that your harness is not far off what a bare model achieves; comparing [edit formats](/en/blog/building-agents/how-an-agent-changes-your-code/), where the published spread between formats on one model is routinely larger than the spread between models.

**Do not use them for:** deciding whether *your* agent improved. Their tasks are not your tasks, their repos are not your repos, and a benchmark that has circulated for two years has leaked into training data in ways nobody can quantify.

The transferable part of a public benchmark is its *methodology* — how it defines a task, how it checks success, how it reports variance. Copy that; measure your own.

## Hill-climbing without fooling yourself

Once you have a number people will try to move it. Four rules keep that honest.

**Change one thing.** Prompt, model, edit format, tool set — one per run. Two changes and a 4% improvement tells you nothing about which one to keep.

**Report the interval, not the point.** Five runs of a 70%-pass task can land anywhere from 40% to 100%. A 4-point "improvement" inside that spread is noise wearing a decimal point.

**Watch cost alongside pass rate.** An improvement that doubles spend is a decision, not a win. Present both, always, in the same table.

**Log the config with every result.** Six weeks later "why is this at 82% when it was 88%?" is unanswerable without the model version, prompt hash, and tool set that produced each number.

## Evals for behaviour, not just outcomes

Not everything reduces to a passing test. Two more kinds are worth building.

**Trajectory checks** assert on the [event sequence](/en/blog/building-agents/testing-nondeterminism/) rather than the outcome: *did it read before editing? did it stay under the step budget? did it avoid the denied tool?* These reuse the machinery from Part 27, run against a live model, and catch process regressions that a passing test hides.

**Refusal and safety cases** belong here too — an eval set of [injection payloads](/en/blog/building-agents/what-it-reads-is-not-an-order/) where success means *not* complying. That number should be tracked like any other, and it should be the one that blocks a release.

## What the grown-up version looks like

Honest note: DeepSeek Harness has no eval package. Neither do most agent repositories, including good ones. Snapshot testing gets built because regressions are loud; evals do not, because quality decay is quiet.

So the practice to copy is not from a repository — it is the discipline itself:

**Run evals before a change lands, not on every commit.** They gate model upgrades, prompt rewrites, tool changes. Not typo fixes.

**Publish the number internally.** A pass rate on a wall creates a conversation about quality that otherwise never happens.

**Version the eval set.** Adding tasks changes the number for reasons unrelated to the agent. Tag the set; report the tag.

## The trap

The trap is optimising the benchmark.

It happens without anyone deciding to. The number exists, moving it feels like progress, and the fastest way to move it is to make the agent better at *those tasks*. Add a prompt hint that helps three of the twenty. Special-case a tool for a pattern that only appears in the fixtures. The number rises. Nothing improved.

An eval is a **thermometer, not a target**. The moment it becomes the goal it stops measuring what it was built to measure — Goodhart's law, arriving on schedule.

The defence is the holdout set and the habit of asking, for every change that moved the number: *would this help a user whose task is not in the set?* If you cannot answer yes, you tuned the thermometer.

## Next

**Part 29 — Running it for real.** It works. Now it runs for five hundred people, and someone asks what it cost this month and where the money went.
