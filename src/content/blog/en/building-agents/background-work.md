---
title: 'When a Tool Outlives Its Step'
description: 'The build takes eight minutes. The model should not wait, and must not forget. And if the session closes while it is still running?'
pubDate: 2026-09-25
tags: ['ai-agents', 'architecture', 'lifecycle']
translationKey: 'agents-20-jobs'
sidebarTitle: '20 · Background work'
order: 20
---

```text
> npm run build
[ ...8 minutes... ]
```

Everything is blocked. The model is holding a step open, the turn cannot close, the user's messages queue behind it, and the whole system is waiting on a subprocess that does not need supervision.

The naive fixes are both bad. Spawning detached and returning immediately means the output goes nowhere and nobody notices when it fails. Raising the timeout means the same problem with a bigger number.

What you want is for the work to leave the step but stay accountable.

<figure class="dg">
  <img src="/diagrams/part20-background-work.svg" alt="A background job leaves the step immediately, and its done promise resolves only after the producer released every resource it held." loading="lazy" />
<figcaption><strong>Resolve on the contract, not on the visible work.</strong> Otherwise teardown races cleanup and a test worker keeps the port your next run needs.</figcaption>
</figure>

## The split

> Separate **identity and lifecycle** — which the runtime owns — from **execution resources**, which the producer owns.

The runtime knows there is a job called `bash-3`, who owns it, whether it is running, and how to ask it to stop. It does not know it is a subprocess. The producer knows about the subprocess, its pipes, and its process group. It does not know about ids or access control.

```typescript
type JobId = string;                    // `${kind}-${n}` — readable in a transcript
type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

interface JobStart {
  kind: string;                         // 'bash' | 'subagent' | ... — also the id prefix
  label: string;                        // one line, model-facing: the command, the task
  owner?: Agent;                        // omit for an unowned job
  outputLimitBytes?: number;
  /** Called once, AFTER preflight. Returns hooks; must not throw after starting work. */
  run(): JobHooks;
}

interface JobHooks {
  /** Resolves after the producer has RELEASED ITS RESOURCES — not when work ends. */
  done: Promise<JobOutcome>;
  cancel(reason: string): void;
  /** Present only for jobs whose output can be read incrementally. */
  readOutput?(opts: { since?: number }): Promise<string>;
}
```

Two contracts in there are the whole post.

## `done` means released, not finished

```typescript
// Wrong: resolves when the process exits.
done: new Promise((r) => child.on('exit', r));

// Right: resolves when everything this job held is gone.
done: (async () => {
  const [code] = await once(child, 'exit');
  await drainStreams(child);        // stdout/stderr fully consumed
  await killProcessGroup(child);    // orphaned grandchildren reaped
  await tmp.cleanup();              // scratch files removed
  return { status: code === 0 ? 'completed' : 'failed', exitCode: code };
})();
```

Get this wrong and teardown races cleanup. The agent is disposed, `done` has resolved, everything looks quiescent — and a `vitest` worker the build spawned is still holding port 5173, which the next session needs.

Same shape as the [publication boundary](/en/blog/building-agents/who-owns-the-agent/) in Part 15: the promise resolves when the *contract* is complete, not when the visible work stops.

## Preflight before commit

The registry must finish everything that can fail **before** calling `run()`:

```typescript
async function start(spec: JobStart): Promise<JobId> {
  // Everything failable happens here — before any resource exists.
  const id = allocateId(spec.kind);
  assertCanStart(spec.owner);
  const record = { id, kind: spec.kind, label: spec.label, owner: spec.owner?.id };

  // Commit. run() is called once and its hooks are retained.
  const hooks = spec.run();          // throws → nothing was registered
  jobs.set(id, { ...record, hooks, status: 'running' });

  void hooks.done.then((o) => finalize(id, o), (e) => finalize(id, { status: 'failed', error: e }));
  return id;
}
```

If `run()` throws, nothing is registered and the producer is responsible for cleaning up whatever it partially started. If it returns, the job exists and the runtime owns its lifecycle. There is no failable step *after* the commit — otherwise you get a registered job whose resources were never created, and nothing can ever finish it.

## Owner fencing

Every job has an owner, and access is checked against it:

