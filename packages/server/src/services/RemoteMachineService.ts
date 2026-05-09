import { Context, Data, Duration, Effect, Schedule } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { PersistedConfig } from "./CacheService.js"
import { GitRepo, MachineStatus } from "@git-glance/schema"
import * as Schema from "effect/Schema"

export class RemoteMachineError extends Data.TaggedError("RemoteMachineError")<{
  readonly machine: string
  readonly cause: string
}> {}

export interface RemoteMachineServiceShape {
  readonly startPolling: (config: PersistedConfig) => Effect.Effect<void>
  readonly updateConfig: (config: PersistedConfig) => Effect.Effect<void>
  readonly getStatuses: () => Effect.Effect<ReadonlyArray<MachineStatus>>
  readonly proxyRequest: (
    machineName: string,
    method: string,
    path: string,
    body?: string,
  ) => Effect.Effect<{ ok: boolean; output?: string; error?: string }, RemoteMachineError>
}

export const RemoteMachineService = Context.Service<RemoteMachineServiceShape>(
  "@git-glance/RemoteMachineService",
)

interface MachineState {
  readonly name: string
  readonly url: string
  readonly online: boolean
  readonly lastSeen: number | null
}

const initialState = (name: string, url: string): MachineState => ({
  name,
  url,
  online: false,
  lastSeen: null,
})

export const RemoteMachineServiceLive = (
  setRemoteRepos: (machine: string, repos: ReadonlyArray<GitRepo>) => Effect.Effect<void>,
  reloadRemoteRepos: () => Effect.Effect<void>,
): RemoteMachineServiceShape => {
  let machines: ReadonlyArray<MachineState> = []

  const fetchMachineRepos = (
    httpClient: HttpClient.HttpClient,
    machine: MachineState,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const response = yield* httpClient.get(`${machine.url}/repos`).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.catchAll((e) =>
          Effect.fail(new RemoteMachineError({ machine: machine.name, cause: String(e) })),
        ),
      )

      const body = yield* HttpClientResponse.json(response)
      const typed = body as { repos?: Array<Record<string, unknown>> }
      const repos = typed.repos ?? []

      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(GitRepo))(repos).pipe(
        Effect.catch(() => Effect.succeed([] as Array<GitRepo>)),
      )

      const tagged = decoded.map(
        (r) =>
          new GitRepo({
            ...r,
            machine: machine.name,
            settings: null,
          }),
      )

      yield* setRemoteRepos(machine.name, tagged)
      machines = machines.map((m) =>
        m.name === machine.name ? { ...m, online: true, lastSeen: Date.now() } : m,
      )
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          machines = machines.map((m) =>
            m.name === machine.name ? { ...m, online: false } : m,
          )
          yield* setRemoteRepos(machine.name, [])
        }),
      ),
    )

  const pollAll = (httpClient: HttpClient.HttpClient): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.forEach(machines, (m) => fetchMachineRepos(httpClient, m), {
        concurrency: 3,
        discard: true,
      })
      yield* reloadRemoteRepos()
    })

  return {
    startPolling: (config) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient
        machines = (config.machines ?? []).map((m) => initialState(m.name, m.url))

        yield* Effect.forkScoped(
          pollAll(httpClient).pipe(
            Effect.repeat(Schedule.spaced(Duration.seconds(30))),
            Effect.catchAll((e) =>
              Effect.logWarning("Remote machine polling error", { cause: String(e) }),
            ),
            Effect.forever,
          ),
        )
      }),

    updateConfig: (config) =>
      Effect.sync(() => {
        machines = (config.machines ?? []).map((m) => initialState(m.name, m.url))
      }),

    getStatuses: () =>
      Effect.sync(() =>
        machines.map(
          (m) =>
            new MachineStatus({
              name: m.name,
              url: m.url,
              online: m.online,
              lastSeen: m.lastSeen,
            }),
        ),
      ),

    proxyRequest: (machineName, method, path, body) =>
      Effect.gen(function* () {
        const machine = machines.find((m) => m.name === machineName)
        if (!machine) {
          return yield* Effect.fail(
            new RemoteMachineError({ machine: machineName, cause: "Unknown machine" }),
          )
        }

        const httpClient = yield* HttpClient.HttpClient
        const url = `${machine.url}${path}`
        const response = yield* httpClient
          .request(method, url, body ? { body } : undefined)
          .pipe(
            Effect.timeout(Duration.seconds(30)),
            Effect.catchAll((e) =>
              Effect.fail(new RemoteMachineError({ machine: machineName, cause: String(e) })),
            ),
          )

        const result: { ok?: boolean; output?: string; error?: string } = yield* HttpClientResponse.json(response)

        return { ok: result.ok ?? false, output: result.output, error: result.error }
      }),
  }
}
