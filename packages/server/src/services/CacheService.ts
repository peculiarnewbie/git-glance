import { Context, Data, Effect, Schema } from "effect"
import { GitRepo } from "@git-glance/schema"
import { readFile as readFileAsync, writeFile as writeFileAsync, mkdir as mkdirAsync } from "node:fs/promises"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export class CacheError extends Data.TaggedError("CacheError")<{
  readonly cause: string
}> {}

export interface PersistedConfig {
  readonly rootDir?: string
  readonly opencodeModel?: string
  readonly machines?: ReadonlyArray<{ readonly name: string; readonly url: string }>
}

export interface CacheServiceShape {
  readonly load: () => Effect.Effect<ReadonlyArray<GitRepo>, CacheError>
  readonly save: (repos: ReadonlyArray<GitRepo>) => Effect.Effect<void, CacheError>
  readonly getScannedDirs: () => Effect.Effect<ReadonlyArray<string>>
  readonly addScannedDir: (dir: string) => Effect.Effect<void>
  readonly loadConfig: () => Effect.Effect<PersistedConfig>
  readonly saveConfig: (config: PersistedConfig) => Effect.Effect<void>
  readonly setRemoteRepos: (machine: string, repos: ReadonlyArray<GitRepo>) => Effect.Effect<void>
  readonly getRemoteReposMap: () => Effect.Effect<Map<string, ReadonlyArray<GitRepo>>>
  readonly getAllRepos: () => Effect.Effect<ReadonlyArray<GitRepo>, CacheError>
}

export const CacheService = Context.Service<CacheServiceShape>(
  "@git-glance/CacheService",
)

export const CacheServiceLive = (options: {
  readonly cachePath: string
  readonly configPath: string
}): CacheServiceShape => {
  const cacheDir = dirname(options.cachePath)
  const configDir = dirname(options.configPath)

  // In-memory state for remote repos and scanned dirs
  let remoteRepos: Map<string, ReadonlyArray<GitRepo>> = new Map()
  let scannedDirs: ReadonlyArray<string> = []

  const self: CacheServiceShape = {
    load: () =>
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: () => readFileAsync(options.cachePath, "utf-8"),
          catch: (e) => new CacheError({ cause: String(e) }),
        }).pipe(Effect.catch(() => Effect.succeed("[]")))

        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: () => {
            throw new CacheError({ cause: "Invalid JSON" })
          },
        }).pipe(Effect.catch(() => Effect.succeed([] as unknown)))

        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(GitRepo))(parsed).pipe(
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

        const encoded = yield* Schema.encodeUnknownEffect(Schema.Array(GitRepo))(
          repos as Array<GitRepo>,
        ).pipe(Effect.mapError((e) => new CacheError({ cause: e.message })))

        yield* Effect.tryPromise({
          try: () => writeFileAsync(options.cachePath, JSON.stringify(encoded), "utf-8"),
          catch: (e) => new CacheError({ cause: String(e) }),
        })
      }),

    getScannedDirs: () => Effect.sync(() => [...scannedDirs]),

    addScannedDir: (dir) =>
      Effect.sync(() => {
        if (!scannedDirs.includes(dir)) scannedDirs = [...scannedDirs, dir]
      }),

    loadConfig: () =>
      Effect.sync(() => {
        try {
          const raw = readFileSync(options.configPath, "utf-8")
          return JSON.parse(raw) as PersistedConfig
        } catch {
          return {} as PersistedConfig
        }
      }),

    saveConfig: (config) =>
      Effect.sync(() => {
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
        writeFileSync(options.configPath, JSON.stringify(config, null, 2), "utf-8")
      }),

    setRemoteRepos: (machine, repos) =>
      Effect.sync(() => {
        const next = new Map(remoteRepos)
        next.set(machine, repos)
        remoteRepos = next
      }),

    getRemoteReposMap: () => Effect.sync(() => new Map(remoteRepos)),

    getAllRepos: () =>
      Effect.gen(function* () {
        const local = yield* self.load()
        const all = [...local]
        for (const repos of remoteRepos.values()) {
          all.push(...repos)
        }
        return all
      }),
  }

  return self
}
