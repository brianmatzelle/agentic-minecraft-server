---
name: make-skill
description: Author a new lean Claude Code skill from a recurring request — research the real workflow, write .claude/skills/<name>/SKILL.md to spec, save a reference memory. Use to codify a task you keep doing, or to mine skills from user chat logs at scale.
argument-hint: "[task to codify — a description, or a path/excerpt of user requests]"
---

# make-skill — turn a recurring request into one lean Skill

`$ARGUMENTS` = the task to codify (a plain description, or a path/excerpt of user requests). Produce **one** lean skill. Frontmatter + argument spec: `references/skill-spec.md` (read it first).

## 1. Understand the task concretely
- Derive a kebab-case **verb** command name from how the user would invoke it.
- If it's repo work, fan out **Explore** agents for the EXACT files + commands. Never invent a command — verify each against the repo.
- Read one sibling `.claude/skills/*/SKILL.md` to match house style.

## 2. Write `.claude/skills/<name>/SKILL.md`
- Command name = the **directory name** (not the `name:` field).
- Put args where they belong with `$ARGUMENTS` / `$0` inline.
- `description:` = one sharp when+why line. Add `argument-hint:`.
- `disable-model-invocation: true` only for owner-only ops commands; omit so batch/Claude can invoke.
- `allowed-tools:` pre-approve the exact tools it runs (skip per-use prompts).
- **Lean:** exact commands, what-not-why, < ~40 body lines; push detail to `references/`.

## 3. Save a reference memory
One file (type `reference`) + a one-line `MEMORY.md` pointer: skill path, the workflow it encodes, gotchas.

## 4. Report
Skill path · one line on what it does · note a new folder may need a Claude Code restart to show in `/`.

> At scale: a batch/workflow clusters recurring requests from a chat-log corpus and calls this skill once per cluster — dedup against existing `.claude/skills/` so you don't re-mint a skill that exists.
