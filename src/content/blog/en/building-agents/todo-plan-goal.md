---
title: 'Work State Does Not Belong in the Model'
description: 'Twelve steps. At step seven it has forgotten step three is unfinished, and you find out when it announces completion.'
pubDate: 2026-09-29
tags: ['ai-agents', 'architecture', 'developer-experience']
translationKey: 'agents-24-work-state'
sidebarTitle: '24 · Work state'
order: 24
---

*"Migrate the auth module to the new session API."*

Twelve real steps: audit call sites, update the interface, migrate four consumers, fix the tests, update the docs, remove the shim. The agent starts well. Around step seven the conversation has grown, [compaction](/en/blog/building-agents/the-context-budget/) has run, and the early turns are now a paragraph of summary.

It finishes step ten and says: **"The migration is complete."**

Steps three and eight were never done. Not because the model is careless — because the record that they existed was in the part of the conversation that got compressed. It is reporting honestly on the state it can see.

<figure class="dg">
  <img src="/diagrams/part24-todo-plan-goal.svg" alt="A task list held only in the prompt is compacted away; the same list appended to the log survives and is re-rendered at full fidelity." loading="lazy" />
<figcaption><strong>Outside the model’s head, inside the log.</strong> The mechanism built to survive compaction must not itself be compactable.</figcaption>
</figure>

## Where the checklist lives

> Work state must live **outside the model's context** and **inside the log**.

A list in the conversation is subject to everything that happens to conversations: compaction, paraphrase drift, and no moment where anything checks it is complete. A list in the log survives all three and is re-rendered at full fidelity.

That is the difference between a list the model *remembers* and a list the model *reads*.

## The todo list

```typescript
interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

registry.register({
  name: 'todo_write',
  description:
    'Record or update your task list. Call it when a task needs more than ~3 steps, ' +
    'and again whenever a step starts or finishes. Send the COMPLETE list every time.',
  inputSchema: { /* items: TodoItem[] */ },

  async execute({ items }, ctx) {
    ctx.log.append('todo/updated', { items });          // durable
    const done = items.filter((i) => i.status === 'completed').length;
    return `Updated. ${done}/${items.length} complete.`;
  },
});
```

Two decisions in there that are not obvious.

**Send the whole list, not a delta.** Deltas need ids the model must track across compaction, which is the problem you are solving. A full replacement is idempotent and self-correcting: the latest event is the truth.

**Fold, do not accumulate.** State is `last-wins` over `todo/updated` events. There is no mutable list anywhere:

```typescript
const currentTodos = (events: SessionEvent[]): TodoItem[] =>
  events.filter((e) => e.kind === 'todo/updated').at(-1)?.items ?? [];
```

Then render it into every request as a [prompt section](/en/blog/building-agents/the-prompt-prefix/) — and mind where it goes:

```typescript
systemPrompt.section({
  name: 'todos',
  order: ORDER.POLICY + 50,             // LATE: this changes, the prefix above must not
  text: (ctx) => {
    const items = currentTodos(ctx.log.read());
    if (items.length === 0) return '';
    return `## Task list\n\n${items.map((i) =>
      `- [${i.status === 'completed' ? 'x' : i.status === 'in_progress' ? '~' : ' '}] ${i.text}`
    ).join('\n')}`;
  },
});
```

Late ordering, because this text changes on most turns. Put it early and every update invalidates the entire cached prefix — the exact mistake from Part 9, made by a feature designed to help.

## It is also the UI

The list is the best progress indicator an agent can have, and it costs nothing extra.

A spinner says *working*. A checklist with three items ticked, one in progress, and eight to go says what is happening, how far along it is, and — crucially — **lets the user intervene early**. Watching item four be "rewrite the config parser" when that was not wanted is a five-second correction instead of a five-minute one.

This is where the [inbox](/en/blog/building-agents/the-inbox/) pays off again: seeing the plan and steering it are the same interaction, one turn apart.

## Plan mode

Sometimes you want the plan *before* anything happens. Not a checklist alongside the work — a gate in front of it.

