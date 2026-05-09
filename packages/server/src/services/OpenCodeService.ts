import { Context, Data, Effect } from "effect"
import { exec } from "node:child_process"

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly cause: string
}> {}

export interface CommitMessage {
  readonly subject: string
  readonly body: string
}

export interface OpenCodeServiceShape {
  readonly generateCommitMessage: (params: {
    readonly repoPath: string
    readonly branch: string
    readonly stagedSummary: string
    readonly stagedPatch: string
    readonly model: string
  }) => Effect.Effect<CommitMessage, OpenCodeError>
}

export const OpenCodeService = Context.Service<OpenCodeServiceShape>(
  "@git-glance/OpenCodeService",
)

function buildPrompt(branch: string, stagedSummary: string, stagedPatch: string): string {
  const truncate = (str: string, max: number) =>
    str.length > max ? str.slice(0, max) + "\n... [truncated]" : str

  return [
    "You write concise git commit messages.",
    'Return a JSON object with keys: subject, body.',
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    "- capture the primary user-visible or developer-visible change",
    "",
    `Branch: ${branch ?? "(detached)"}`,
    "",
    "Staged files:",
    truncate(stagedSummary, 6000),
    "",
    "Staged patch:",
    truncate(stagedPatch, 40000),
  ].join("\n")
}

function execAsync(cmd: string, options: { cwd: string; timeout: number; stdin?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd: options.cwd, timeout: options.timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.toString().trim())
    })
    if (options.stdin != null) {
      child.stdin!.write(options.stdin)
      child.stdin!.end()
    }
  })
}

export const OpenCodeServiceLive: OpenCodeServiceShape = {
  generateCommitMessage: (params) =>
    Effect.gen(function* () {
      const prompt = buildPrompt(params.branch, params.stagedSummary, params.stagedPatch)

      const raw = yield* Effect.tryPromise({
        try: () =>
          execAsync(`opencode run --format json -m "${params.model}" --dir "${params.repoPath}"`, {
            cwd: params.repoPath,
            timeout: 120_000,
            stdin: prompt,
          }),
        catch: (e) => new OpenCodeError({ cause: String(e) }),
      })

      let rawText = ""
      for (const line of raw.split("\n").filter((l) => l.trim())) {
        try {
          const ev = JSON.parse(line) as { type?: string; part?: { text?: string } }
          if (ev.type === "text" && ev.part?.text) rawText += ev.part.text
        } catch {}
      }

      if (!rawText) {
        return yield* Effect.fail(new OpenCodeError({ cause: "No text response from opencode" }))
      }

      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return yield* Effect.fail(
          new OpenCodeError({ cause: "Could not parse JSON from opencode response" }),
        )
      }

      const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string }
      const subject = parsed.subject?.trim()
      const body = parsed.body?.trim() ?? ""

      if (!subject) {
        return yield* Effect.fail(new OpenCodeError({ cause: "No subject in commit message" }))
      }

      return { subject, body }
    }),
}
