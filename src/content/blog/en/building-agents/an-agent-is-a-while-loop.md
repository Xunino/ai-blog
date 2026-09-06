---
title: 'An Agent Is a While Loop'
description: 'Strip an agent down to its load-bearing mechanism: request a model response, execute its tool calls, return the observations, and repeat.'
pubDate: 2026-09-06
tags: ['ai-agents', 'llm', 'architecture']
translationKey: 'agents-01-while-loop'
sidebarTitle: '1 · The while loop'
order: 1
---

Agent diagrams usually begin with boxes labelled **Planning**, **Memory**, and **Reflection**. Those boxes describe useful behaviours, but they hide the mechanism that makes all of them possible.

At execution level, an agent is smaller:

> An agent asks a model what to do next, performs the requested effects, returns the observations, and repeats until the model stops requesting effects.

DeepSeek Harness has thousands of lines around that loop because production systems need durability, cancellation, policy, streaming, scoping, and recovery. The central motion is still recognisable.

## A deliberately small DeepSeek agent

The following program uses DeepSeek's OpenAI-compatible chat-completions API. It is a teaching example, not a safe shell agent: `run_command` can execute whatever the model asks for, with the permissions of the current process.

```bash
npm install openai
```

```typescript
import OpenAI from 'openai';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
});

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one UTF-8 file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one shell command in the current workspace.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

async function execute(name: string, raw: string): Promise<string> {
  const args = JSON.parse(raw) as Record<string, string>;
  if (name === 'read_file') return readFile(args.path, 'utf8');
  if (name === 'run_command') {
    const { stdout, stderr } = await execAsync(args.command);
    return stdout + stderr;
  }
  throw new Error(`unknown tool: ${name}`);
}

async function run(task: string) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'user', content: task },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      tools,
    });
    const assistant = response.choices[0]?.message;
    if (!assistant) throw new Error('model returned no message');

    messages.push(assistant);
    if (!assistant.tool_calls?.length) break;

    for (const call of assistant.tool_calls) {
      let content: string;
      try {
        content = await execute(call.function.name, call.function.arguments);
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  console.log(messages.at(-1)?.content);
}

await run(process.argv.slice(2).join(' '));
```

<figure class="dg">
  <img src="/diagrams/part01-while-loop.svg" alt="The core agent loop: model request, tool calls, tool execution, observations, then another request or stop." loading="lazy" />
  <figcaption><strong>The irreducible loop.</strong> Everything else in this series either protects this cycle, feeds it better context, or makes its effects observable.</figcaption>
</figure>

## The four facts the loop must preserve

The example is short, but four decisions are already load-bearing.

| Fact | What goes wrong if it is lost |
|---|---|
| The complete assistant message | Reasoning content and tool-call identity may disappear on the next request. |
| Every tool-call id | A result can no longer be correlated with the call that requested it. |
| Model order | Parallel execution can make observations arrive in a different order from the calls. |
| Failure as an observation | One bad command crashes the whole agent instead of giving the model evidence it can react to. |

DeepSeek Harness makes these structural rather than conventional. An assistant response becomes canonical content blocks; tool calls and results are paired by durable ids; parallel-safe calls may overlap but their results commit in model order; and expected tool failures return `isError` results instead of escaping the loop.

The distinction between **effect failure** and **harness failure** matters. A command exiting non-zero is usually an observation for the model. A corrupt session log or a broken policy plugin is an infrastructure failure and should close the turn loudly. Treating both as strings hides incidents; treating both as exceptions makes the agent brittle.

## What an agent is—and is not

A useful operational definition is:

> An agent is a model, a control loop, and authority to cause effects.

- A model without a loop is a one-shot assistant.
- A loop without effects can reason and produce text, but cannot change its environment.
- Effects without a model-directed loop are ordinary automation.

Planning, memory, reflection, retrieval, and delegation are not absent from this definition. They are higher-level mechanisms that alter what the next request sees or what effects the loop can choose.

## Where the small loop breaks

The example fails almost immediately under real use:

1. `messages` disappears on process exit, and a partial stream can leave no trustworthy record of what the user saw.
2. A large command result can consume the remaining context window.
3. New input cannot safely steer a request already in progress.
4. No policy boundary exists between a requested effect and its execution.
5. A model can repeat a valid but useless action forever.
6. Filesystem and process calls are tied to the local machine.

<figure class="dg">
  <img src="/diagrams/part01-failure-points.svg" alt="Failure points around the core agent loop: persistence, context, steering, permissions, repetition, execution isolation, and recovery." loading="lazy" />
  <figcaption><strong>Production engineering surrounds the loop.</strong> It should not obscure which invariant each layer protects.</figcaption>
</figure>

## What DeepSeek Harness keeps

DeepSeek Harness does not replace the loop with a planner. Its concrete `ReactLoopAgent` still performs the same cycle:

1. claim input at a turn or step boundary;
2. assemble prompt sections and visible tool schemas;
3. derive model history from the session log;
4. stream one model request into canonical blocks;
5. append the assistant message;
6. execute requested tools through the shared pipeline;
7. append ordered results and either request again or close the turn.

The production difference is that every boundary is explicit and observable.

<figure class="dg">
  <img src="/diagrams/part01-grownup-loop.svg" alt="The small model-and-tools loop surrounded by inbox, session log, prompt assembly, policy, and streaming adapters." loading="lazy" />
  <figcaption><strong>The loop is surrounded, not discarded.</strong> The surrounding layers turn an interesting script into a resumable and governable system.</figcaption>
</figure>

## Next

**Part 2 — Turn and Step: When is it actually done?** A model finishing one response is not the same event as the system having no work left.
