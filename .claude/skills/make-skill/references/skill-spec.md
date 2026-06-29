# Claude Code Skill authoring spec

Source: https://code.claude.com/docs/en/skills.md

## Location & naming
- Project: `.claude/skills/<skill-name>/SKILL.md` · Personal: `~/.claude/skills/<skill-name>/SKILL.md`
- The slash-command name = the **directory name** (kebab-case), NOT frontmatter `name`.
- A folder created mid-session may need a Claude Code restart before it shows in `/` (or run `/doctor` to catch parse errors).

## Frontmatter (all optional; only `description` recommended)
- `name:` display label (defaults to dir name)
- `description:` when+why to use — Claude reads this to auto-invoke. One sharp line.
- `when_to_use:` extra trigger context (description + this capped ~1536 chars total)
- `argument-hint:` shown in autocomplete, e.g. `"[PR number]"`
- `arguments: [a, b]` named positional args → `$a`, `$b`
- `disable-model-invocation: true` — only the user can invoke (not Claude/batch)
- `user-invocable: false` — only Claude can invoke (not the user)
- `allowed-tools: "Read Grep Bash(git *)"` — pre-approve, no per-use prompts (does NOT restrict other tools)
- `disallowed-tools: "..."` — remove tools while the skill is active
- `model:` / `effort:` — override model / reasoning effort for this skill run
- `context: fork` + `agent: Explore` — run the skill in an isolated subagent
- `paths: "src/**/*.ts"` — auto-load only when matched files are in play
- `shell: bash|powershell`

## Arguments (invoked as `/foo 50 bar`)
- `$ARGUMENTS` → all args (`50 bar`)
- `$0` / `$ARGUMENTS[0]` → `50`, `$1` → `bar`
- named via `arguments:` frontmatter → `$name`
- If SKILL.md contains no `$ARGUMENTS`, Claude Code appends `ARGUMENTS: <args>` at the end.

## Dynamic injection (preprocessed before Claude sees the body)
- Inline: `` !`git status --short` `` (line start or after whitespace)
- Fenced multi-line: a ```` ```! ```` code block

## Lean principles
- < 500 lines; SKILL.md = overview + navigation. Push detail to sibling files (`references/*.md`, `scripts/*`).
- Loaded skill content stays in context the whole session → every line is recurring cost. State WHAT to do, not how or why.
