# Core read API

The local server exposes a request/response WebSocket API at `/ws`. Send a
message shaped as `{ "id": "unique-id", "action": "...", "params": { ... } }`.
Successful responses have `type: "result"` and return the same `id`.

These actions are deliberately structured and read-only. They are suitable for
the desktop client today and for a future MCP adapter without requiring an AI
model in the server.

| Action | Parameters | Result |
| --- | --- | --- |
| `getRepos` | none | Cached local repositories and scanned directories. |
| `getWorkspaceStatus` | none | All cached repositories plus deterministic counts for dirty, ahead, behind, errored, and hidden repositories. |
| `getRepoStatus` | `repo` (required), `refresh` (optional) | One local repository. `refresh: true` refreshes it before returning. |
| `searchRepos` | `query`, `state` (`dirty`, `ahead`, `behind`, `error`, or `clean`), `includeHidden`, `limit` | Matching cached repositories. All filters are optional. |
| `getRecentActivity` | `since` (Unix seconds), `limitPerRepo` (1–100), `includeHidden` | Local commits grouped by repository. |
| `getDiff` | `repo`, `file`, `status` (`staged`, `unstaged`, or `untracked`), `maxBytes` (1 KiB–1 MiB) | A single local file diff with `truncated`, `returnedBytes`, and `totalBytes` metadata. The default limit is 256 KiB. |

`getRecentActivity` defaults to the previous 24 hours and reads at most 20
commits per repository. It runs up to four repository reads concurrently.

Repository status responses are cache snapshots. `generatedAt` describes when
the aggregate response was produced, while each repository's `lastScanTime`
describes its status freshness. `getRepoStatus` with `refresh: true` is the
explicit local refresh operation.

Repository arguments for refreshed status and diffs must identify an exact
repository in the local workspace cache. Diff file arguments must be normalized
relative paths, and untracked files are resolved canonically to prevent reads
through absolute paths, parent traversal, or symlinks leaving the repository.

Mutating actions (`pull`, `push`, `commitPush`, and scan/configuration actions)
remain part of the same protocol, but are intentionally outside this read API.
