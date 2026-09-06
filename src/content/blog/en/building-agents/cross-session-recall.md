---
title: 'Recall Across Sessions'
description: 'You fixed this bug last week — how? That conversation is closed, compacted, and in a different session. Your log has the answer and nothing can reach it.'
pubDate: 2026-09-17
tags: ['ai-agents', 'architecture', 'persistence']
translationKey: 'agents-12-recall'
sidebarTitle: '12 · Recall'
order: 12
---

*"You fixed this exact error last Tuesday. What did you do?"*

Everything needed to answer is on disk. [Part 8](/en/blog/building-agents/the-session-log/) made sure of that — every message, every tool call, every result, in an append-only log. And the agent cannot reach a single byte of it, because the only thing it can see is the conversation it is currently in.

Note this is not the [context budget problem](/en/blog/building-agents/the-context-budget/). That one is about the window overflowing *now*. This one is about the past being unreachable *at all*. They pull in opposite directions, which is exactly why they need separating.

<figure class="dg">
  <img src="/diagrams/part12-cross-session-recall.svg" alt="Compaction shrinks the working context while the durable corpus keeps everything; retrieval must read the corpus, never the projection." loading="lazy" />
<figcaption><strong>Compaction destroys active context. It must never destroy the record.</strong> Recall reads the log — always the log, never the projection.</figcaption>
</figure>

## The line

> Compaction destroys **active context**. It must never destroy the **record**. Recall reads the durable corpus, and its answers do not depend on how far the current session has been compacted.

If retrieval reads the working context it degrades exactly when it is most needed. It has to read the log.

## The corpus is live-preferred

The first design decision, and the one people skip.

Sessions come in two states: **live** (in memory, being written to right now) and **cold** (on disk, nobody home). Query both, and prefer the live copy where it exists:

```typescript
async function corpus(): Promise<SessionHandle[]> {
  const live = sessions.all();                    // in-memory registry
  const stored = await persistence.list();        // on disk
  const seen = new Set(live.map((s) => s.id));
  return [...live, ...stored.filter((s) => !seen.has(s.id))];
}
```

Cheap and correct: the live copy is never stale, and a session written five seconds ago is findable before anything flushed. Query only the disk and a user asking about a parallel session gets "no results" for a conversation happening right now.

## Four questions, not one

"Search" is a bad primitive because it collapses four different needs. Ship them separately:

**Exact read** — *"show me turn 12 of session X."* No search, no ranking. Bounded by a range, because a session can be enormous.

**Filtered list** — *"sessions in this workspace, last 7 days, that touched `auth.ts`."* Metadata, not content. Fast, and usually the right first move.

**Lineage trace** — *"what did this session fork from, and what forked from it?"* Pure structure, from the `parentSession` header. Answers "where did this state come from", which is the question during an incident.

**Full-text search** — *"which session mentions `ECONNRESET`?"* The expensive one. Needs an index.

```typescript
interface SessionQuery {
  read(id: SessionId, range?: { from: number; to: number }): Promise<SessionEvent[]>;
  list(filter: { workspace?: string; since?: Date; touchedPath?: string }): Promise<SessionMeta[]>;
  trace(id: SessionId): Promise<{ ancestors: SessionId[]; descendants: SessionId[] }>;
  search(q: string, opts?: { limit?: number }): Promise<SearchHit[]>;
}
```

Most real questions are answered by `list` + `read`. Build search last; it is the piece with an index to maintain and it is the piece users reach for least once the other three exist.

## Search is opt-in

An index costs disk, write latency on every append, and a build step. Plenty of deployments do not want it — and should still get exact reads, listing, and lineage.

So make it a policy, not a feature flag that disables the service:

```typescript
type IndexPolicy = 'never' | 'first-search' | 'startup';
```

With `never`, the service stays mounted, `read`/`list`/`trace` work normally, and `search` fails with a specific, honest error — `SEARCH_DISABLED`, not an empty result set. An empty result set is a lie: it says "nothing matched" when the truth is "nobody looked".

