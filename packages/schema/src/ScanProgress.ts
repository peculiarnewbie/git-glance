import { Schema } from "effect"
import { GitRepo } from "./GitRepo.js"

/**
 * Streamed from server → clients during a scan.
 */
export class ScanProgress extends Schema.Class<ScanProgress>("ScanProgress")({
  phase: Schema.Literals(["discovering", "scanning", "done"]),
  total: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  current: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  repo: Schema.NullOr(GitRepo),
}) {}
