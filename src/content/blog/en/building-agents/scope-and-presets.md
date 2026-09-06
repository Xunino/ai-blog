---
title: 'Scope: One Process, Different Powers'
description: 'One session needs full access. Another, in the same process, must be read-only. A hidden tool the model can still call is a hole, not a policy.'
pubDate: 2026-09-21
tags: ['ai-agents', 'architecture', 'security']
translationKey: 'agents-16-scope'
sidebarTitle: '16 · Scope'
order: 16
---

Two sessions, one process.

Session A is you, in your own repository, with everything enabled. Session B was started by a webhook from a pull request on a fork — it should read, analyse, comment, and touch nothing.

Every registry so far has been global. `registry.register(bashTool)` puts `bash` in *the* registry, and there is only one. Session B can call it.

The reflex fix is a check inside the tool:

```typescript
execute(input, ctx) {
  if (ctx.session.readOnly) throw new Error('read-only session');
  return shell.run(input.command);
}
```

This is wrong in a way worth being precise about, because it looks like it works.

## Two visibilities, one hole

With the check inside the tool, `bash` is **still in the prompt** for session B. The model sees it, believes it can run commands, plans a sequence that involves running commands, calls it, and gets an error. Then it tries again with different arguments, because a rejection reads like a bad call rather than a closed door.

You have not built a policy. You have built an agent that wastes turns discovering its own limits, one refusal at a time.

> A restricted tool must **vanish from the prompt and refuse to execute**. One visibility. Anything else is either a lie to the model or a hole in the policy.

The two halves fail differently and both are real:

- **Hidden but callable.** The model does not see it in the schema list — and can still name it, because tool names are guessable and appear in earlier transcripts. A `bash` that runs when asked directly is not restricted.
- **Visible but refusing.** No security hole, but the model burns turns and produces worse plans, having reasoned about capabilities it does not have.

<figure class="dg">
  <img src="/diagrams/part16-scope-presets.svg" alt="Prompt assembly and execution both resolve through one filtered view, so a restricted tool cannot be visible in one and callable in the other." loading="lazy" />
<figcaption><strong>One visibility.</strong> Hidden-but-callable is a hole; visible-but-refusing burns turns. Both halves come from the same function.</figcaption>
</figure>

## Scoped registries

The fix is that lookup depends on who is asking:

```typescript
interface ToolRestriction {
  allow?: string[];    // only these
  deny?: string[];     // everything except these
}

class ToolRegistry {
  private global = new Map<string, ToolDefinition>();
  private scoped = new WeakMap<Context, Map<string, ToolDefinition>>();
  private restrictions = new WeakMap<Context, ToolRestriction>();

  /** Registration goes to the scope you register from. */
  register(tool: ToolDefinition, scope?: Context): Disposer {
    const target = scope ? this.scopedMap(scope) : this.global;
    if (target.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    target.set(tool.name, tool);
    return () => target.delete(tool.name);
  }

  /** ONE resolution path. Schema generation and execution both call this. */
  visible(scope: Context): ToolDefinition[] {
    const merged = new Map([...this.global, ...(this.scoped.get(scope) ?? [])]);
    const r = this.restrictions.get(scope);
    return [...merged.values()].filter((t) => {
      if (r?.allow && !r.allow.includes(t.name)) return false;
      if (r?.deny?.includes(t.name)) return false;
      return true;
    });
  }

  get(name: string, scope: Context): ToolDefinition | undefined {
    return this.visible(scope).find((t) => t.name === name);
  }
}
```

The design is one line: **`get` is implemented in terms of `visible`.** Both prompt assembly and execution go through the same filter, so they cannot disagree. A separate `has()` that skipped the restriction check would reintroduce the hole in one commit.

And `restrict` validates eagerly:

```typescript
restrict(scope: Context, r: ToolRestriction): Disposer {
  const known = new Set([...this.global.keys(), ...(this.scoped.get(scope)?.keys() ?? [])]);
  for (const name of [...(r.allow ?? []), ...(r.deny ?? [])]) {
    if (!known.has(name)) throw new Error(`restrict: no such tool "${name}"`);
  }
  this.restrictions.set(scope, r);
  return () => this.restrictions.delete(scope);
}
```

A typo in a deny list must fail at composition time. Silently ignoring `denny: ['bash']` produces a session that believes it is restricted and is not — the worst possible outcome, and the whole subject of [Part 17](/en/blog/building-agents/configuration-must-fail-loudly/).

