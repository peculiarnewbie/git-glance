use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures::{stream, Stream};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::types::{WSRequest, WSResponse};
use crate::ws::{self, ServerDeps};

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static OPERATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct ApiState {
    deps: Arc<ServerDeps>,
    events: broadcast::Sender<ApiEvent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiEvent {
    operation_id: String,
    #[serde(rename = "type")]
    event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct RepoQuery {
    repo: String,
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
struct SearchQuery {
    query: Option<String>,
    state: Option<String>,
    #[serde(rename = "includeHidden")]
    include_hidden: Option<bool>,
    limit: Option<u64>,
}

#[derive(Deserialize)]
struct ActivityQuery {
    since: Option<i64>,
    #[serde(rename = "limitPerRepo")]
    limit_per_repo: Option<u64>,
    #[serde(rename = "includeHidden")]
    include_hidden: Option<bool>,
}

#[derive(Deserialize)]
struct DiffQuery {
    repo: String,
    file: String,
    status: String,
    #[serde(rename = "maxBytes")]
    max_bytes: Option<u64>,
}

#[derive(Deserialize)]
struct RepoBody {
    repo: String,
}

pub fn router(deps: Arc<ServerDeps>) -> Router {
    let (event_sender, _) = broadcast::channel(256);
    let state = Arc::new(ApiState {
        deps,
        events: event_sender,
    });
    Router::new()
        .route("/api/events", get(events))
        .route("/api/repos", get(repos))
        .route("/api/workspace", get(workspace))
        .route("/api/repos/status", get(repo_status))
        .route("/api/repos/search", get(search_repos))
        .route("/api/activity", get(activity))
        .route("/api/diff", get(diff))
        .route("/api/config", get(config).patch(set_config))
        .route("/api/repos/pull", post(pull))
        .route("/api/repos/push", post(push))
        .route("/api/repos/rescan", post(rescan))
        .route("/api/repos/check-pull", post(check_pull))
        .route("/api/repos/settings", patch(repo_settings))
        .route("/api/operations/scan", post(scan))
        .route("/api/operations/scan-only", post(scan_only))
        .route("/api/operations/commit", post(commit))
        .route("/api/operations/fetch", post(fetch_all))
        .route("/api/operations/cancel", post(cancel))
        .with_state(state)
}

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

async fn execute(state: &ApiState, action: &str, params: Value) -> ApiResult {
    let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let (tx, mut rx) = mpsc::channel(2);
    ws::handle_action(
        WSRequest {
            id,
            action: action.to_string(),
            params,
        },
        state.deps.clone(),
        tx,
    )
    .await;
    let response = rx.recv().await.ok_or_else(|| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "operation returned no response",
        )
    })?;
    let response: WSResponse = serde_json::from_str(&response).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid operation response",
        )
    })?;
    if response.msg_type == "error" {
        Err(error(StatusCode::BAD_REQUEST, response.error))
    } else {
        Ok(Json(response.data.unwrap_or(Value::Null)))
    }
}

fn start_operation(state: &ApiState, action: &'static str, params: Value) -> Json<Value> {
    let operation_id = OPERATION_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let state = state.clone();
    let event_operation_id = operation_id.clone();
    tokio::spawn(async move {
        let request_id = format!("operation-{event_operation_id}");
        let (tx, mut rx) = mpsc::channel(128);
        let deps = state.deps.clone();
        tokio::spawn(async move {
            ws::handle_action(
                WSRequest {
                    id: request_id,
                    action: action.to_string(),
                    params,
                },
                deps,
                tx,
            )
            .await;
        });
        while let Some(message) = rx.recv().await {
            let Ok(response) = serde_json::from_str::<WSResponse>(&message) else {
                continue;
            };
            let (event_type, data, event_error) = match response.msg_type.as_str() {
                "progress" => ("progress", response.data, None),
                "done" => ("done", None, None),
                "error" => ("error", None, Some(response.error)),
                "result" => ("done", response.data, None),
                _ => continue,
            };
            let _ = state.events.send(ApiEvent {
                operation_id: event_operation_id.clone(),
                event_type: event_type.to_string(),
                data,
                error: event_error,
            });
        }
    });
    Json(json!({ "operationId": operation_id }))
}

