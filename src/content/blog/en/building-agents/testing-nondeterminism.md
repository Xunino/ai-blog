---
title: 'Testing a System That Answers Differently Every Time'
description: 'Same input, different output, and every run costs money. Record once, replay without a key — and assert on the events, not the prose.'
pubDate: 2026-10-02
tags: ['ai-agents', 'testing', 'architecture']
translationKey: 'agents-27-testing'
sidebarTitle: '27 · Testing'
order: 27
---

Write a test for the agent.

Same prompt, different wording every run. Every run costs money and takes twenty seconds. Assert on the text and the test fails on a synonym. Assert on nothing and the test asserts nothing.

Most teams resolve this by testing the pieces — the projection, the pipeline, the inbox — and shipping the whole thing untested. Which means every bug that lives in the *interaction* between pieces reaches production, and that is where the interesting bugs live.

## Assert on the events, not the prose

The way through is a change of subject:

> The model's words are not your output. The **sequence of events your system produced** is your output — and that is deterministic given the same model responses.

Same prompt, two runs. The prose differs. This does not:

```text
turn/start
step/start
user/message
assistant/message      tool call: read_file
tool/call              read_file { path: "src/index.ts" }
tool/result            ok
step/end
step/start
assistant/message      text
step/end
turn/end               completed
```

That is a contract you can assert on: it read before answering, it took two steps, the turn closed as `completed`, no tool errored. All the things you actually care about — and none of them depend on how the model phrased anything.

<figure class="dg">
  <img src="/diagrams/part27-testing-nondeterminism.svg" alt="A recorder at the LLM seam captures real responses once; every later test replays them with no key and asserts on the event sequence." loading="lazy" />
<figcaption><strong>The recorder is also a cache-stability detector.</strong> If a volatile field forces you to widen the key, you have found a prefix invalidator.</figcaption>
</figure>

## Record once, replay forever

Put a recorder at the [LLM seam](/en/blog/building-agents/the-llm-layer/) from Part 5. Recording and replaying are two providers behind the same interface:

```typescript
export function recordingAdapter(inner: LlmAdapter, cassette: string): LlmAdapter {
  const entries: Recorded[] = [];
  return {
    provider: inner.provider,
    models: () => inner.models(),
    async *stream(req, signal) {
      const chunks: StreamChunk[] = [];
      for await (const c of inner.stream(req, signal)) { chunks.push(c); yield c; }
      entries.push({ key: requestKey(req), chunks });
      writeFileSync(cassette, JSON.stringify(entries, null, 2));
    },
  };
}

export function replayAdapter(cassette: string): LlmAdapter {
  const entries: Recorded[] = JSON.parse(readFileSync(cassette, 'utf8'));
  const used = new Set<number>();
  return {
    provider: 'replay',
    models: async () => STATIC_MODELS,
    async *stream(req) {
      const i = entries.findIndex((e, i) => !used.has(i) && e.key === requestKey(req));
      if (i === -1) throw new Error(`No recording for request:\n${requestKey(req)}`);
      used.add(i);
      yield* entries[i].chunks;
    },
  };
}
```

`requestKey` is the whole design. Too strict — hashing the entire request — and any prompt edit invalidates every cassette. Too loose and you replay the wrong response. In practice: the messages and the tool names, with volatile fields excluded.

That exclusion list is itself a finding. If timestamps or ids appear in the request in a way that changes the key, you have discovered a [cache invalidator](/en/blog/building-agents/the-prompt-prefix/) — the recorder is a cache-stability detector you get for free.

Then the test is ordinary, fast, and free:

```typescript
test('reads a file before answering', async () => {
  const agent = await createAgent({ llm: replayAdapter('cassettes/read-file.json') });
  await agent.run('what does src/index.ts export?');

  expect(kinds(agent.log)).toEqual([
    'turn/start', 'step/start', 'user/message', 'assistant/message',
    'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'step/end', 'turn/end',
  ]);
  expect(toolCalls(agent.log)).toMatchObject([{ name: 'read_file' }]);
});
```

No key, milliseconds, and it fails when the *system* changes rather than when the model does.

