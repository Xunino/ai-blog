---
title: 'Plugins and Capability Seams'
description: 'Run the tools in a remote sandbox instead of on this machine. Count how many files you have to change — the number tells you whether you have an architecture.'
pubDate: 2026-09-18
tags: ['ai-agents', 'architecture', 'plugins']
translationKey: 'agents-13-seams'
sidebarTitle: '13 · Seams'
order: 13
---

The request is one sentence: *run the tools in a remote sandbox instead of on this machine.*

Go and count the edits. In the system built so far: `run_command` calls `execSync` directly, `read_file` calls `readFileSync`, the spill store writes to a local path, and the working directory is a module-level constant. Four files, four different assumptions about where "here" is, and no single place that means *the machine work happens on*.

That count is the diagnostic. One edit means you have a seam. Four means you have four copies of a decision nobody wrote down.

## Three roles, or it is not a seam

The word "abstraction" is not enough here, because it does not say how many pieces there are.

> A **capability seam** has three roles: a **Service Definition** that declares the interface, a **Service Provider** that implements it, and a **Consumer** that uses it. One role alone is not a seam — it is an interface nobody swapped.

```text
Definition   interface Shell { run(spec): Promise<Result> }        ← contract only
Provider     LocalShell · SandboxedShell                           ← interchangeable
Consumer     the `bash` tool                                       ← knows the Definition only
```

The Consumer depends on the Definition, never on a Provider. That arrow is what makes swapping possible, and it is the one people break first — usually by importing a concrete class "just for a type". If you cannot name all three roles, you have not built a seam.

<figure class="dg">
  <img src="/diagrams/part13-plugins-seams.svg" alt="A seam has three roles: a Definition the Consumer depends on, and Providers that are interchangeable behind it." loading="lazy" />
<figcaption><strong>One role alone is not a seam.</strong> An interface with one implementation and a direct import is a seam the compiler would let you delete.</figcaption>
</figure>

## Registration is an effect

The other half of the pattern, and the half that is easy to miss because nothing forces it early.

> Every contribution returns its own undo.

You have seen this three times already without me naming it — `registry.register()` in Part 3, `systemPrompt.section()` in Part 9, `skills.register()` in Part 11. All three return a disposer. That was deliberate.

```typescript
type Disposer = () => void;

class Context {
  private disposers: Disposer[] = [];

  effect(setup: () => Disposer): void {
    this.disposers.push(setup());
  }

  dispose(): void {
    // Reverse order: last registered, first removed.
    for (const d of this.disposers.reverse()) d();
    this.disposers = [];
  }
}
```

A plugin is then a function that contributes through a context:

```typescript
export interface Plugin {
  name: string;
  /** Services this plugin needs before it can apply. */
  inject?: string[];
  apply(ctx: Context, config?: unknown): void;
}

export const bashTool: Plugin = {
  name: 'tool-bash',
  inject: ['tools', 'shell'],
  apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: 'bash',
      description: 'Run a shell command.',
      inputSchema: { /* ... */ },
      execute: (input) => ctx.shell.run({ command: input.command }),
    }));
  },
};
```

Read what that bought. The tool does not know whether `ctx.shell` runs with the local or sandboxed executor. Unloading the plugin removes the tool — from the registry, from the prompt, from the model's world — with no cleanup code anywhere else. And `inject` means load order is derived rather than maintained.

## The provider swap

Now the original request. Definition:

```typescript
export interface ShellSpec { command: string; cwd?: string; timeoutMs?: number }
export interface ShellResult { stdout: string; stderr: string; exitCode: number }

export interface Shell {
  run(spec: ShellSpec, signal: AbortSignal): Promise<ShellResult>;
}
```

Two providers, shown here as an illustrative local-to-container design rather than code copied from DeepSeek Harness:

