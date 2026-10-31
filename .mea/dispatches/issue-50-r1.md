# MEA dispatch — issue #50 r1

- Issue: https://github.com/jasonQin6/taskboard/issues/50
- Profile: `$HOME/.codex/skills/MEA/projects/jasonQin6-taskboard.md`
- Branch: `codex/issue-batch`
- Dispatch parent tip: `d3dadd1ea438d45e627d9e8829a59acb0f9df31e`
- Base SHA: the SHA of this dispatch commit; executor must start from it and return it unchanged in its result.
- Round: 1
- Native blockers: #51 is closed; #50 has no open blocker.

## Resolved assumptions

- The issue body's old per-issue-branch instruction conflicts with the project profile. The profile owns MEA topology: stay on `codex/issue-batch`, create no worktree, per-issue branch, or PR.
- F6 must preserve a compaction's identity while replacing the whole locator tuple. Do not leave an old `source_id` paired with a new `byte_start` or `record_hash`.
- A compaction removed by a source rewrite must not remain silently traceable at its old byte position. It must be superseded or carry an explicit not-traceable projection.
- F7 may report `coveredThroughTurnOrdinal: null` only when no ordinal can be proved for the same persisted thread/source. A null or low value from the current parse window alone is not acceptable.
- F9 requires a persisted or equivalent explicit distinction between a start-record locator and a terminal-record fallback locator; nullable byte offsets alone do not encode that distinction.
- F10 must exercise the real V7-to-V8 migration path, not merely insert a post-V8 row.

## Allowed scope

- `src/reader/**`
- `src/store/**`
- `src/schema.ts`
- Related HTTP locator projections and WebUI locator types/presentation
- `test/**`

Do not modify ZCode, SystemOne, execution/resume behavior, Harness storage, runtime dependencies, or unrelated product behavior.

## Required failure modes

1. Same source is rewritten at new byte positions while retaining a matching compaction record hash: the existing summary's `source_id`, `byte_start`, `record_hash`, and `covered_through_turn_ordinal` are refreshed together.
2. Rewrite deletes a compaction formerly emitted by that source: the old summary is superseded or explicitly marked not traceable, and latest-summary selection cannot present it as a valid source locator.
3. A compaction arrives in an incremental window whose turns were consumed in an earlier window: coverage uses a provable persisted ordinal for the same thread/source, or reports an explicit not-verifiable state rather than a guessed low value.
4. Turn locator projections distinguish start-record positioning from terminal-record fallback positioning; direct tests cover both kinds and preserve incomplete/unknown behavior.
5. V7→V8 migration backfills `record_hash` only for existing compacted summaries from `source_ref`, leaves sample summaries null, and preserves summary text/thread association and existing turn fields.

## Acceptance commands

- `pnpm test`
- `pnpm typecheck`
- `pnpm test:ui` if any WebUI file changes

For each newly added behavior-preserving regression test, perform at least one bounded mutation check that turns that test red, then restore the source and verify the final diff. Record the mutated wiring and command result.

## Evidence to return

Return exact implementation commit SHA, base SHA, commands and pass/fail counts, mutation checks, changed files, residual risks, and the skills/playbooks actually used. Leave the worktree clean.