## Normalise, and fix the right thing

Real logs contain values that differ every run — session ids, timestamps, durations, absolute paths:

```typescript
function normalize(events: SessionEvent[]) {
  const ids = new Map<string, string>();
  const stable = (v: string) => ids.get(v) ?? (ids.set(v, `id-${ids.size + 1}`), ids.get(v)!);

  return events.map((e) => ({
    ...e, at: 0, seq: e.seq,
    ...(('sessionId' in e) ? { sessionId: stable(e.sessionId as string) } : {}),
  }));
}
```

Note ids are *renumbered*, not erased. Erasing loses the fact that two events refer to the same session — which is exactly the kind of bug a snapshot should catch.

> **Fix the fixture, not the normaliser.**

When a snapshot fails, the reflex is to widen the normaliser until it passes. Do that twice and you are testing your normaliser. If a value is unstable, either it should not be in the output, or its instability is the bug.

## Runtime invariants

Some properties should hold in *every* test, not in a specific one:

```typescript
installInvariants({
  'model-visible ⟺ logged': (agent) => {
    const fromLog = deriveMessages(agent.log.read());
    const sent = agent.lastRequest?.messages ?? [];
    assert.deepEqual(sent, fromLog, 'a request contained content absent from the log');
  },
  'no orphan tool calls': (agent) => {
    const calls = new Set(ids(agent.log, 'tool/call'));
    for (const id of ids(agent.log, 'tool/result')) calls.delete(id);
    assert.equal(calls.size, 0, `unanswered tool calls: ${[...calls]}`);
  },
  'quiescent at teardown': (agent) => {
    assert.equal(agent.status, 'idle');
    assert.equal(liveJobs(agent).length, 0);
  },
});
```

Register once, checked after every test. Each of these is a rule stated somewhere in this series, now enforced by anything that happens to exercise it — including tests written for something else entirely, which is where they earn their keep.

## The tests nobody writes

Three areas that break in production and are absent from most suites. All three are cheap once replay exists.

**Cancellation.** Abort mid-step. Assert the turn closed, the queue survived `keepInbox: true`, no subprocess leaked. This is [Part 15](/en/blog/building-agents/who-owns-the-agent/), and it is untested almost everywhere.

**Teardown ordering.** Dispose a parent with a running child. Assert child-first release and no orphans.

**Concurrency.** Two agents in one process with different [scopes](/en/blog/building-agents/scope-and-presets/) — assert the restricted one is *actually* restricted, by calling the denied tool by name.

Flakes here are not noise. A test that fails one run in fifty has found a real race; deleting it does not remove the race. Run the suite with randomised ordering and parallelism, and treat an intermittent failure as a bug report from the future.

## What the grown-up version looks like

DeepSeek Harness runs **keyless recorded-session replay through the shipped profiles** — not through a test harness that approximates the product, but through the real composition. `pnpm run test:snapshot` needs no API key; re-recording needs one.

Three conventions worth stealing.

**Snapshots are required for model- or user-visible change.** Not encouraged. A PR that changes what the model sees and updates no snapshot is incomplete.

**Fixtures replay on macOS and Linux, and the rule is written down**: fix fixtures, not normalisers.

**Both SDKs project the loop.** A change to the agent loop or the event map updates the TypeScript *and* Python expected outputs in the same PR — because a surface that silently stops matching the loop is a surface that lies to its users.

## The trap

The trap is widening the normaliser.

It always presents as a small, reasonable maintenance task. A snapshot fails, the diff is a duration or a path, you add a rule, it passes. Nobody would call that wrong.

Repeat it for a quarter and the normaliser erases ids, durations, ordering, and error text — and the snapshot asserts that *some events happened, roughly*. It never fails, so nobody looks at it, and it is providing no signal at all while looking like coverage.

Every normalisation rule should have a one-line comment saying why that value is legitimately unstable. If you cannot write the line, the value is not noise. It is the test finding something.

## Next

**Part 28 — Evals.** Every snapshot is green and the agent solves fewer problems than it did last month. No test catches it, because no test asks whether it is any *good*.