async fn events(
    State(state): State<Arc<ApiState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.events.subscribe();
    let stream = stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    let event = Event::default().event(event.event_type).data(data);
                    return Some((Ok(event), receiver));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn repos(State(state): State<Arc<ApiState>>) -> ApiResult {
    execute(&state, "getRepos", json!({})).await
}

async fn workspace(State(state): State<Arc<ApiState>>) -> ApiResult {
    execute(&state, "getWorkspaceStatus", json!({})).await
}

async fn repo_status(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<RepoQuery>,
) -> ApiResult {
    execute(
        &state,
        "getRepoStatus",
        json!({ "repo": query.repo, "refresh": query.refresh }),
    )
    .await
}

async fn search_repos(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<SearchQuery>,
) -> ApiResult {
    execute(
        &state,
        "searchRepos",
        json!({
            "query": query.query,
            "state": query.state,
            "includeHidden": query.include_hidden,
            "limit": query.limit,
        }),
    )
    .await
}

async fn activity(
    State(state): State<Arc<ApiState>>,
    Query(query): Query<ActivityQuery>,
) -> ApiResult {
    execute(
        &state,
        "getRecentActivity",
        json!({
            "since": query.since,
            "limitPerRepo": query.limit_per_repo,
            "includeHidden": query.include_hidden,
        }),
    )
    .await
}

async fn diff(State(state): State<Arc<ApiState>>, Query(query): Query<DiffQuery>) -> ApiResult {
    execute(
        &state,
        "getDiff",
        json!({
            "repo": query.repo,
            "file": query.file,
            "status": query.status,
            "maxBytes": query.max_bytes,
        }),
    )
    .await
}

async fn config(State(state): State<Arc<ApiState>>) -> ApiResult {
    execute(&state, "getConfig", json!({})).await
}

async fn set_config(State(state): State<Arc<ApiState>>, Json(params): Json<Value>) -> ApiResult {
    execute(&state, "setConfig", params).await
}

async fn pull(State(state): State<Arc<ApiState>>, Json(body): Json<RepoBody>) -> ApiResult {
    execute(&state, "pull", json!({ "repo": body.repo })).await
}

async fn push(State(state): State<Arc<ApiState>>, Json(body): Json<RepoBody>) -> ApiResult {
    execute(&state, "push", json!({ "repo": body.repo })).await
}

async fn rescan(State(state): State<Arc<ApiState>>, Json(body): Json<RepoBody>) -> ApiResult {
    execute(&state, "rescanRepo", json!({ "repo": body.repo })).await
}

async fn check_pull(State(state): State<Arc<ApiState>>, Json(body): Json<RepoBody>) -> ApiResult {
    execute(&state, "checkPull", json!({ "repo": body.repo })).await
}

async fn repo_settings(State(state): State<Arc<ApiState>>, Json(params): Json<Value>) -> ApiResult {
    execute(&state, "updateRepoSettings", params).await
}

async fn scan(State(state): State<Arc<ApiState>>, Json(params): Json<Value>) -> Json<Value> {
    start_operation(&state, "scan", params)
}

async fn scan_only(State(state): State<Arc<ApiState>>, Json(params): Json<Value>) -> Json<Value> {
    start_operation(&state, "scanOnly", params)
}

async fn commit(State(state): State<Arc<ApiState>>, Json(params): Json<Value>) -> Json<Value> {
    start_operation(&state, "commitPush", params)
}

async fn fetch_all(State(state): State<Arc<ApiState>>) -> Json<Value> {
    start_operation(&state, "fetchAll", json!({}))
}

async fn cancel(State(state): State<Arc<ApiState>>) -> ApiResult {
    execute(&state, "cancel", json!({})).await
}
