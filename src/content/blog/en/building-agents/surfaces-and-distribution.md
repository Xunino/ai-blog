---
title: 'Surfaces: The Loop Must Not Know Who Is Watching'
description: 'Terminal, browser, JSON-RPC, webhook — one agent, four front doors. Then someone asks how to install it on a machine without Node.'
pubDate: 2026-10-01
tags: ['ai-agents', 'architecture', 'distribution']
translationKey: 'agents-26-surfaces'
sidebarTitle: '26 · Surfaces'
order: 26
---

The agent works in your terminal. Then:

- The team wants a web UI.
- Another team wants to call it from their service.
- Someone wants it to run on every pull request.
- An editor extension wants to drive it over a protocol.

Four surfaces. The wrong instinct is four codebases with a shared library. The right one starts with a question: **what does a surface actually need?**

Two things, it turns out. A way to *drive* the agent — send a message, cancel, read status. And a way to *watch* — see what happened, as it happens.

You built both already. Driving is [`ctx.agents` and the inbox](/en/blog/building-agents/the-inbox/). Watching is the [session event stream](/en/blog/building-agents/the-session-log/).

> The loop must not know who is watching. Every surface is a **consumer** of the same two APIs. A new surface is a new plugin, not a new branch.

## The rule, and how it breaks

The failure is small and it compounds:

```typescript
if (mode === 'cli') {
  process.stdout.write(chunk.text);           // ← the loop now knows
}
```

One conditional. Then the web surface needs its own, and the SDK needs a third, and now the loop has a `mode` parameter that every future surface must extend. Six months later there is no loop — there is a switch statement with a model call in it.

The correct shape is that surfaces subscribe:

```typescript
// The loop emits. It has no idea who is listening — or whether anyone is.
log.on('event', (e) => { /* nothing here knows about terminals */ });

// A CLI surface, as a plugin:
export const cliSurface: Plugin = {
  name: 'surface-cli',
  inject: ['agents', 'sessions'],
  apply(ctx) {
    ctx.effect(() => ctx.sessions.on('event', (e) => {
      if (e.kind === 'assistant/chunk') process.stdout.write(renderDelta(e.delta));
      if (e.kind === 'tool/call') process.stderr.write(dim(`  → ${e.name}\n`));
    }));
  },
};
```

Deleting that plugin removes the terminal output and nothing else. That is the test.

<figure class="dg">
  <img src="/diagrams/part26-surfaces-distribution.svg" alt="Every surface consumes the same two APIs, so a new surface is a plugin rather than a branch in the loop." loading="lazy" />
<figcaption><strong>One mode check in the loop is where this ends.</strong> The second is easier to justify than the first, and the fourth needs no justification at all.</figcaption>
</figure>

## Four shapes

They differ along one axis that matters more than transport: **who owns the lifecycle?**

That drives real decisions. Headless applies configuration once at startup, because nothing outlives the task. An interactive session can [hot-reload](/en/blog/building-agents/configuration-must-fail-loudly/) between turns. A server must not — it handed its lifecycle to a caller, and swapping dependencies under an in-flight session breaks a contract it already made.

The webhook one is the odd one and worth stating: **nobody is waiting.** No client to stream to, no user to ask for approval. So it needs a preset with `approval: never` and a tight sandbox, and its output goes somewhere durable — a PR comment, an issue — rather than to a connection.

## Streaming to a remote client

A local surface reads events from memory. A remote one needs them over a wire, and reconnection is the part people get wrong:

```typescript
// Client sends the last sequence it saw.
GET /sessions/:id/events?since=142

// Server replays from the log, then streams live. One code path.
async function* eventStream(id: SessionId, since: number) {
  for (const e of log.read().filter((e) => e.seq > since)) yield e;   // catch up
  yield* liveEvents(id);                                              // continue
}
```

Because the log is append-only with monotonic `seq`, catch-up and live are the same operation with a different starting point. A client that drops off for thirty seconds reconnects and misses nothing.

