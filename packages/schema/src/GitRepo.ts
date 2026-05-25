import { Schema } from "effect"

/**
 * The git status for a single repository.
 *
 * Using branded types at the boundary – path is validated once
 * and trusted downstream.
 */
class RepoName extends Schema.Class<RepoName>("RepoName")({
  value: Schema.String,
}) {}

class RepoPath extends Schema.Class<RepoPath>("RepoPath")({
  path: Schema.String,
}) {}

class RepoBranch extends Schema.Class<RepoBranch>("RepoBranch")({
  branch: Schema.String,
}) {}

class RepoRemote extends Schema.Class<RepoRemote>("RepoRemote")({
  remote: Schema.String,
}) {}

class RepoError extends Schema.Class<RepoError>("RepoError")({
  error: Schema.String,
}) {}

export class GitRepoSettings extends Schema.Class<GitRepoSettings>("GitRepoSettings")({
  skipUntracked: Schema.Boolean,
  skipPullCheck: Schema.Boolean,
  hidden: Schema.Boolean,
}) {}

export class GitRepo extends Schema.Class<GitRepo>("GitRepo")({
  name: RepoName,
  path: RepoPath,
  branch: Schema.NullOr(RepoBranch),
  hasChanges: Schema.Boolean,
  staged: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  unstaged: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  untracked: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ahead: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  behind: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  remote: Schema.NullOr(RepoRemote),
  lastCommitTime: Schema.NullOr(Schema.Number),
  weekCommits: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  lastScanTime: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(RepoError),
  machine: RepoName,
  settings: Schema.NullOr(GitRepoSettings),
}) {} {}
