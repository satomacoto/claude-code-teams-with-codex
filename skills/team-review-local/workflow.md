# Team Review Workflow (shared)

This workflow follows a staged pipeline inspired by the official code-review plugin, adapted for Agent Teams with multiple Claude and Codex reviewers.

## Phase 1: Preparation (leader does this)

### 1.1 Gather context

- Identify all changed files from the diff.
- Find relevant CLAUDE.md files: the root CLAUDE.md and any CLAUDE.md in directories touched by the change.
- Summarize the change: what it does, why, and what areas it affects.
- Determine if test files were added or modified.

### 1.2 Plan the review team

Assign reviewers based on the **5 core review perspectives** (always included) plus **domain-specific reviewers** as needed.

#### Core perspectives (always assign all 5)

| # | Perspective | Focus | Notes |
|---|---|---|---|
| 1 | **Conventions** | CLAUDE.md compliance — import patterns, naming, style, framework conventions | Check against each relevant CLAUDE.md |
| 2 | **Bug scan** | Shallow scan for obvious bugs in the changed lines only — logic errors, null handling, race conditions, security | Avoid reading beyond the diff; focus on changes themselves |
| 3 | **History context** | Git blame and history of modified code — regressions, patterns being violated, context from past changes | Use `git log`, `git blame` on affected files |
| 4 | **Prior feedback** | Previous PRs that touched these files — check for recurring comments that apply here too | Use `gh pr list` / `gh api` to find past reviews |
| 5 | **Code comments** | Read code comments in modified files — ensure changes comply with guidance in comments (TODOs, invariants, warnings) | Focus on comments near changed lines |

#### Additional perspectives (add as needed)

| Perspective | When to include |
|---|---|
| **Silent failure / error handling** | When error-handling code is changed or added |
| **Security** | When auth, crypto, input validation, or secrets are involved |
| **Test coverage & quality** | When test files are added/modified, or testable logic changes |
| **Type design** | When new types/interfaces are added or significantly changed |
| **Domain-specific** (backend, frontend, DB, infra …) | When domain expertise would catch issues a generalist would miss |

#### Assigning to Claude vs Codex

- **Do not cap the number of reviewers.** Scale to the complexity of the change.
- **Use Codex reviewers** for multi-model diversity. As a guideline:
  - Assign at least 1 of the 5 core perspectives to Codex. Use more when the change is large or multi-domain.
  - For additional perspectives, mix Claude and Codex freely.
- Give each reviewer a unique, descriptive name (e.g. `codex-bug-scan`, `claude-conventions`, `codex-history`).

#### Codex mode

**Always use codex-teammate** (tmux bridge via `/codex-teammate` skill steps). Do NOT use `codex exec` unless the user explicitly requests it.

## Phase 2: Review (parallel)

Create a team with TeamCreate, then launch all reviewers in parallel.

### Claude reviewers

Launch each via the Agent tool in parallel. Provide each reviewer with:
- The diff
- Their specific focus area and instructions (from the table above)
- The relevant CLAUDE.md contents
- The change summary

Each reviewer must return findings in this format:
```
{ severity: "critical" | "warning" | "nit", confidence: 0-100, file: "path", line: number, description: "...", suggestion: "..." }
```

**Only report findings with confidence ≥ 60** (the validation phase will filter further).

### Codex reviewers (via codex-teammate)

For **each** Codex reviewer:

1. Start a bridge instance with a unique name:
   ```bash
   CODEX_PANE_<N>=$(tmux split-window -h -P -F '#{pane_id}' "npx --prefix <path-to-repo> tsx <path-to-repo>/src/index.ts --team {team-name} --name <reviewer-name> --cwd $(pwd); echo '[Bridge exited]'; read")
   ```
2. Wait 5 seconds for initialization.
3. Send the review task via `SendMessage` with the same context as Claude reviewers.
4. Collect the response.

### Test runner (optional)

If test files were added or modified, launch a test-runner agent to execute tests and report results.

## Phase 3: Validation (per-finding cross-check)

This is the key quality gate — each finding is independently validated.

### 3.1 Collect & deduplicate

1. Gather all findings from all reviewers.
2. Group by file and line range. Merge duplicates, keeping the highest confidence score and noting all reporters.

### 3.2 Cross-validate each finding

For **each unique finding**, send it to **at least 2 validators** (different from the original reporter). Prefer mixed model diversity (1 Claude + 1 Codex when possible).

Each validator independently scores the finding on this rubric (provide verbatim):

> - **0**: False positive. Doesn't stand up to scrutiny, or is a pre-existing issue.
> - **25**: Might be real, but might be a false positive. If stylistic, not explicitly in CLAUDE.md.
> - **50**: Real issue, but a nitpick or rare in practice. Not important relative to the rest of the change.
> - **75**: Very likely real and will be hit in practice. The existing approach is insufficient. Important and directly impacts functionality, or is directly mentioned in CLAUDE.md.
> - **100**: Definitely real and will happen frequently. Evidence directly confirms this.

### 3.3 Filter

- **Keep**: Finding where ≥ 2/3 of validators score ≥ 80.
- **Drop**: Finding where ≥ 2/3 of validators score < 50.
- **Contested**: Everything else — proceed to iteration.

## Phase 4: Iterative consensus (for contested findings)

For each contested finding, run additional rounds:

### Each round

1. Share the finding + all validator scores/reasoning with **2 new reviewers** who haven't seen it yet (or the same reviewers with additional context if no new reviewers are available).
2. Collect their independent scores.
3. Re-evaluate using the same filter criteria from Phase 3.3.

### Exit criteria

Stop when **all** of the following are true:
- No contested findings remain (all are either kept or dropped).
- No reviewer has flagged new issues in the latest round.

Typically 1–2 rounds of iteration suffice. If after **5 rounds** a finding is still contested, mark it as "disputed" in the report with all perspectives included.

## Shutdown

After the review is complete, shut down **all** Codex teammates:
1. Send `shutdown_request` via `SendMessage` to each Codex reviewer.
2. After `shutdown_approved`, close each pane:
   ```bash
   tmux kill-pane -t $CODEX_PANE_<N>
   ```

## Report

Present a unified review summary.

### False positive guidance

The following are common false positives — do **not** report these:
- Pre-existing issues not introduced by this change
- Issues a linter, typechecker, or compiler would catch (assume CI runs these)
- General code quality issues (e.g. lack of test coverage) unless explicitly required in CLAUDE.md
- Issues called out in CLAUDE.md but explicitly silenced in code (e.g. lint ignore comments)
- Functionality changes that are clearly intentional
- Real issues on lines the author did not modify

### Format

```markdown
# Review Summary

## Critical Issues (confidence ≥ 90) — must fix
- [file:line] Description (confidence: X, flagged by: reviewer-a, validated by: reviewer-b, reviewer-c)
  - Why: explanation
  - Fix: concrete suggestion

## Warnings (confidence 80–89) — should fix
- [file:line] Description (confidence: X, flagged by: ..., validated by: ...)
  - Why: explanation
  - Fix: concrete suggestion

## Disputed (no consensus after iteration)
- [file:line] Description
  - Perspectives: reviewer-a (score: X, reason: ...), reviewer-b (score: Y, reason: ...)

## Test Results
- (if tests were run)

## Positive Observations
- What's well-done in this change

## Overall Assessment
- Approve / Request changes
- Reviewer count: X Claude + Y Codex
- Consensus: X/Y findings validated, Z disputed
```
