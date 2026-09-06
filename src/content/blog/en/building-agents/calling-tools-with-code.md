---
title: 'Calling Tools With Code'
description: 'Twelve tool calls in sequence is twelve round trips, and you pay for the whole conversation each time. There is a second tool-calling protocol.'
pubDate: 2026-09-12
tags: ['ai-agents', 'tools', 'llm']
translationKey: 'agents-07-ptc'
sidebarTitle: '7 · Code mode'
order: 7
---

Ask an agent to rename a symbol across a repository: grep, read nine files, edit nine files, run the tests. Fourteen steps, fourteen model requests — and because the API is stateless, each one carries the whole conversation so far, including every file already read. By step 14 you are re-sending a dozen file contents to ask a question whose answer is "run the tests".

The work was mechanical. The model knew the plan at step 1 and spent fourteen round trips executing a loop it could have written.

## The second protocol

> Function calling asks *"which tool next?"* one at a time. Programmatic tool calling asks *"write the program."*

Same tools, same pipeline, different transport. Instead of a JSON schema per tool, you present the tools as an **SDK** and give the model one tool — `run_code` — that executes a program written against it.

The fourteen steps become one:

```typescript
// The model writes this. Your runtime executes it.
const hits = await tools.grep({ pattern: 'oldName', path: 'src/' });
const files = [...new Set(hits.map((h) => h.file))];

for (const file of files) {
  const src = await tools.read({ path: file });
  await tools.write({ path: file, content: src.replaceAll('oldName', 'newName') });
}

return await tools.run_command({ command: 'npm test' });
```

One request out, one program back, one result in. The intermediate file contents never enter the conversation — they existed as variables inside a process, which is exactly where they belonged.

This is called **PTC** (programmatic tool calling), or "code mode". It is not a replacement for function calling. It is a second mode, and knowing when each wins is the actual skill.

<figure class="dg">
  <img src="/diagrams/part07-ptc-transport.svg" alt="Function calling spends one round trip per tool call and re-sends the whole conversation each time; a program makes one round trip and keeps intermediate results as variables." loading="lazy" />
<figcaption><strong>PTC changes the transport, not the trust boundary.</strong> A tool that needs approval needs it just as much when a model-written loop calls it forty times.</figcaption>
</figure>

## What it costs you

The savings are real and so is the price. Four things get harder.

**You need a runtime.** Something must execute model-written code with access to your tools. DeepSeek Harness ships a worker-thread runtime with a separate heap, empty environment, cancellation, and hard worker termination. That is useful containment, but explicitly **not a security boundary**: the program can import Node built-ins, reach anything the host process can reach, spawn processes, and leave those processes alive after the worker dies. Treat it as Bash-equivalent trusted code, or put the whole harness behind an OS-level sandbox or remote execution boundary.

**Debugging moves one level down.** A failed function call has a name and arguments. A failed program has a stack trace, and the interesting frame is inside code the model wrote thirty seconds ago and you have never seen. Log the program. Always. It is the only artifact that explains what happened.

**Partial failure is now a thing.** Step 9 of the model's loop throws. Six files are already rewritten. Function calling gives you a clean boundary after every call; a program gives you whatever state it managed to reach. Your tools must be safe to half-apply, or the program must be written to be resumable — and the model will not do that unless you tell it to.

**Errors read differently.** `read` throwing inside a loop surfaces as a runtime exception, not a tool result. You need to decide whether the program catches and continues or dies — and say so in the SDK's documentation, because that documentation is the prompt.

## Nested calls still go through the pipeline

This is the part that is easy to get catastrophically wrong.

When the model's program calls `tools.run_command(...)`, that is **not** a direct function call. It must dispatch back through the same pipeline from [Part 3](/en/blog/building-agents/tools-registry-schema-pipeline/) — pre hooks, approval, sandbox, timeouts, logging, post hooks.

> **PTC changes the transport, not the trust boundary.** A tool that requires approval requires it just as much when a model-written program calls it in a loop. Arguably more.

```typescript
// Inside the sandbox: every tools.* call is a bridge, not a local function.
function makeSdk(dispatch: (name: string, input: unknown) => Promise<unknown>) {
  return new Proxy({} as Record<string, Function>, {
    get: (_t, name: string) => (input: unknown) => dispatch(name, input),
  });
}
```

