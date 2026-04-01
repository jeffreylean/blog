---
title: "Claude Code Harness — Part 1: Memory"
date: 2026-04-01T01:57:00+08:00
draft: false
toc: false
---

The source code for Claude Code has been leaked—AGAIN. Since I'm recently tinkering with Agent harnesses, I thought it would be a great opportunity to dive into the Claude code harness itself. Below are the findings on how the Claude Code harness is being designed and what we can learn from them.

There are a few aspects of the harnesses that I am really keen to dive into. Focusing on these will help me gather some leads when it comes to designing my own agent harness. So, I'll structure the analysis around these key aspects. This one specificaly will focus on **memory**.

## Memory
Claude code memory is pretty straightforward; it’s purely filesystem-based, no RAG, no database, no vector store.

Architecture
```

memory/
├── MEMORY.md          # Index file (always loaded, max 200 lines / 25KB)
├── user_role.md       # Individual topic files with frontmatter
├── feedback_testing.md
├── project_deploy.md
└── team/              # Team-scoped shared memories
    └── MEMORY.md
```
The memory system is all located under one memory folder at `~/.claude/projects/<project-slug>/memory/`. There’s a `MEMORY.md` which act as memory index file.

The key design is **Two-tier retrieval strategy**. The `MEMORY.md` (index) is loaded synchronously into the system prompt on every turn. But the Individual memory files are loaded **on-demand** via a relevance-ranking query.

Each memory file uses YAML frontmatter that looks like this:
```markdown
---
name: {{memory name}}
description: {{one-line description — used for relevance ranking}}
type: {{user, feedback, project, reference}}
---

{{memory content}}
```

The `description` field here is actually pretty important as it's what gets used later during the retrieval step to decide whether this memory is relevant to the current conversation. Keep that in mind, we'll come back to this.

There are **4 types of memories**, and each type has its own structure and purpose.

**`user`** — This is about who you are. Your role, expertise, preferences, how you like to work. It's free-form prose, no required structure. Say you tell Claude "I've been writing Go for ten years but this is my first time touching the React side of this repo", it saves that so it knows to frame frontend explanations in terms of backend analogues you'd already understand.

**`feedback`** — This is the interesting one. It captures both **corrections** and **confirmations**. When you tell Claude "don't mock the database in these tests" that's a correction. But when you say "Yea, using rust was the right call here," that's a confirmation and it saves that too, so it doesn't second-guess a good judgment call next time. The body follows a structured format: the rule/fact, then **Why:** (what happened that made this important), then **How to apply:** (when and where this guidance kicks in).

**`project`** — Ongoing work context that you can't derive from the code or git history. Things like merge freezes, why a rewrite is happening, who's working on what. Same structured format as feedback: fact/decision → **Why** → **How to apply**. One neat detail — if you say "we're freezing merges after Thursday," the system converts that to an absolute date. Relative dates go stale fast.

**`reference`** — Pointers to external systems. Your Linear project for bug tracking, the Grafana dashboard oncall watches, the Slack channel for deploy notifications. Free-form, no structure needed. It's basically telling the model "when you need context about X, go look here."

### Writing to Memory

So when does Claude actually decide to save something to memory? Turns out there are **3 separate mechanisms** that handle memory writes — and they layer on top of each other.

#### 1. Model-Driven Saves (Primary)

This is the main path. The agent sees memory instructions baked into its system prompt and decides on its own to save using the `Write`/`Edit` tools directly. There's **no programmatic trigger** here — no classifier running on the side, no keyword detection, no heuristic rules. It's purely the LLM making a judgment call based on prompt guidance.

The system prompt contains `<when_to_save>` tags for each memory type, along with few-shot examples that teach the model what's "worth remembering":

```
user: I'm a data scientist investigating what logging we have in place
assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]

user: don't mock the database in these tests — we got burned last quarter
assistant: [saves feedback memory: integration tests must hit a real database, not mocks.
  Reason: prior incident where mock/prod divergence masked a broken migration]

user: we're freezing all non-critical merges after Thursday
assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut.
  Flag any non-critical PR work scheduled after that date]

user: the Grafana board at grafana.internal/d/api-latency is what oncall watches
assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency
  dashboard — check it when editing request-path code]
```


