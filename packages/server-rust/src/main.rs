mod cache;
mod git;
mod opencode;
mod peer;
mod scanner;
mod types;
mod ws;

use mimalloc::MiMalloc;
use std::net::SocketAddr;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;

struct AppState {
    deps: Arc<ws::ServerDeps>,
    static_dir: Option<PathBuf>,
    dev_url: Option<String>,
}

fn hostname_or_default() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "local".to_string())
}

fn parse_args() -> (u16, Option<String>, Option<String>, String, Option<String>) {
    let args: Vec<String> = std::env::args().collect();
    let mut port = 3456u16;
    let mut static_dir = None;
    let mut dev_url = None;
    let mut machine_name = None;
    let mut token = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                if let Some(v) = args.get(i) {
                    port = v.parse().unwrap_or(3456);
                }
            }
            "--static" => {
                i += 1;
                static_dir = args.get(i).cloned();
            }
            "--dev-url" => {
                i += 1;
                dev_url = args.get(i).cloned();
            }
            "--name" => {
                i += 1;
                machine_name = args.get(i).cloned();
            }
            "--token" => {
                i += 1;
                token = args.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }

    if let Ok(v) = std::env::var("PORT") {
        if let Ok(p) = v.parse() {
            port = p;
        }
    }
    if let Ok(v) = std::env::var("STATIC_DIR") {
        static_dir = Some(v);
    }
    if let Ok(v) = std::env::var("DEV_URL") {
        dev_url = Some(v);
    }
    if let Ok(v) = std::env::var("MACHINE_NAME") {
        machine_name = Some(v);
    }

    let machine_name = machine_name.unwrap_or_else(hostname_or_default);

    (port, static_dir, dev_url, machine_name, token)
}

#[tokio::main]
async fn main() {
    let (port, static_dir_arg, dev_url, machine_name, token_arg) = parse_args();

    let home_dir = dirs::home_dir().expect("cannot get home dir");
    let config_dir = std::env::var("CONFIG_DIR").unwrap_or_else(|_| {
        home_dir
            .join(".git-glance")
            .to_string_lossy()
            .to_string()
    });

    let cache_path = PathBuf::from(&config_dir).join("repo-cache.json");
    let config_path = PathBuf::from(&config_dir).join("config.json");

    let cache = Arc::new(cache::CacheService::new(cache_path, config_path));
    let git = Arc::new(git::GitService::new());

    let mut cfg = cache.load_config().await;
    let local_token = if let Some(t) = token_arg {
        t
    } else if !cfg.token.is_empty() {
        cfg.token.clone()
    } else {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
        let t = hex::encode(&bytes);
        cfg.token = t.clone();
        cache.save_config(&cfg).await;
        println!("[auth] generated new peer token: {}", t);
        t
    };

    let peers = Arc::new(peer::PeerManager::new(
        machine_name.clone(),
        local_token,
        cache.clone(),
        git.clone(),
    ));
    peers.update_config(&cfg).await;

    let deps = Arc::new(ws::ServerDeps {
        git: git.clone(),
        cache: cache.clone(),
        peers: peers.clone(),
        local_name: machine_name.clone(),
    });

    let static_dir = if let Some(dir) = static_dir_arg {
        Some(PathBuf::from(dir))
    } else {
        let candidates = vec![
            PathBuf::from("public"),
            PathBuf::from("../desktop/renderer-dist"),
        ];
        let mut found = None;
        for c in candidates {
            if let Ok(abs) = std::env::current_dir().map(|cwd| cwd.join(&c)) {
                if abs.join("index.html").exists() {
                    found = Some(abs);
                    break;
                }
            }
        }
        if let Some(ref d) = found {
            println!("Serving static files from {}", d.display());
        } else {
            println!("No static directory found, running API-only mode");
        }
        found
    };

    let state = Arc::new(AppState {
        deps,
        static_dir,
        dev_url,
    });

    let app = Router::new()
        .route("/ws", get(ws_upgrade_handler))
        .route("/peer", get(peer_upgrade_handler))
        .route("/health", get(health_handler))
        .fallback(get(static_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("Starting server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app.into_make_service())
        .await
        .unwrap();
}

async fn ws_upgrade_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| async move {
        ws::handle_ws_connection(socket, state.deps.clone()).await;
    })
}

async fn peer_upgrade_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| async move {
        peer::handle_peer_ws(socket, state.deps.peers.clone()).await;
    })
}

async fn health_handler() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok"}))
}

async fn static_handler(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Response<Body> {
    let path = req.uri().path();

    if path == "/ws" {
        return Response::builder()
            .status(StatusCode::UPGRADE_REQUIRED)
            .body(Body::from("WebSocket upgrade required"))
            .unwrap();
    }

    if let Some(ref dev_url) = state.dev_url {
        if let Some(host) = req.headers().get("host").and_then(|h| h.to_str().ok()) {
            let h = host.split(':').next().unwrap_or("");
            if h == "127.0.0.1" || h == "::1" || h == "localhost" {
                let redirect = format!("{}{}", dev_url, path);
                return Response::builder()
                    .status(StatusCode::FOUND)
                    .header("location", redirect)
                    .body(Body::empty())
                    .unwrap();
            }
        }
    }

    let static_dir = match state.static_dir {
        Some(ref d) => d,
        None => {
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"status":"git-glance API server"}"#))
                .unwrap();
        }
    };

    let file_path = static_dir.join(path.trim_start_matches('/'));
    if file_path.exists() && file_path.is_file() {
        match tokio::fs::read(&file_path).await {
            Ok(content) => {
                let mime = mime_from_path(&file_path);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", mime)
                    .body(Body::from(content))
                    .unwrap()
            }
            Err(_) => serve_index(static_dir).await,
        }
    } else if path == "/" {
        serve_index(static_dir).await
    } else {
        serve_index(static_dir).await
    }
}

async fn serve_index(static_dir: &Path) -> Response<Body> {
    let index = static_dir.join("index.html");
    match tokio::fs::read(&index).await {
        Ok(content) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .body(Body::from(content))
            .unwrap(),
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap(),
    }
}

fn mime_from_path(path: &Path) -> &str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
