# HTTP and SSE API

The server exposes JSON endpoints for request/response work and a server-sent
event stream for long-running operations. The browser-facing WebSocket API has
been removed.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/repos` | Cached local repositories and scanned directories. |
| `GET /api/workspace` | Repository list and deterministic dirty/ahead/behind/error counts. |
| `GET /api/repos/status?repo=…&refresh=true` | One local repository, optionally refreshed. |
| `GET /api/repos/search` | Search cached repositories by query/state/visibility. |
| `GET /api/activity` | Recent local commits, grouped by repository. |
| `GET /api/diff` | One bounded local file diff. |
| `GET/PATCH /api/config` | Read or update local server configuration. |
| `POST /api/repos/{pull,push,rescan,check-pull}` | Explicit repository operations. |
| `PATCH /api/repos/settings` | Update repository settings. |
| `POST /api/operations/{scan,scan-only,commit,fetch}` | Start an asynchronous operation and return `operationId`. |
| `GET /api/events` | SSE stream for operation `progress`, `done`, and `error` events. |

Activity defaults to the previous 24 hours and reads at most 20 commits per
repository. It runs up to four repository reads concurrently.

Repository status responses are cache snapshots. `generatedAt` describes when
the aggregate response was produced, while each repository's `lastScanTime`
describes its status freshness. The repository status endpoint with
`refresh=true` is the explicit local refresh operation.

Repository arguments for refreshed status and diffs must identify an exact
repository in the local workspace cache. Diff file arguments must be normalized
relative paths, and untracked files are resolved canonically to prevent reads
through absolute paths, parent traversal, or symlinks leaving the repository.
