---
title: 'Silent Capability Loss'
description: 'One expression in the wrong place. Every filesystem tool disappeared. Nothing errored — the agent just quietly became useless.'
pubDate: 2026-09-22
tags: ['ai-agents', 'architecture', 'operations']
translationKey: 'agents-17-config'
sidebarTitle: '17 · Config'
order: 17
---

This one is a postmortem, because the shape of the bug matters more than any API I could show you.

## What happened

A composition file wanted a plugin disabled under one condition. The config format supports embedded expressions, so someone wrote what you would write:

```yaml
- id: filesystem-tools
  name: '@scope/tool-fs'
  disabled: !!js 'ctx.mode === "restricted"'
```

The loader interpolates `!!js` expressions **inside a plugin's `config` block**. Not in entry-level metadata. `disabled` is entry-level metadata.

So `disabled` did not receive `false`. It received an unevaluated object — which is truthy. The plugin was disabled. Always. In every mode.

Nothing failed. The YAML parsed. The loader ran. The agent started, connected, answered questions. It simply had no `read`, no `write`, no `edit`, and no `glob`.

## What it looked like from outside

Not an outage. Reports over about a week, none of which named the cause:

- *"It keeps asking me to paste file contents instead of reading them."*
- *"It said it couldn't find the config file — I gave it the exact path."*
- *"Quality is way down since last week?"*

Every one of these is what a competent agent looks like when it has been quietly lobotomised. It does not announce a missing capability. It **works around it**, because working around obstacles is the thing it is good at. It asked users to paste files. It inferred contents from what it could see. It produced plausible answers from incomplete information, confidently, for a week.

The fix was one line. Finding it took most of that week, because there was nothing to search for. No error, no exception, no warning, no anomalous metric. The only artifact was a slow decline in a quality signal nobody was measuring precisely enough to alert on.

## Why this class is specific to agents

Ordinary software loses a capability loudly. A missing dependency throws at startup. A null service reference throws at first use. You get a stack trace and a line number.

An agent absorbs the loss:

> **Silent capability loss is the worst failure mode of an agent system.** No exception is thrown, because nothing threw. The model simply routes around the absence and produces a worse answer — and *producing an answer despite obstacles* is exactly the behaviour you selected for.

The absence is invisible on both sides. The system does not know a tool is missing — as far as the registry is concerned, nothing is wrong. The model does not know either — it never saw the tool, so it has nothing to miss. The only observer who could notice is the user, and what they observe is "it got worse", which is not a bug report you can act on.

## The rule

> Misconfiguration must fail **loudly**, at the **earliest point where it is resolvable**.

Two halves, and the second is where judgement lives.

**Loudly** means: refuse to start. Not a warning in a log that scrolls past during boot. Not degraded mode. Exit with a message naming the file, the line, and what was expected.

**Earliest resolvable** because not everything can be checked at load:

| Checkable at load | Checkable at first use |
|---|---|
| Unknown plugin name | Remote service unreachable |
| Unknown field in a config block | Credential rejected by the provider |
| Type mismatch | Model id refused by the adapter |
| Referenced tool that no plugin registers | Sandbox binary missing on this host |
| Expression in a slot that does not interpolate | Working directory deleted since startup |

Left column: fail at boot. Right column: fail at first use, with an error that names the config that caused it — not `ENOENT`, but `sandbox backend "bwrap" is configured but not installed`.

What is never acceptable is the middle path: notice something is wrong and continue with less.

<figure class="dg">
  <img src="/diagrams/part17-config-fail-loudly.svg" alt="Layers merge into one effective configuration; printing the merged tree with per-line provenance turns an incident into reading." loading="lazy" />
<figcaption><strong>Build this one thing.</strong> It costs an afternoon and turns "why is the agent worse?" into a line number.</figcaption>
</figure>

## Three mechanisms

**Validate the schema, reject unknown keys.**

```typescript
const EntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  disabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();          // ← the important word
```

`.strict()` is what turns `denny: ['bash']` into an error instead of a session that believes it is restricted. Every typo in a config key is a silent capability change waiting to happen; permissive parsing is how they all get through.

And validate the *slot*, not just the type. The bug above passed a boolean check would have caught it — but the real defence is knowing `disabled` does not interpolate and rejecting an unevaluated marker there specifically.

**Resolve references at load.**