Try this without a durable log and you need a ring buffer, a replay window, and a policy for what happens when a client falls behind it — three problems that [Part 8](/en/blog/building-agents/the-session-log/) already solved.

## The host/client split

For a GUI, the browser cannot hold the agent — the agent needs a filesystem and subprocesses. So the split is forced, and the question is where.

The mistake is a thin API over the agent's internals: the browser learns about turns, steps, tool calls, and activation states, and every internal refactor becomes a client release.

Better: **the host exposes what a UI needs; the client renders it.**

```text
Host                                Client
  agents, tools, execution            render events
  session log (source of truth)       collect input
  ──── typed RPC + event stream ────► send messages
```

Which means each tool needs a *presentation contract* alongside its execution — how a call and its result should be displayed. Decide it when you add the tool, not when the UI team asks. A tool that renders as a wall of JSON is a tool nobody trusts.

## Composition, not forks

Surfaces share almost everything. Layers, from [Part 13](/en/blog/building-agents/plugins-and-capability-seams/):

```text
base bundle        tools, persistence, policy, adapters, session
  + surface        cli | web | sdk | acp | webhook
  + profile patch  this deployment
  + user patch     this machine
  + --patch        this invocation
```

Adding a surface is one bundle. Fixing a bug in the shared base fixes it everywhere at once, which is the entire point and is worth more than it sounds — the alternative is fixing the same bug four times and missing one.

## Getting it onto a machine

A tree of fifty plugin packages is not a product. Someone has to install it.

**One version line.** Every package ships together at the same version. Independent versioning of fifty packages produces a matrix nobody can support, and the first bug report will be a combination you never tested.

**Ship the runtime for people who do not have one.** A Python SDK whose users must install Node first will not be adopted. Package the runtime *inside* the wheel — a platform-specific artifact per OS and architecture — so `pip install` is the whole story.

**Native pieces are per-platform artifacts.** Sandbox backends need native code. Build them per platform, ship them prebuilt, and make a missing one a [loud failure](/en/blog/building-agents/configuration-must-fail-loudly/) that names the platform — not a silent fall-through to no sandboxing.

**Know your footprint.** Where does config live? Sessions? Cached indexes? Users will ask, and *"somewhere under your home directory"* is not an answer. One documented root, one command to show it, one to clear it.

**Say what it can do.** An agent that runs shell commands needs its limits published — what the sandbox does and does not contain, what runs without approval in each preset, what leaves the machine. Not legal boilerplate: the list a reviewer needs to decide whether to allow it at all.

## What the grown-up version looks like

DeepSeek Harness ships five profiles — `web`, `headless`, `sdk`, `sdk-minimal`, `acp` — over one `dsh-base` bundle, and enforces one rule that is worth copying outright:

> Every supported application starts at the `dsh` CLI with a named profile.

No package bins, no demo entry points, no inline plugin trees. There is a script in CI that classifies every executable in the repository and fails the build on a Node application path that bypasses the launcher.

That looks like bureaucracy and it is the thing that keeps the promise real. The moment one surface gets its own entry point, it starts accumulating its own initialisation, and the shared base stops being shared.

The Python SDK follows the same architecture: its wheel packages the normal CLI as a platform-specific runtime and launches `--profile sdk`. Python users get profile selection and patch files — not a different agent.

## The trap

The trap is one `if (mode === 'cli')`.

It is completely defensible in isolation. You need output now, the abstraction is not built, one conditional is honest, you will clean it up.

But it establishes that the loop is allowed to know about surfaces. The second one is easier to justify than the first, and the fourth needs no justification at all. By then, adding a surface means finding every conditional and adding a case — and missing one produces a surface that mostly works, which is the hardest kind of broken to notice.

The test is unchanged from Part 13: **can you delete a surface plugin and have everything else keep working?** If the loop imports anything surface-shaped, the answer is no.

## Next

**Part 27 — Testing nondeterminism.** How do you write a test for a system that gives different output for the same input, where every run costs money?
