---
title: 'One Execution World'
description: 'Move the agent into a remote sandbox and count the edits. If bash, the file tools, the terminal and the LSP all follow one config change, Part 13 landed.'
pubDate: 2026-09-23
tags: ['ai-agents', 'architecture', 'security']
translationKey: 'agents-18-execution'
sidebarTitle: '18 · Execution'
order: 18
---

[Part 13](/en/blog/building-agents/plugins-and-capability-seams/) put `bash` behind a seam. Good. Now make the filesystem and process coordinates agree when execution moves off-host.

The agent reads files with `readFileSync`. It searches with `glob` over the local filesystem. It has a persistent terminal that spawned a `bash` process on this host. An LSP client talking to a `tsserver` started here. `run_code` executing in a local worker thread.

Move the execution to a remote sandbox and every one of those is a separate migration — unless they all sit on the same foundation.

## The unifying observation

> Filesystem and subprocess are two capability seams that must describe **one execution world**. Point both at the same provider substrate and their consumers see the same files and processes.

Most execution features compose from one or both seams. Point them at different places and you can get a language server analysing files that the file tools cannot see. One current exception is important: DeepSeek's shipped PTC code runtime is a local worker-thread capability, not an E2B code-runtime provider, so moving `fs` and `subprocess` does not automatically move model-written JavaScript.

<figure class="dg">
  <img src="/diagrams/part18-execution-world.svg" alt="Six consumers rest on two seams; wrapping the subprocess seam confines all of them at once." loading="lazy" />
<figcaption><strong>Two primitives, six consumers.</strong> The LSP row is the proof: a language server is a subprocess reading the same filesystem the agent does.</figcaption>
</figure>

## Two definitions

```typescript
export interface FileSystem {
  read(path: string, opts?: { encoding?: 'utf8' | 'binary' }): Promise<Uint8Array | string>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  list(dir: string): Promise<DirEntry[]>;
  glob(pattern: string, opts?: { cwd?: string }): Promise<string[]>;
}

export interface Subprocess {
  spawn(spec: SpawnSpec, signal: AbortSignal): Promise<ProcessHandle>;
}

export interface SpawnSpec {
  argv: string[];              // never a shell string — see below
  cwd?: string;
  env?: Record<string, string>;
  pty?: { cols: number; rows: number };
}

export interface ProcessHandle {
  readonly pid: number;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number; signal?: string }>;
  kill(signal?: NodeJS.Signals): void;
}
```

Two details in `SpawnSpec` that are load-bearing.

**`argv`, not a command string.** Shell interpretation belongs to whoever wants a shell — `bash` becomes `argv: ['bash', '-lc', command]`, explicitly. A seam that accepts strings has decided every implementation must have a shell and must quote identically, which is false for a remote runtime and false on Windows.

**`pty` is a spawn option, not a separate seam.** A terminal is a subprocess with a pseudo-terminal attached. Making it its own capability means every provider implements it twice.

## Reaping is the part that bites

The bug you will hit in week two, and it is worth pre-empting.

```typescript
const proc = await subprocess.spawn({ argv: ['bash', '-lc', 'npm test'] }, signal);
// ...
proc.kill('SIGTERM');
```

You killed `bash`. `npm` is still running. So is the `vitest` it spawned, and the four workers *it* spawned. They are now orphaned, holding the port your next test run needs.

> A tool spawns a **process tree**, not a process. Kill the tree.

```typescript
// POSIX: put the child in its own process group, then signal the group.
const child = spawn(argv[0], argv.slice(1), { detached: true });
const kill = (sig: NodeJS.Signals = 'SIGTERM') => {
  try { process.kill(-child.pid!, sig); } catch { /* already gone */ }
};

// Escalate — SIGTERM is a request, not a guarantee.
const killTree = async () => {
  kill('SIGTERM');
  const exited = await Promise.race([once(child, 'exit'), delay(5_000).then(() => null)]);
  if (exited === null) kill('SIGKILL');
};
```

This is provider-specific — process groups on POSIX, job objects on Windows, `docker kill` for a container, an API call for a remote runtime. Which is precisely why it belongs behind the seam and not in your `bash` tool.

## Sandbox at the subprocess layer

Now the security question, and the placement is the entire answer.

The tempting version puts confinement in the tool:

```typescript
// Wrong layer.
execute(input) {
  if (isDangerous(input.command)) throw new Error('blocked');
  return shell.run(input.command);
}
```

Every new tool that spawns anything is a new hole. `run_code` bypasses it. The LSP server bypasses it. A terminal session bypasses it. Six months later you have a security control with six known gaps and no list of them.

> Process confinement belongs at the **subprocess/shell boundary**; file confinement belongs at the **filesystem boundary**. Both resolve the same session sandbox policy.

```typescript
export const sandboxedSubprocess: Plugin = {
  name: 'subprocess-sandboxed',
  inject: ['subprocess', 'sandbox'],
  apply(ctx, config: { mode: SandboxMode }) {
    const inner = ctx.subprocess;
    ctx.effect(() => ctx.provide('subprocess', {
      spawn: (spec, signal) => inner.spawn(ctx.sandbox.wrap(spec, config.mode), signal),
    }));
  },
};
```

A decorator over the process seam can confine consumers that actually use it, such as shell, terminals, and stdio language servers. Filesystem tools need their own policy-enforcing provider. The worker-thread code runtime has a separate trust boundary and must not be counted as automatically confined by a subprocess wrapper.

The backends differ by platform and that is fine. DeepSeek Harness exposes a portable file-effect vocabulary while its providers own platform mechanics. The mode is the portable vocabulary:

```typescript
type SandboxMode =
  | 'read-only'         // no writes anywhere
  | 'workspace-write'   // writes confined to the workspace
  | 'danger-full'       // no confinement — explicit, named to be uncomfortable
```

`danger-full` is named that way on purpose. It appears in config files that people read.

## Where does the workspace live?

Once execution can be remote, "the working directory" needs an owner. Three things must agree, or the agent reads one tree and edits another:

- the filesystem provider's root
- the subprocess provider's `cwd`
- what the agent believes its workspace is

Make it one resolved value, produced once at composition and injected into both providers. A `cwd` that is separately configured in two places is a bug that manifests as an agent confidently editing a file that does not exist where it is running.

## Persistent terminals

Some work needs a session, not a command: a REPL, a dev server, an interactive prompt. Same subprocess seam, plus ownership and a buffer:

```typescript
interface Terminal {
  readonly id: TerminalId;
  write(data: string): void;
  read(opts?: { since?: number }): Promise<string>;   // from a ring buffer
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}
```

Two constraints that are not obvious until they hurt.

**Bounded buffer.** A dev server left running for an hour produces megabytes. Keep a ring buffer, expose `since` for incremental reads, and let the model page rather than dumping — the [spill discipline](/en/blog/building-agents/the-context-budget/) applies to terminals too.

**Owned by an agent, disposed with it.** A terminal is exactly the kind of resource [Part 15](/en/blog/building-agents/who-owns-the-agent/) is about. If it outlives its agent you have a shell running on a production host with nobody accountable for it.

## What the grown-up version looks like

DeepSeek Harness has separate package groups for `fs`, `subprocess`, `shell`, `terminal`, `sandbox`, `lsp` and `code-runtime` — and they layer:

```text
subprocess (seam)  ──┬── shell         (bash / pwsh)
                     ├── terminal      (PTY sessions)
                     └── lsp           (stdio language servers)
        ↑
     sandbox (wraps argv before spawning)

fs (seam)  ──┬── file tools (read / write / edit)
             └── discovery tools (glob / grep)

code-runtime (separate seam) ── run_code / PTC
```

And the E2B group is the payoff: a remote provider for **both** `fs` and `subprocess`. Mount those two rows and consumers of those seams move together. The separate code-runtime row stays where its own provider puts it.

That is the practical test of whether this post landed in your own system: **can you move filesystem and subprocess consumers off-host by changing two coordinated provider rows?** If every tool needs a fork, the seams are in the wrong place.

## The trap

The trap is putting the sandbox in the tool.

It is where the danger is *visible* — `bash` is obviously the risky one, so that is where the check goes. But visibility is not the right criterion; **choke points** are. The tool layer has as many entrances as you have tools, and it grows. The subprocess layer has one, and it does not.

The same reasoning covers path confinement: not in `read`, but at the filesystem seam, where `glob`, the LSP server and a future consumer you have not written all pass through.

## Next

**Part 19 — How an agent changes your code.** It edited fourteen files and broke the build. You want to go back. There is nothing to go back to, because it wrote straight to disk.