```typescript
function verifyReferences(entries: Entry[], registry: PluginRegistry) {
  for (const e of entries) {
    if (!registry.has(e.name)) throw new ConfigError(`${e.id}: unknown plugin "${e.name}"`);
    for (const dep of registry.get(e.name).inject ?? []) {
      if (!provides(entries, dep)) {
        throw new ConfigError(`${e.id}: needs "${dep}", which nothing in this composition provides`);
      }
    }
  }
}
```

A plugin naming a provider that is not mounted is the load-time twin of the same bug: something the composition promised, silently absent.

**Make the merged tree printable.**

```bash
$ agent --dump-config
```

```yaml
- id: filesystem-tools          # base/cordis.yml:41
  name: '@scope/tool-fs'
  disabled: true                # ← profiles/restricted.patch.yml:12
```

This is the one that would have caught it in minutes. The layered composition from [Part 13](/en/blog/building-agents/plugins-and-capability-seams/) means the effective value of any row is the result of several files, and *which file won* is exactly the question you have during an incident. Print the merged tree with per-line provenance.

If you build one thing from this post, build this. It costs an afternoon and it converts "why is the agent worse?" from archaeology into reading.

## Introspection at runtime

`--dump-config` answers what was *configured*. A second question arrives during incidents: what is *actually mounted right now*?

They differ more than you would like — a plugin can be configured and fail to activate, or be mounted and have registered nothing.

```typescript
{
  name: 'inspect_runtime',
  description: 'List the plugins and services currently loaded, and the tools each registered.',
  async execute() {
    return JSON.stringify(runtime.plugins().map((p) => ({
      name: p.name,
      status: p.status,               // active | failed | disabled
      provides: p.services,
      tools: p.registeredTools,
    })), null, 2);
  },
}
```

Giving this to the *model* is not a gimmick. An agent that can answer "do I have a `write` tool?" can tell the user it is missing one, which is the single thing that would have shortened the week to an hour.

## Hot reload, and its boundary

Once configuration is layered data, reloading a patch layer without restarting becomes possible — and genuinely useful while composing.

The boundary is not optional:

> Reload what has **not yet been given away**. Never reload underneath an application that already owns work.

Concretely: a long-running interactive session can reload patch layers between turns. A one-shot runner, a stdio protocol server, an SDK server — these hand their lifecycle to a caller at startup, and replacing their dependencies mid-flight invalidates that contract. Those apply all layers once and stop watching.

That is a per-application decision, made deliberately, written down. Not a global toggle.

## What the grown-up version looks like

The postmortem above is from DeepSeek Harness — `docs/postmortem/0002-js-expression-disabled-filesystem-tools.md`. What is worth copying is that it *exists*: the incident produced a written record with the failure mode named, and the name is now shared vocabulary. "Silent capability loss" is something people can flag in review.

The structural defences that followed:

**`verify-cordis-config` is a CI gate.** Bare plugin names must appear in the resolver manifest's dependencies. A composition referencing something unresolvable fails the build, not the runtime.

**`--dump-config` prints the merged tree**, and the docs point at it as the first debugging step for anything composition-shaped.

**"Misconfiguration fails loud"** is written into the repository's conventions, alongside "never silently skip a missing referent". Not a lint rule — a rule reviewers apply.

## The trap

The trap is the safe fallback.

```typescript
const mode = config.sandboxMode ?? 'workspace-write';   // reasonable!
const tools = config.tools ?? [];                       // harmless!
const preset = presets[config.preset] ?? presets.normal; // sensible!
```

Every one of those is the bug. A typo'd `sandboxMode` silently gets the default. An unresolvable preset name silently gets `normal` — which may be *more* permissive than what was asked for, and the request for something stricter vanishes without trace.

Defaults are correct for **absent** values. They are wrong for **wrong** values:

```typescript
if ('sandboxMode' in config && !isValidMode(config.sandboxMode)) {
  throw new ConfigError(`sandboxMode: "${config.sandboxMode}" is not a mode`);
}
const mode = config.sandboxMode ?? 'workspace-write';
```

Absent means "you did not ask" — take the default. Present-but-invalid means "you asked for something that does not exist" — and continuing quietly is how a week disappears.

## Next

**Part 18 — The execution world.** The agent runs on your machine. Now it must run in a remote sandbox. Count the places you have to change — the number tells you whether Part 13 actually landed.
