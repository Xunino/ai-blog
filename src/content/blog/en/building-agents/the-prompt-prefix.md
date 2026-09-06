---
title: 'The Prompt Is a Prefix, Not a String'
description: 'The bill tripled, latency doubled, traffic was flat. The culprit was one line: a timestamp at the top of the system prompt.'
pubDate: 2026-09-14
tags: ['ai-agents', 'llm', 'performance']
translationKey: 'agents-09-prompt-prefix'
sidebarTitle: '9 · Prompt & cache'
order: 9
---

Someone adds a helpful line to the system prompt:

```typescript
const system = `You are a coding assistant.
Current time: ${new Date().toISOString()}
Working directory: ${cwd}

${TOOL_GUIDANCE}
${PROJECT_INSTRUCTIONS}
...`;
```

Reasonable. The model should know what time it is.

Three weeks later the bill has tripled, p50 latency has roughly doubled, and traffic is flat. Nobody connects the two, because the change was one line and it did exactly what it said.

Here is what it actually did:

> Prompt caching is a **prefix match**. Any byte change anywhere in the prefix invalidates everything after it.

A timestamp at the top of the system prompt changes on every request. So the prefix differs on every request. So nothing after it can be reused — not the tool schemas, not the project instructions, not one token of the conversation. You are paying full price for the entire context, every single turn, for the rest of the session.

## Render order is the design

Everything before the last cache breakpoint is reused if it is byte-identical to the previous request. So the layout question is not "what should the prompt say" but **"what changes, and how often?"** — and volatile content belongs after the breakpoint, in the messages, where the model reads it just as well.

Fixing the opening example is a move, not a rewrite:

```typescript
// System: frozen. Cacheable.
system: [{ type: 'text', text: STABLE_SYSTEM, cache_control: { type: 'ephemeral' } }],

// Volatile facts ride with the turn.
messages: [
  ...history,
  { role: 'user', content: [
    { type: 'text', text: `<context>time: ${now} · cwd: ${cwd}</context>` },
    { type: 'text', text: userInput },
  ]},
],
```

Same information reaches the model. The prefix stops moving.

<figure class="dg">
  <img src="/diagrams/part09-prompt-prefix-cache.svg" alt="Render order is tools, then system, then messages; the cache breakpoint goes after the stable part, so volatile content must live in the messages." loading="lazy" />
<figcaption><strong>One line moved, the whole bill changes.</strong> The model reads the timestamp just as well from the messages — and the prefix stops moving.</figcaption>
</figure>

## Sections, so the order is not an accident

If the system prompt is a template literal, then adding to it means editing a string, and whoever edits it last decides the order. That is fine for one file and untenable once plugins contribute.

Make sections first-class:

```typescript
interface PromptSection {
  name: string;
  order: number;
  /** Called per request. MUST be stable unless something real changed. */
  text(ctx: RequestContext): string;
}

class SystemPrompt {
  private sections = new Map<string, PromptSection>();

  section(s: PromptSection): () => void {
    this.sections.set(s.name, s);
    return () => this.sections.delete(s.name);
  }

  render(ctx: RequestContext): string {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((s) => s.text(ctx))
      .filter((t) => t.length > 0)     // empty sections vanish entirely
      .join('\n\n');
  }
}
```

Three details that matter more than they look.

**Sort by `order`, tie-break by `name`.** Map iteration order is insertion order, and insertion order is plugin load order, which changes when someone reorders a config file. That would silently invalidate every cache in the system. A deterministic sort makes the rendered prompt a function of *content*, not of startup sequence.

**Empty sections disappear.** A section that has nothing to say returns `''` and contributes nothing — not even a blank line. Otherwise a feature toggling on and off shifts every byte after it.

**`section()` returns a disposer.** Same pattern as the tool registry. Contributions know how to remove themselves; that is [Part 13](/en/blog/building-agents/plugins-and-capability-seams/) again.

Now ordering is a declared property:

```typescript
const ORDER = { IDENTITY: 100, ENVIRONMENT: 200, TOOL_GUIDANCE: 300, PROJECT: 400, POLICY: 900 };
```

