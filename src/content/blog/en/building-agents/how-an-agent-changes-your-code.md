---
title: 'How an Agent Changes Your Code'
description: 'It edited fourteen files and broke the build. There is nothing to roll back to. Two separate decisions — how it expresses a change, and how you record one.'
pubDate: 2026-09-24
tags: ['ai-agents', 'tools', 'developer-experience']
translationKey: 'agents-19-edits'
sidebarTitle: '19 · Edits'
order: 19
---

Fourteen files changed. The build is broken. You want the state from four minutes ago.

`git stash` takes your work too. `git checkout .` takes everything since the last commit, which was an hour ago. The agent wrote straight to disk with no record of what it touched, and the only person who knows which fourteen files is the agent, in a conversation you are about to lose.

Two questions hide in here, and they need separating because they have different answers:

- **How does the agent express a change?** Determines how often it fails.
- **How do you record that a change happened?** Determines whether anyone dares let it run unsupervised.

## Part one: the edit format

There are three ways to let a model change a file, and the choice is not stylistic — each has a measurable failure rate.

**Whole file.** The model returns the complete new contents. Cannot fail to apply — it is an overwrite. Costs output tokens proportional to file size, so a two-line change to an 800-line file rewrites 800 lines. Worse, long regeneration is where models drop things: a function quietly disappears in the middle and nothing flags it, because the output was syntactically fine.

**Unified diff.** Compact and reviewable. And the failure mode is nasty: models are unreliable at line numbers and hunk headers. A diff that is semantically right and off by two lines does not apply, and the model does not know why.

**Search and replace.** The model provides an exact snippet to find and its replacement. No line numbers to get wrong, output proportional to the change. It fails when the snippet does not match — whitespace, a stale read, or the string occurring twice.

That last failure is the one you can engineer away, and it is why this format wins in practice:

```typescript
{
  name: 'edit',
  description:
    'Replace an exact string in a file. old_str MUST match exactly once, including ' +
    'whitespace and indentation. Include enough surrounding context to be unique.',
  inputSchema: { /* path, old_str, new_str */ },

  async execute({ path, old_str, new_str }, ctx) {
    const content = await ctx.fs.read(path, { encoding: 'utf8' });
    const count = content.split(old_str).length - 1;

    if (count === 0) return `No match for old_str in ${path}. Read the file and retry.`;
    if (count > 1) {
      return `old_str matches ${count} times in ${path}. Add surrounding lines to disambiguate.`;
    }

    await ctx.fs.write(path, content.replace(old_str, new_str));
    return `Edited ${path}.`;
  },
}
```

> **Require a unique match, and say so in the error.** The "matches 3 times" message is what turns a failed edit into a successful retry, because it tells the model exactly what to change about its request.

Ambiguity is the real enemy here, not absence. Replacing the *first* of three matches is the one outcome you must never allow: it succeeds, reports success, and edits the wrong function.

**Read before write.** A model editing a file it has not read in this session is working from memory or imagination. Enforce it at the seam, not per tool:

```typescript
ctx.events.on('fs/write-intent', async (intent, next) => {
  const lastRead = readLog.get(intent.path);
  if (lastRead === undefined) {
    return { kind: 'reject', reason: `Read ${intent.path} before editing it.` };
  }
  if (lastRead < (await ctx.fs.stat(intent.path))!.mtimeMs) {
    return { kind: 'reject', reason: `${intent.path} changed since you read it. Read it again.` };
  }
  return next();
});
```

That second branch is optimistic concurrency, and it matters the moment anything else can touch the tree — you, a formatter, a watch process, another agent.

<figure class="dg">
  <img src="/diagrams/part19-code-edits.svg" alt="Three edit formats with different failure modes, and a shadow git repository that records the agent changes without touching the user repository." loading="lazy" />
<figcaption><strong>Two separate decisions.</strong> The format decides the failure rate; the record decides whether anyone dares let it run unsupervised.</figcaption>
</figure>

## Part two: undo

Now the recording half. The requirement is narrow and specific:

> Undo everything **this agent** did, without touching anything **I** did, at any point.

`git` alone cannot express that — the agent's changes and yours are the same dirty working tree. What works is a shadow repository: a second `.git` directory that only the agent writes to.