```typescript
function authorize(id: JobId, caller: Agent): JobRecord {
  const job = jobs.get(id);
  if (!job) throw new JobError(`no such job: ${id}`);
  if (job.owner !== undefined && job.owner !== caller.id) {
    throw new JobError(`job ${id} belongs to another agent`);
  }
  return job;
}
```

> Access is fenced by **owner**, not by the secrecy of the id.

Ids are `bash-3`. They appear in transcripts, in logs, in the model's context. They are guessable by construction, so they cannot be the security boundary. This is the same lesson as [the disposer being a capability](/en/blog/building-agents/who-owns-the-agent/) — authority comes from a relationship you can check, never from knowing a name.

An **unowned** job is deliberately available: a warm-up task started before any agent exists. Unowned means anyone may control it, which is a real choice and should read as one at the call site.

And the coupling that prevents leaks: **disposing an agent cancels and awaits its jobs.** It goes in the teardown from Part 15, before `whenIdle`.

## The model's side

Three tools, and the shape of the first one is the point:

```typescript
{
  name: 'bash',
  inputSchema: { /* command, run_in_background?: boolean */ },
  async execute({ command, run_in_background }, ctx) {
    if (!run_in_background) return shell.run({ command });   // unchanged path

    const id = await ctx.jobs.start({
      kind: 'bash',
      label: command,
      owner: ctx.agent,
      outputLimitBytes: 20_000,
      run: () => spawnBackgroundShell(command),
    });
    return `Started background job ${id}. Collect with job_output({ id }), stop with job_kill({ id }).`;
  },
}
```

Foreground remains the default. Background is a flag, and the result is an id plus instructions — the model needs to be told how to get back to it, in the result, every time.

`job_output` returns bounded output with a marker when truncated (the [spill discipline](/en/blog/building-agents/the-context-budget/) again: an eight-minute build produces megabytes, and dumping them defeats the purpose of getting the work off the step). `job_kill` requests a stop and returns when the request is accepted, not when the process is gone.

## Telling the model it finished

A job completing while the agent is idle needs to reach it. Use the [inbox](/en/blog/building-agents/the-inbox/) — this is exactly the case it was built for:

```typescript
function onJobSettled(job: JobRecord, outcome: JobOutcome) {
  const owner = agents.get(job.owner!);
  if (!owner) return;                      // no owner alive: the record is enough

  const notice = `Background job ${job.id} (${job.label}) ${outcome.status}.` +
    (outcome.summary ? `\n${outcome.summary}` : '');

  owner.send({ role: 'user', content: [{ type: 'text', text: notice }] }, {
    boundary: 'next-turn',
    wake: owner.status === 'idle',         // idle → start a turn; busy → ride along
    source: { kind: 'job-settled', jobId: job.id },
  });
}
```

Two decisions worth copying. `wake` depends on whether the agent is idle — waking a busy agent is pointless, since it will claim the message at its next boundary anyway. And `source` marks it as a runtime notice, so a transcript never renders it as something the user said.

## What the grown-up version looks like

DeepSeek Harness has a generic `jobs` package with a merge-extensible `JobKind` map, and the interesting part is who uses it: `bash` is one producer, and **one-shot background subagents are another**. Delegation did not build its own background machinery — it registered as a producer of this one.

That is the test of whether the seam is real. If your second long-running feature reuses the job runtime instead of inventing a parallel one, the split between identity and resources was drawn in the right place.

Two more details: `JobStatus` stays a small closed vocabulary with producer-specific facts in `detail`, so consumers can branch on status without knowing every producer. And `readOutput` is optional — it distinguishes streaming jobs you can poll from final-output-only jobs, rather than forcing every producer to fake a stream.

## The trap

The trap is letting the model manage background processes itself.

It is the obvious shortcut: give it `bash`, let it write `npm run build &`, let it track the PID. It even works in a demo.

Then nothing fences access — any agent can `kill` any PID it can read. Nothing reaps on teardown — session ends, build keeps running, port stays held. Nothing tells the model it finished — it must remember to poll, and it will not. And the model is now doing process management with a text interface, which it is bad at.

The job runtime is not ceremony over `&`. It is the ownership, the notification, and the teardown coupling — the three things `&` does not have.

## Next

**Part 21 — Delegation.** A subtask eats forty turns of exploration, and every one of them lands in the main conversation.
