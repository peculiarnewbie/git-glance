import { Schema } from "effect"
import { GitRepo } from "./GitRepo.js"

/**
 * Response returned by GET /repos.
 */
export class ReposResponse extends Schema.Class<ReposResponse>("ReposResponse")({
  repos: Schema.Array(GitRepo),
  scannedAt: Schema.Number,
}) {}