`dispatch` crosses the sandbox boundary and lands in `invoke()` — the same one function calling uses. Bypass it "for performance" and you have built a hole through every safety control you own, reachable by any program the model writes.

The approval hook gets interesting here, and you have to design for it deliberately: a loop over forty files means forty confirmation prompts. Options are to batch the question (*"run `write` on 40 files?"*), scope the approval to the program rather than the call, or refuse PTC for tools that require per-call confirmation. All defensible; picking none of them is not.

## Generating the SDK

The SDK is generated from the same tool definitions as the JSON schemas. One source, two renderings — otherwise the mode you use less drifts and starts lying to the model.

```typescript
function renderSdk(tools: ToolDefinition[]): string {
  return [
    '// Available tools. All are async. Throwing propagates to the caller.',
    'declare const tools: {',
    ...tools.flatMap((t) => [
      `  /** ${t.description} */`,
      `  ${t.name}(input: ${tsTypeFromSchema(t.inputSchema)}): Promise<${t.returnType ?? 'string'}>;`,
    ]),
    '};',
  ].join('\n');
}
```

Two things make the difference between an SDK the model uses well and one it fumbles.

**Typed returns.** In function calling, results are strings — the model reads them. In PTC, results are *values* the program manipulates. `grep` returning `{file, line, text}[]` lets the model write `hits.map(h => h.file)`. Returning a formatted string forces it to parse text it just generated a parser for, badly.

**Honest error semantics in the doc comment.** Does `read` on a missing file throw or return null? The model cannot experiment. Whatever you choose, say it in the comment, because the comment is the specification.

## When to use which

| | Function calling | PTC |
|---|---|---|
| Few calls, each informing the next | ✅ | ✗ overhead for nothing |
| Many calls, shape known up front | ✗ round trips | ✅ |
| Results are large and intermediate | ✗ all of it enters context | ✅ stays in variables |
| Needs per-call human approval | ✅ natural | ⚠️ needs a batching story |
| Model should react to each result | ✅ | ✗ it committed to a plan |
| Model needs data transformation | ✗ | ✅ it has a language |

The dividing question is: **does the model need to think between calls?** If yes, function calling — that thinking is the point. If it is executing a plan it already has, PTC, and the round trips were pure overhead.

Most systems want both, selected per request. `mode: 'native' | 'ptc' | 'both'` as configuration, defaulting to native, with PTC offered when the tool set and the task suit it.

## What the grown-up version looks like

DeepSeek Harness ships this as a first-class `ToolRuntime` mode, and the decisions that survived contact with production:

**One tool registry, two presentations.** The same `ToolDefinition` produces JSON schemas in native mode and an SDK in PTC mode. There is no second registry, so there is no drift.

**Sub-dispatch is not a shortcut.** Every `tools.*` call from inside a program re-enters the standard pipeline. The sandbox holds no privileged handle to anything.

**Typed tool returns were a deliberate follow-up.** The first version returned strings and it worked, in the sense that the model coped. Typed returns are what made programs stop containing regex parsers for output the system had just serialised.

**Parallel dispatch inside one program.** A program doing `await Promise.all([...])` over ten reads may overlap calls through a per-run pool. It reuses the native `parallel` versus `exclusive` classification and ordered settlement contract, while `maxParallelSubCalls` supplies a separate PTC-specific bound.

## The trap

The trap is thinking PTC is the upgrade.

The token savings are dramatic on the demo — the rename task, the batch transform — and it is easy to conclude function calling was a primitive first attempt. It was not. Function calling exists because **the model reacting to each result is often the entire value of the agent.** A debugging session is not a program; it is a sequence of decisions each of which depends on what the last one revealed. Force that into PTC and you get a model guessing at a plan before it has the information to plan with.

Use PTC where the work is mechanical. Keep function calling where the work is thinking. The mode is a per-task choice, not a migration.

## Next

**Part 8 — The session log.** Everything so far has lived in an array called `messages`. Restart the process and it is gone: no resume, no fork, no transcript, no way to answer what the agent did yesterday. This is the most expensive decision in the system, and the cheapest time to make it is now.