Plan mode is a durable state, not a prompt:

```typescript
type PlanState =
  | { mode: 'off' }
  | { mode: 'planning'; enteredAt: number }
  | { mode: 'approved'; plan: string; approvedAt: number };
```

While `planning`, two things change at once:

```typescript
// 1. Tools are restricted — scope, from Part 16.
ctx.tools.restrict(agentCtx, { deny: ['write', 'edit', 'bash', 'run_code'] });

// 2. The instruction changes.
systemPrompt.section({
  name: 'plan-mode',
  order: ORDER.IDENTITY + 10,
  text: () => planState.mode !== 'planning' ? '' :
    'PLAN MODE. Investigate and design. You may read, search, and ask questions. ' +
    'You may not modify anything. When the plan is ready, call exit_plan_mode with it.',
});
```

And leaving requires a human:

```typescript
{
  name: 'exit_plan_mode',
  description: 'Present your finished plan for approval. You cannot make changes until approved.',
  async execute({ plan }, ctx) {
    const ok = await ctx.interaction.confirm({ title: 'Approve this plan?', body: plan });
    if (!ok) return 'The user did not approve. Revise the plan and present it again.';
    ctx.log.append('plan/approved', { plan });
    ctx.tools.unrestrict(ctx.agentCtx);
    return 'Approved. You may now make changes.';
  },
}
```

The enforcement is the tool restriction, not the instruction. An agent *told* not to modify things mostly will not; an agent that *cannot* always will not. Instruction plus enforcement, as always — and note the approved plan is logged, so "what did we agree to?" has an answer later.

## Goals outlive sessions

A todo list is per-session. Some objectives are not: *"get the test suite green"* spans days, restarts, and forks.

```typescript
interface Goal {
  id: string;
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  rounds: number;
  maxGoalRounds: number;
}
```

Same folding, one difference that matters: a goal survives **fork**. Branch a session and both branches inherit the objective, because it belonged to the work and not to the conversation.

The failure mode without one: a resumed session where the model reads the transcript, infers what it was probably doing, and infers wrong.

## Reminders

Last small piece. *"Check the deploy in ten minutes."*

The obvious implementation is a timer that calls the model. The better one is a message:

```typescript
scheduler.at(dueAt, () => {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: frameAsUntrustedReminder(id, text) }],
    source: { kind: 'plugin', plugin: 'schedule' },
  }));
});
```

A due reminder is just another [inbox](/en/blog/building-agents/the-inbox/) entry. No second control path, no second ordering, and the transcript shows it arriving exactly where it arrived — which is why Part 4 insisted on one queue.

## What the grown-up version looks like

DeepSeek Harness keeps these as four small package families — `todo`, `plan`, `goal`, `schedule` — and their separateness is the design. They differ in semantics: a todo list is a whole-list session snapshot; plan mode is durable guidance, not tool enforcement; one goal tracks a durable objective and bounded autonomous rounds; schedules deliver one-shot or fixed-interval reminders into a live session.

A cold session does not wake itself. Its reminder stays overdue until a live root agent resumes the session, and fixed intervals deliver only the latest missed occurrence rather than replaying a backlog.

What they share is the mechanism: durable events, folded to state, rendered into the prompt, enforced through scope. One pattern, four lifetimes.

Plan mode is described there as *"plan mode as logged state"* — which is the whole thing in four words. Not a flag, not a prompt, not a UI mode. A fact in the log with a gate on the way out.

## The trap

The trap is letting the checklist live only in the prompt.

It is so nearly right. You render the list, the model sees it, it works — for short sessions. Then the session gets long, compaction runs, and the mechanism you built to survive compaction gets compacted, because it was never anywhere else.

The test is one line: **can you reconstruct the current task list from the log alone, with no model involved?** If not, the list is a rendering of the model's memory, and it will be lost in exactly the sessions where you needed it most.

## Next

**Part 25 — When the model is the bug.** It has called the same `grep` nine times. Nothing has errored. The system is working perfectly and burning money perfectly.