## Measure it, or you are guessing

Every response tells you whether caching worked. There is no reason to speculate:

```typescript
const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = response.usage;
const total = input_tokens + cache_read_input_tokens;
const hitRate = total === 0 ? 0 : cache_read_input_tokens / total;
console.log(`cache ${(hitRate * 100).toFixed(1)}%  (read ${cache_read_input_tokens}, fresh ${input_tokens})`);
```

Log it on every request. Alert when the session average drops. This one number is the difference between finding a cache regression in an afternoon and finding it in a quarterly invoice.

Expected shape: **first request in a session ~0%**, every request after **80–95%**. If turn 12 is at 20%, something in your prefix is moving.

The usual suspects, in the order I would check them:

| Symptom | Cause |
|---|---|
| 0% always | Prefix shorter than the minimum cacheable length, or no breakpoint set |
| Drops to 0% on some turns | Non-deterministic serialisation — unsorted object keys, a `Set` iterated into JSON |
| Slow decline over a session | A section whose text grows each turn (a running summary in the system prompt) |
| 0% after a tool toggles | Tool set changed — [MCP](/en/blog/building-agents/tools-from-outside-mcp/) servers connecting or dropping mid-session |
| 0% only in production | An environment-dependent value in the prefix: hostname, pod name, request id |

## What the prompt is actually made of

Worth an audit, because people optimise the part they wrote and ignore the part that is bigger.

The system prompt you typed is usually **not** the largest fixed cost. In a real agent the request preamble is dominated by **tool schemas** — twenty tools with proper descriptions and parameter docs is easily several thousand tokens, and it is on every request. That is what [Part 3](/en/blog/building-agents/tools-registry-schema-pipeline/) meant by *the description is code*: it is a permanent line item.

Which makes tool count a prompt-design decision. Two tools that do nearly the same thing cost you their combined schema forever *and* make the model hesitate between them. Merging them is a token saving and an accuracy improvement at once.

## Mid-conversation instructions

Eventually you want to change the rules mid-session — enter a restricted mode, add an operator instruction, tell it the user switched projects.

The obvious move is to edit `system` and re-send. That invalidates the entire prefix, on the most expensive turn possible, because by now the history is long.

On models that support it, append a `system`-role message to `messages` instead:

```typescript
messages: [
  ...history,
  { role: 'user', content: userInput },
  { role: 'system', content: 'Read-only mode: propose changes, do not write files.' },
],
```

It lands at the end of the prefix, so everything before it stays cached. It carries operator authority rather than arriving as user text — which matters for [Part 23](/en/blog/building-agents/what-it-reads-is-not-an-order/), where the distinction between *instruction* and *content* is the whole security model.

## What the grown-up version looks like

DeepSeek Harness assembles the prompt through a waterfall that plugins hook, and two conventions are worth stealing outright.

**Ordering constants are shared and named.** `getSectionOrder('TOOL_SUBAGENT')` rather than a magic number, so a plugin can place itself relative to others without knowing their internals.

**Every package README documents its "KV Cache effect".** A required section, next to what the feature does, stating in plain language what it costs the cache: *prefix-stable, written once* or *appends per turn* or *invalidates on toggle*.

That second one is the practice I would copy first. It makes cache impact a thing you declare at design time rather than discover from a graph, and it means a reviewer can catch a cache regression by reading a paragraph.

## The trap

The trap is thinking caching is the provider's concern.

It has the shape of an infrastructure feature — something that happens on their side, that you enable and forget. It is not. It is a **property of the byte layout you send**, and you control that layout completely. The provider is just doing prefix matching on what you hand it.

Which means the entire optimisation surface is in your code: what goes in the prompt, in what order, and how often each part changes. A team that treats it as infrastructure will keep adding volatile values to the top of the prompt, and every one of them costs the whole conversation.

## Next

**Part 10 — The context budget.** A `grep` returns 200KB and the conversation dies. Context is consumed by tool *results*, not by the model's own words — which means the place to manage it is where results are produced, not where the window runs out.
