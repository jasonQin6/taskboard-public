# MEA dispatch — issue #50 r3

- Issue: original-repository issue #50
- Profile: `$HOME/.codex/skills/MEA/projects/jasonQin6-taskboard.md`
- Branch: `codex/issue-batch`
- Dispatch parent tip: `a2308a8e3a0d551a678717dd3962f1991d5880d2`
- Base SHA: the SHA of this dispatch commit; executor must start from it and return it unchanged.
- Round: 3
- Prior evidence: `.mea/audits/issue-50-r2.md`, `.mea/decisions/issue-50-r2.md`

## Scope

Fix only `F50-B1`: `mergeKnownTurnState` must not seed merged-session coverage from persisted
ordinals when the scan is a rewritten source replay. A rewrite deletes the same source's old turns
before replay, so using those ordinals would persist evidence that no longer exists after the
same commit.

Allowed files:

- `src/reader/scanner.ts`
- `test/reader.test.ts`

Do not reopen the four findings already closed in r2, and do not change unrelated behavior.

## Required behavior

1. Preserve coverage seeding for a non-rewritten scan of a merged session without window turns.
2. Disable coverage seeding when `rewritten=true`, consistent with `parseStateFor`'s existing
   `rewritten ? null` rule.
3. Add a regression fixture covering rewrite + multiple sessions + a compaction in the replayed
   window. It must prove the resulting summary does not claim coverage sourced from turns deleted
   by the same scan.

## Acceptance commands

- `pnpm test`
- `pnpm typecheck`
- `pnpm test:ui` only if a WebUI file changes

For the new regression test, perform one bounded mutation check that makes it fail, restore the
source, and record the mutation and final command result.

## Evidence to return

Return the exact implementation commit SHA, base SHA, commands and pass/fail counts, mutation check,
changed files, residual risks, and the skills/playbooks actually used. Leave the worktree clean.