#### 2. Automated Background Extraction (Safety Net)

Here's the creative bit, the main agent isn't always going to catch everything worth remembering. It could be that it was too focused on the coding task and forgot to save that important thing the user mentioned. So there's a **background safety net**.

At the end of each query turn, a **forked subagent** fires off to catch what the main agent missed. The flow looks roughly like this:

```
Query completes (final response)
  → handleStopHooks()
    → executeExtractMemories()  [fire-and-forget]
      → Check: did main agent already write? (hasMemoryWritesSince)
      → Check: throttle gate (every N turns)
      → If both pass: runForkedAgent() with extraction prompt
      → If files written: createMemorySavedMessage()
```

A few interesting design to look at here. First, **mutual exclusion**, if the main agent already wrote memories this turn, the extraction agent skips entirely. No point doing double work. Second, it's **throttled** so it doesn't run on literally every turn. Third, it's **fire-and-forget** — it doesn't block the user from continuing the conversation, but it does get drained before the process exits so nothing gets lost.

The extraction agent itself is heavily restricted. It can only Read/Grep/Glob + Write/Edit to the memory directory. No Bash, no MCP, no spawning other agents. And it has a **max 5-turn budget** with a strict instruction: "Turn 1: all Reads in parallel; Turn 2: all Writes in parallel. Do not interleave." Clean and efficient.

#### 3. Dream Consolidation (Nightly Batch)

This one is my favourite. There's an `autoDream` process that runs periodically to **consolidate and improve** existing memories. Think of it like a nightly cleanup job for your memory store.

It triggers when all of these conditions are met:
- 24+ hours since the last Consolidation
- 5+ sessions since the last Consolidation
- not already running
- the feature flag is enabled (off by default, under A/B testing)

When it fires, it spawns a forked agent that reads transcript logs from all sessions since the last consolidation, analyzes them, and then distills/merges/improves the memories. It's basically the agent reflecting on its recent conversations and tidying up what it's learned.

#### The Actual File Write

Regardless of which of the 3 mechanisms triggers it, the actual saving process is dead simple — it's a **two-step write**:

1. **Write** the individual memory file (e.g., `feedback_testing.md`) with the proper frontmatter
2. **Add** a one-line pointer to `MEMORY.md`

That's it. No database inserts, no embedding generation, no vector store upserts. Just plain old file writes. The `MEMORY.md` is strictly an index and you never write actual memory content into it. It just holds one-liner summaries that look like:

```markdown
- [User role](user_role.md) — data scientist, observability focus
- [No database mocks](feedback_testing.md) — prior prod/mock divergence incident
- [Merge freeze 2026-03-05](project_release_freeze.md) — mobile release cut
```

There are hard limits on the index though, which is **200 lines max** and **25KB max**. If you go over, it gets truncated by cutting the tail (oldest). I see this as a gap, as the truncation is a simple `slice(0,N)`; oldest-first index removal. The memory files are still on disk, but if their pointer got cut from `MEMORY.md`, the agent can't find them. It just silently forgets without user knowing. This is probably why Dream Consolidation exists to merge and clean up memories before the index bloats to the point where things fall off the end.

Another thing I found interesting is how opinionated the system is about **what NOT to save**. The prompt explicitly tells the model to avoid saving things like code patterns (just look at the codebase), git history (`git log` is the source of truth), debugging recipes (the fix is already in the code), anything already in CLAUDE.md files, and ephemeral task details. This makes a lot of sense as you don't want to pollute your memory store with stuff that's either derivable or going to go stale quickly.

Every memory also carries an `mtimeMs` timestamp. The system computes how old the memory is in days and adds freshness caveats. The prompt actually tells the model straight up: *"Memory records can become stale. Verify against current state before acting."* So if a memory says a certain file exists at a path, Claude is instructed to actually `grep` or check before blindly trusting it.

### Memory and Prompt Cache

