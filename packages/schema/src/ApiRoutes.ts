import { Schema } from "effect"
import { GitRepo, GitRepoSettings } from "./GitRepo.js"

export class MachineStatus extends Schema.Class<MachineStatus>("MachineStatus")({
  name: Schema.String,
  url: Schema.String,
  online: Schema.Boolean,
  lastSeen: Schema.NullOr(Schema.Number),
}) {}

export class ServerConfigSchema extends Schema.Class<ServerConfigSchema>("ServerConfig")({
  rootDir: Schema.NullOr(Schema.String),
  opencodeModel: Schema.String,
  machines: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
    }),
  ),
}) {}

/**
 * Response returned by GET /repos.
 */
export class ReposResponse extends Schema.Class<ReposResponse>("ReposResponse")({
  repos: Schema.Array(GitRepo),
  scannedAt: Schema.Number,
  scannedDirs: Schema.Array(Schema.String),
  machines: Schema.Array(MachineStatus),
}) {}

export class PullPushResult extends Schema.Class<PullPushResult>("PullPushResult")({
  ok: Schema.Boolean,
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
}) {}

export class CommitProgress extends Schema.Class<CommitProgress>("CommitProgress")({
  phase: Schema.Literals(["staging", "generating", "committing", "pushing", "done", "error"]),
  error: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  repoPath: Schema.NullOr(Schema.String),
}) {}

export class FetchProgress extends Schema.Class<FetchProgress>("FetchProgress")({
  phase: Schema.Literals(["fetching", "repo", "done"]),
  repoPath: Schema.NullOr(Schema.String),
  repoName: Schema.NullOr(Schema.String),
  current: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  total: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ahead: Schema.NullOr(Schema.Number),
  behind: Schema.NullOr(Schema.Number),
  branch: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
}) {}

export { GitRepoSettings } from "./GitRepo.js"