`first-search` is the good default. No cost until someone actually searches, then build once and keep it warm.

## Giving it to the model

Three tools, mapping to the questions above:

```typescript
{
  name: 'search_history',
  description:
    'Search your own past sessions by content. Use when the user refers to earlier work ' +
    '("last time", "we fixed this before") or when you suspect this problem was solved already. ' +
    'Returns matching sessions with snippets; use read_history to read one in full.',
  inputSchema: { /* query, limit */ },
}
```

Two things in that description are doing real work, and both are lessons from [Part 11](/en/blog/building-agents/skills-knowledge-on-demand/).

*"your own past sessions"* — the model needs to know this is memory, not the internet. Without it you get web searches for internal error strings.

*The trigger phrases.* "Last time", "we fixed this before". Retrieval that never fires is retrieval you did not build.

And the results must be **bounded and referenced**, never dumped:

```typescript
async execute({ query, limit = 5 }) {
  const hits = await sessionQuery.search(query, { limit });
  if (hits.length === 0) return `No past sessions match "${query}".`;
  return hits.map((h) =>
    `session ${h.sessionId} · ${h.title} · ${fmt(h.at)}\n` +
    `  …${h.snippet}…\n` +
    `  read_history({ session: "${h.sessionId}", from: ${h.seq - 5}, to: ${h.seq + 15} })`
  ).join('\n\n');
}
```

Snippets and a follow-up call — the [spill pattern](/en/blog/building-agents/the-context-budget/) again. A search that returns five full sessions has spent your window to save it.

## The privacy question is not optional

Cross-session recall means session A can read session B. State the rule before you ship, because the default is whatever your code happens to do:

- Same user, same workspace — usually fine.
- Same user, different workspace — probably not. Client work should not leak into the other client's session.
- Different user — never, without an explicit, audited grant.

The scope belongs in the query layer, not in the tool's prompt. A model instructed not to search other workspaces will mostly comply; a query that cannot see them will always comply.

## This is not RAG

They look alike — both retrieve text and put it in context — and conflating them produces a system that does neither well.

| | Session recall | RAG |
|---|---|---|
| Corpus | the agent's own history | documents someone curated |
| Written by | the agent, as a side effect | an ingestion pipeline |
| Grows | every turn, forever | when someone publishes |
| Question | "what did *I* do?" | "what does the *documentation* say?" |
| Trust | first-party, already in your log | external content, [untrusted](/en/blog/building-agents/what-it-reads-is-not-an-order/) |

Session recall is memory. RAG is a lookup tool — one more entry in [the registry](/en/blog/building-agents/tools-registry-schema-pipeline/), with an embedding store behind it. Build them separately. The lifetimes, the trust model, and the failure modes have nothing in common.

## What the grown-up version looks like

DeepSeek Harness has a `session-query` group with exactly this shape: one unified service over live and durable sessions, exact reads, filtered lists, relationship traces, semantic filtering, and SQLite full-text search behind a policy.

Two details worth copying.

**The default composition mounts it with `openAt: 'never'`.** The service is present; the index is not opened. Exact reads, titles, and lineage all work — those are needed by session export and by fork inheritance — while search returns a specific disabled error and SQLite is never touched. Deployments that want content search override the policy in a patch layer.

**The model-facing tools are `session_event_read`, `session_event_search`, `session_event_trace`.** Named after the four questions, not merged into one `search` that tries to guess which you meant.

## The trap

The trap is making recall depend on the current session's state.

It happens naturally: you already have `deriveMessages`, so search reaches for the derived history because it is right there. Then compaction runs, the history shrinks, and search quietly stops finding things that are still on disk.

The symptom is brutal to debug, because it is *correct early and wrong late*. It works in every test, works in short sessions, and fails in the long conversations where recall is the whole point.

Recall reads the log. Always the log — never the projection.

## Next

**Part 13 — Plugins and capability seams.** Someone asks for tools to run in a remote sandbox instead of on this machine. Count how many files you have to change. The answer tells you whether you have an architecture.
