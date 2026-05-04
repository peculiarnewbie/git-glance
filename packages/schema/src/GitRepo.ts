import { Schema } from "effect"

/**
 * The git status for a single repository.
 *
 * Using branded types at the boundary – path is validated once
 * and trusted downstream.
 */
export class GitRepo extends Schema.Class<GitRepo>("GitRepo")({
  name: Schema.String,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  hasChanges: Schema.Boolean,
  staged: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  unstaged: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  untracked: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ahead: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  behind: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  remote: Schema.NullOr(Schema.String),
  lastCommitTime: Schema.NullOr(Schema.Number),
  weekCommits: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  lastScanTime: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
}) {}