I want to call this out because it is easy to overlook this, at least I did. Cached tokens are *way* cheaper (10x), and a memory system that mutates the system prompt mid-session will bust your cache entirely. So how does Claude Code handle this?

The system prompt in Claude Code is split into two halves by a boundary called `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`:

```
[SYSTEM PROMPT — cached, never changes mid-session]
  ├── Static sections (global cache scope)
  ├── __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
  ├── Memory prompt + MEMORY.md content (memoized once)
  └── Environment info, CLAUDE.md, etc.

[MESSAGES — after the cache prefix, not cached]
  ├── User message 1
  ├── Assistant message 1
  ├── ...
  ├── Attachment: relevant_memories  ← new memories surface HERE
  └── User message N
```

The `MEMORY.md` index gets loaded into the system prompt via `systemPromptSection('memory', () => loadMemoryPrompt())` — and this is **memoized**. It computes once at session start, then returns the cached value on every subsequent turn. Only gets invalidated by `/clear` or `/compact`. So even if the extraction agent writes new memory files mid-conversation, the system prompt **doesn't change**.

The individual memories that get retrieved by the Sonnet ranker? Those don't go into the system prompt at all. They get injected as `<system-reminder>` **attachments on messages**, which sit in the message array, after the cached prefix.

So to put it all together: new memories written by the background extraction agent **don't** update the system prompt (memoized), **don't** update MEMORY.md in the prompt (frozen at session start), but **can** surface via `findRelevantMemories` on a future turn — except that goes into a message attachment, which is after the cached prefix. New memories only become visible in the system prompt on the **next session**, when `loadMemoryPrompt()` re-reads MEMORY.md fresh. Within the same session, they can only surface through the relevant memories attachment path.

The separation here is crucial to keep the prompt cache warm. Cached input tokens are significantly cheaper than uncached ones, it can be 10x cheaper. But if the system prompt changed every turn because of new memories, you'd be paying full price on the entire prompt every API call. By freezing the index at session start and routing dynamic memories through message attachments, the cache stays warm and you only pay full cost for the new stuff at the end.

### Retrieving from Memory

The retrieval is very simple, and I want to emphasize this — **there is no RAG here. No embedding retrieval. No vector similarity search. Nothing fancy.**

The retrieval mechanism is purely a **traditional LLM-as-ranker** approach. Here's how it works:

The relevance ranking lives in `src/memdir/findRelevantMemories.ts`. When a conversation is happening, the system:

1. **Scans** up to 200 memory files, but only reads the **frontmatter** (first 30 lines) of each file — not the full content
2. **Sends** all those descriptions along with the current user query to **Sonnet** (the cheaper, faster model)
3. Sonnet **picks up to 5** most relevant memories based on the descriptions
4. The **full content** of only those selected memories is then read from disk and injected as `<system-reminder>` attachments into the conversation

That's it. The entire retrieval pipeline is basically: scan frontmatter → ask a cheap LLM "which of these are relevant?" → load the winners. No cosine similarity, no HNSW index, no chunking strategies.

This is why that `description` field in the frontmatter matters so much — it's literally the only thing Sonnet sees when deciding relevance. If your description is vague, your memory won't get picked up. It's the equivalent of writing a good commit message, except the "reader" is an LLM doing relevance ranking.

There's also a **de-duplication** mechanism so the same memory doesn't keep getting surfaced across the conversation. Once a memory has been picked and injected, it won't get re-surfaced again unless the context has changed.

## Wrapping Up

The biggest takeaway for me from digging into Claude Code's memory system is how *simple* it is, and I believe It is a good start for anyone who's trying to build memory system for their agent. Just markdown files on disk, an LLM that decides when to save, a cheap model that picks what's relevant, and a careful separation between cached and uncached injection points to keep costs down.

If you're building your own agent harness, I think the lesson here is: don't over-engineer your memory system. An index-then-fetch pattern with an LLM as ranker gets you surprisingly far. Spend your complexity budget on the things that actually matter — like how to NOT truncate the index file so your agent doesn't go *amnesia*.
