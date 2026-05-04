import { Context, Data, Effect, Schema } from "effect"
import { GitRepo } from "@git-glance/schema"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"

export class CacheError extends Data.TaggedError("CacheError")<{
  readonly cause: string
}> {}

export interface CacheServiceShape {
  readonly load: () => Effect.Effect<ReadonlyArray<GitRepo>, CacheError>
  readonly save: (repos: ReadonlyArray<GitRepo>) => Effect.Effect<void, CacheError>
}

export const CacheService = Context.Service<CacheServiceShape>(
  "@git-glance/CacheService",
)

export const CacheServiceLive = (options: {
  readonly cachePath: string
}): CacheServiceShape => {
  const cacheDir = dirname(options.cachePath)

  return {
    load: () =>
      Effect.gen(function* () {
        // Read file — if missing, treat as empty
        const raw = yield* Effect.tryPromise({
          try: () => readFile(options.cachePath, "utf-8"),
          catch: (e) => new CacheError({ cause: String(e) }),
        }).pipe(Effect.catch(() => Effect.succeed("[]")))

        // Parse JSON — if corrupted, treat as empty
        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (e) => {
            throw new CacheError({ cause: String(e) })
          },
        }).pipe(Effect.catch(() => Effect.succeed([] as unknown)))

        // Validate against schema — if invalid, treat as empty
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Array(GitRepo),
        )(parsed).pipe(
          Effect.catch(() => Effect.succeed([] as Array<GitRepo>)),
        )

        return decoded
      }),

    save: (repos) =>
      Effect.gen(function* () {
        if (!existsSync(cacheDir)) {
          yield* Effect.tryPromise({
            try: () => mkdir(cacheDir, { recursive: true }),
            catch: (e) => new CacheError({ cause: String(e) }),
          })
        }

        const encoded = yield* Schema.encodeUnknownEffect(
          Schema.Array(GitRepo),
        )(repos as Array<GitRepo>).pipe(
          Effect.mapError((e) => new CacheError({ cause: e.message })),
        )

        yield* Effect.tryPromise({
          try: () => writeFile(options.cachePath, JSON.stringify(encoded), "utf-8"),
          catch: (e) => new CacheError({ cause: String(e) }),
        })
      }),
  }
}