```typescript
export const localShell: Plugin = {
  name: 'shell-local',
  apply(ctx) {
    ctx.effect(() => ctx.provide('shell', {
      run: (spec, signal) => execFile('bash', ['-lc', spec.command], { signal, cwd: spec.cwd }),
    }));
  },
};

export const dockerShell: Plugin = {
  name: 'shell-docker',
  apply(ctx, config: { image: string }) {
    ctx.effect(() => ctx.provide('shell', {
      run: (spec, signal) =>
        execFile('docker', ['run', '--rm', '-w', spec.cwd ?? '/w', config.image,
                            'bash', '-lc', spec.command], { signal }),
    }));
  },
};
```

And the composition is a list:

```yaml
plugins:
  - name: tools
  - name: shell-docker          # was: shell-local
    config: { image: 'node:22' }
  - name: tool-bash
```

One line. The tool did not change, the loop did not change, nothing that *uses* shell changed. That is what the four-file count was measuring.

## Profiles and layers

Once composition is data, you want variants — a headless runner, a web app, a test harness — that share most of a tree and differ at the edges. Copying the list per variant means fixing every bug five times.

Layers, applied in order, each patching the last:

```text
base bundle          the shared tree: tools, persistence, policy, adapters
  + app bundle       what this application adds (a server, a CLI, a protocol)
  + profile patch    what this deployment changes
  + user patch       what this machine changes
  + --patch overlay  what this invocation changes
```

A patch targets a row by id and replaces its config, or inserts a new row. So "the same agent, but in a remote execution world" is an overlay rather than a fork of the composition.

And one operational rule that pays for itself the first week: **make the merged tree printable.**

```bash
$ agent --dump-config
```

When someone asks why a tool is missing, the answer is in that output — which row disabled it, and which layer wrote that row. Without it, debugging composition is archaeology.

## When not to build a seam

This pattern is seductive and the cost is real: an interface, a registry, indirection at every call site, and a stack trace that goes through three files to reach the code that does the work.

> Extract a seam when you have **two real implementations**, or one and a concrete commitment to the second. Not before.

The honest sequence is: write it inline, write the second one inline too, watch what actually differs, *then* extract. The interface you get from two working implementations is right. The interface you get from imagining the second one is a shape you will fight for a year.

Signals you should have extracted already: the same conditional in more than two files; a function taking a `mode: 'local' | 'remote'` parameter; a test that needs a real subprocess because there is nothing to substitute.

## The coda: the agent modifying itself

Once composition is data and registration is reversible, one more thing becomes available, and it is worth knowing exists even if you never ship it.

In principle an agent could inspect its own plugin tree, define a plugin, mount it, use it, and unmount it within a session. DeepSeek Harness does not ship this as a normal model-facing capability; it is an architectural extrapolation from the same `ctx.effect` contract.

It is genuinely useful for exploration and it is a large hole in every boundary you have built, since a mounted plugin can register a pre-hook that neuters approval. If you build it, gate it behind a permission ([Part 22](/en/blog/building-agents/approval-and-permissions/)) and treat it as an admin feature.

## What the grown-up version looks like

DeepSeek Harness is built on Cordis and takes this further than most: **every part of the product is a plugin**, including the model adapter, the tool registry, the session log, and the agent loop itself. There is no privileged core — you extend it by mounting a plugin beside the others.

Two consequences worth stealing.

**The Definition/Provider/Consumer split shows up in package names.** `dsh-shell` is the Definition, `dsh-shell-local` a Provider, `dsh-tool-bash` a Consumer. Dependency direction is enforced by the package graph rather than by discipline — a Consumer that imports a Provider fails a check.

**Providers can be tiny.** The in-process subagent provider is 70 lines: a capability table and two calls into a shared driver. When your providers are that small, adding a backend stops being a project.

## The trap

The trap is building the seam before the second implementation.

The reasoning is always the same and always sounds prudent: we will surely need a remote executor eventually, so let us design for it now. Then the interface is shaped by imagination rather than by a second real caller. It has the wrong parameters, and the actual second implementation needs a field you did not add — so you widen the interface until it is the union of two concrete things with a general-sounding name.

Two implementations first. The seam falls out of the diff between them, and it is right the first time.

## Next

**Part 14 — Events and waterfalls.** You want compaction to run just before the request is built, without compaction knowing anything about the loop and without the loop knowing anything about compaction.