## Where the scope comes from

`agentCtx` from [Part 15](/en/blog/building-agents/who-owns-the-agent/) already is the scope. It exists per agent, and it unwinds on disposal — which means scoped registrations clean themselves up for free:

```typescript
await agents.create({
  sessionId,
  async setup(agentCtx) {
    if (untrusted) {
      ctx.tools.restrict(agentCtx, { deny: ['bash', 'write', 'edit', 'run_code'] });
    }
    ctx.tools.register(reviewCommentTool, agentCtx);   // this session only
  },
});
```

`setup` runs **before publication**, so the restriction is in place before the first prompt is assembled. There is no window where an unrestricted schema could be generated. That ordering is not incidental — it is why creation had to be a transaction.

## Personas shadow, they do not append

Same mechanism for prompt content. A child agent doing code review wants different instructions, not extra ones bolted on the end:

```typescript
systemPrompt.section({
  name: 'deployment:persona',
  order: ORDER.IDENTITY,
  text: () => 'You are a careful reviewer. Read and comment; never modify.',
}, agentCtx);   // scoped — shadows the global section of the same name
```

Same `name`, narrower scope, so it **replaces** rather than adds. That matters: appending gives you an agent told two things, and models resolve contradictions unpredictably. Shadowing gives it one identity.

The rule is worth stating because it is easy to get backwards: for **tools**, scoped registrations *merge* with global ones (a session can add capabilities). For **prompt sections**, scoped registrations *shadow* by name (a session can replace instructions). Merge for capabilities, shadow for identity.

## Presets

Agent compositions copied into every host drift. DeepSeek Harness gives each session one named preset directory whose `agent.cordis.yml` lists the plugins that session runs:

```yaml
presets:
  standard:  # the normal shipped agent composition
  ptc:       # composition with programmatic tool calling
  minimal:   # deliberately smaller capability set
  cordis:    # plugin-development composition and skills
```

The shipped roster is not a permission ladder. A preset may contain tools, prompt sections, skills, and other plugins, and a user-authored preset is as trusted as the plugins it names.

Do not confuse agent presets with the separate **permission presets** from [Part 22](/en/blog/building-agents/approval-and-permissions/). Agent presets compose a session's plugin world. Permission presets bundle only sandbox mode and approval policy. Keeping those concepts separate prevents a friendly UI label from becoming an accidental authority claim.

## Visibility is not authority

Worth stating flatly, because it is the mistake that survives everything above.

> Removing a tool from the model's view is a **hint**. Refusing to execute it is **enforcement**. You need both, and only the second is load-bearing.

The model can name a tool it cannot see — from a transcript, from a compaction summary, from a user who mentions it. If your only defence is absence from the schema list, that guess succeeds.

Same principle one level down: hiding a *path* from a file-listing tool is not access control. The check belongs at the filesystem seam, where every consumer passes through. This is the same argument as sandboxing at the subprocess layer rather than per tool — [Part 18](/en/blog/building-agents/the-execution-world/).

## What the grown-up version looks like

DeepSeek Harness makes scope a primitive — a small package other packages build on, rather than a feature of the tool registry. Everything scope-aware uses the same mechanism, so there is one answer to "who can see this".

Two things worth stealing:

**Restrictions are validated loudly at composition.** An unknown name is an error at mount, not a silent no-op at runtime.

**Presets are `agent.cordis.yml` compositions, not code branches.** A preset can add plugins, prompt sections, tools, and skills. DeepSeek ships `standard`, `ptc`, `minimal`, and `cordis`; user presets are created by copying an existing preset into a trusted user root.

## The trap

The trap is hiding the tool and calling it done.

It is genuinely convincing: you filter the schema list, the model stops using the tool, your test passes. The gap is that the test asserts on typical behaviour, and the failure requires an atypical prompt — a user who names the tool, a summary that mentions it, a model that recalls it from earlier in the session.

Test the enforcement directly. Call the restricted tool by name, from inside a restricted scope, in a unit test. If it runs, you have documentation, not a policy.

## Next

**Part 17 — Configuration must fail loudly.** A composition file had one expression in the wrong place. Every filesystem tool disappeared. Nothing errored. The agent just became quietly useless, and it took a week to find out why.