```typescript
class Checkpoints {
  private readonly env: Record<string, string>;

  constructor(private workspace: string, shadowDir: string) {
    // Same working tree, different git directory. Your .git is untouched.
    this.env = { GIT_DIR: shadowDir, GIT_WORK_TREE: workspace };
  }

  async snapshot(label: string): Promise<CheckpointId> {
    await this.git('add', '-A');
    const sha = await this.git('commit', '-m', label, '--allow-empty', '--quiet', '&&',
                               'rev-parse', 'HEAD');
    return sha.trim() as CheckpointId;
  }

  async restore(id: CheckpointId, paths?: string[]): Promise<void> {
    await this.git('checkout', id, '--', ...(paths ?? ['.']));
  }

  async diff(from: CheckpointId, to = 'HEAD'): Promise<string> {
    return this.git('diff', from, to);
  }
}
```

You get real content-addressed history, real diffs, and real partial restore — for the cost of two environment variables. And the user's `git status`, `git stash` and branch state never see any of it.

**Snapshot at turn boundaries.** Not per edit — that produces hundreds of commits nobody can navigate. One before the turn's first write, one after the turn ends. This is the [turn boundary](/en/blog/building-agents/turn-and-step/) earning its keep again: it is the unit a user thinks in ("undo what it just did"), so it is the unit checkpoints should use.

**Restore is a real operation with a real question.** Roll back files only, or files *and* conversation? Files-only leaves the agent believing it made edits that no longer exist — it will be confused, and reasonably so. Conversation too means [forking the session](/en/blog/building-agents/the-session-log/) at the matching turn. Offer both, name them clearly, and default to files-only with a message injected telling the agent what was reverted.

## Part three: showing the change

Two modes, and the choice is the user's trust level, not your preference.

**Review before apply.** The agent proposes; the diff is shown; the user accepts, rejects, or edits. Safest, and slow enough that people turn it off by the second day.

**Apply then review.** Changes land immediately, the UI shows what changed, undo is one click. Faster, and it is what makes an agent feel like a collaborator rather than a form. It only works if checkpoints exist — which is why this half of the post comes after that half.

Either way, **show a diff, never a prose summary.** "I updated the error handling in three files" is unverifiable. A diff is the thing that was actually done.

## What the numbers say

This is one of the few agent design decisions with published data. Aider's polyglot leaderboard reports pass rates per model *and per edit format*, and the spread between formats on the same model is routinely larger than the spread between adjacent models.

Two things follow, and both are worth acting on:

**Do not choose by feel.** The correct format is model-dependent, and it changes between model generations. Measure yours on your codebase — which is [Part 28](/en/blog/building-agents/evals/), and this is the most concrete thing to point that machinery at.

**Track the apply-failure rate as a first-class metric.** Edits attempted versus edits applied. When a new model raises it, you have a format problem, not a model problem — and the fix is a tool change, not a prompt.

## What the grown-up version looks like

DeepSeek Harness ships **two** editing vocabularies deliberately: a `str_replace`-style editor with unique-literal matching, and a simpler `read`/`write`/`edit` set. Two formats coexisting is not indecision — it is acknowledging that the right one depends on the model and the task, and making that a composition choice.

Read-before-write is a policy package (`fs-observation-policy`) rather than a check inside each tool, hooked to filesystem intent events. Same argument as [sandboxing at the subprocess seam](/en/blog/building-agents/the-execution-world/): one choke point, no per-tool gaps.

Outside this repo the space is well explored and worth borrowing from: Cursor's Checkpoints, Cline's shadow git with separate *restore files* / *restore files and task* options, and Aider's edit-format leaderboard.

## The trap

The trap is choosing an edit format because it looks elegant.

Unified diff is the format engineers like. It is compact, it is what `git` speaks, it reviews beautifully. It is also the one models are worst at producing, because it demands correct line arithmetic about a file they are holding in their head.

The format the model applies reliably beats the format that reads nicely — every time, by a margin you can measure. Measure it.

## Next

**Part 20 — Background work.** `npm run build` takes eight minutes. The model should not sit and wait, and it must not forget. And if the session closes while it is running?
