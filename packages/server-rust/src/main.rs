mod cache;
mod git;
mod opencode;
mod peer;
mod scanner;
mod types;
mod ws;

use std::net::SocketAddr;
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

struct CliArgs {
    port: u16,
    static_dir: Option<String>,
    dev_url: Option<String>,
    machine_name: Option<String>,
    token: Option<String>,
    install_service: bool,
    uninstall_service: bool,
}

fn hostname_or_default() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "local".to_string())
}

fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().collect();
    let mut port = 3451u16;
    let mut static_dir = None;
    let mut dev_url = None;
    let mut machine_name = None;
    let mut token = None;
    let mut install_service = false;
    let mut uninstall_service = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                if let Some(v) = args.get(i) {
                    port = v.parse().unwrap_or(3451);
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
            "--install-service" => {
                install_service = true;
            }
            "--uninstall-service" => {
                uninstall_service = true;
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
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

    CliArgs {
        port,
        static_dir,
        dev_url,
        machine_name,
        token,
        install_service,
        uninstall_service,
    }
}

fn print_help() {
    println!("git-glance-serve — git repository dashboard server\n");
    println!("USAGE:");
    println!("  git-glance-serve [OPTIONS]\n");
    println!("OPTIONS:");
    println!("  --port <PORT>              Server port (default: 3451, env: PORT)");
    println!("  --static <DIR>             Static files directory (env: STATIC_DIR)");
    println!("  --dev-url <URL>            Vite dev server URL for proxy (env: DEV_URL)");
    println!("  --name <NAME>              Machine name (env: MACHINE_NAME, default: hostname)");
    println!("  --token <TOKEN>            Peer authentication token");
    println!("  --install-service          Install as systemd user service (auto-start on login)");
    println!("  --uninstall-service        Remove systemd user service");
    println!("  -h, --help                 Show this help");
}

const SERVICE_NAME: &str = "git-glance";

fn systemd_user_dir() -> PathBuf {
    dirs::config_dir()
        .expect("cannot get config dir")
        .join("systemd")
        .join("user")
}

fn generate_unit(port: u16, static_dir: &str, binary: &str) -> String {
    format!(
        r#"[Unit]
Description=Git Glance Dashboard
After=network.target

[Service]
Type=simple
ExecStart={binary} --static {static_dir} --port {port}
Restart=on-failure
RestartSec=5
Environment=CONFIG_DIR=%h/.git-glance

[Install]
WantedBy=default.target
"#,
        binary = binary,
        static_dir = static_dir,
        port = port,
    )
}

fn resolve_binary_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| format!("git-glance-serve"))
}

fn resolve_static_dir(cli_static: &Option<String>) -> String {
    if let Some(d) = cli_static {
        return std::fs::canonicalize(d)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| d.clone());
    }
    let binary_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let candidates = vec![
        PathBuf::from("public"),
        PathBuf::from("../desktop/renderer-dist"),
        PathBuf::from("../../desktop/renderer-dist"),
        PathBuf::from("packages/desktop/renderer-dist"),
    ];
    if let Some(ref bin_dir) = binary_dir {
        for c in &candidates {
            let abs = bin_dir.join(c);
            if abs.join("index.html").exists() {
                return abs.to_string_lossy().to_string();
            }
        }
    }
    for c in &candidates {
        if let Ok(abs) = std::env::current_dir().map(|cwd| cwd.join(c)) {
            if abs.join("index.html").exists() {
                return abs.to_string_lossy().to_string();
            }
        }
    }
    eprintln!("warning: no static directory found, using 'public'");
    "public".to_string()
}

fn install_service(args: &CliArgs) {
    let binary = resolve_binary_path();
    let static_dir = resolve_static_dir(&args.static_dir);
    let unit_dir = systemd_user_dir();
    let unit_path = unit_dir.join(format!("{}.service", SERVICE_NAME));
    let unit_content = generate_unit(args.port, &static_dir, &binary);

    std::fs::create_dir_all(&unit_dir).expect("cannot create systemd user dir");
    std::fs::write(&unit_path, &unit_content).expect("cannot write unit file");

    println!("Wrote {}", unit_path.display());

    let r = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    if r.is_err() {
        eprintln!("warning: could not run systemctl daemon-reload");
    }

    let r = std::process::Command::new("systemctl")
        .args(["--user", "enable", SERVICE_NAME])
        .status();
    match r {
        Ok(s) if s.success() => println!("Enabled {}", SERVICE_NAME),
        _ => eprintln!("warning: could not enable service"),
    }

    let r = std::process::Command::new("systemctl")
        .args(["--user", "restart", SERVICE_NAME])
        .status();
    match r {
        Ok(s) if s.success() => println!("Started {}", SERVICE_NAME),
        _ => eprintln!("warning: could not start service"),
    }

    println!("\ngit-glance is now installed as a user service.");
    println!("It will auto-start on login. Manage with:");
    println!("  systemctl --user status {SERVICE_NAME}");
    println!("  systemctl --user stop {SERVICE_NAME}");
    println!("  systemctl --user restart {SERVICE_NAME}");
    println!("  journalctl --user -u {SERVICE_NAME} -f");
}

fn uninstall_service() {
    let unit_dir = systemd_user_dir();
    let unit_path = unit_dir.join(format!("{}.service", SERVICE_NAME));

    let _ = std::process::Command::new("systemctl")
        .args(["--user", "stop", SERVICE_NAME])
        .status();

    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", SERVICE_NAME])
        .status();

    if unit_path.exists() {
        std::fs::remove_file(&unit_path).expect("cannot remove unit file");
        println!("Removed {}", unit_path.display());
    } else {
        println!("Service file not found at {}", unit_path.display());
    }

    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();

    println!("git-glance service uninstalled.");
}

#[tokio::main]
async fn main() {
    let args = parse_args();

    if args.install_service {
        install_service(&args);
        return;
    }
    if args.uninstall_service {
        uninstall_service();
        return;
    }

    let port = args.port;
    let static_dir_arg = args.static_dir.clone();
    let dev_url = args.dev_url.clone();
    let machine_name = args
        .machine_name
        .clone()
        .unwrap_or_else(hostname_or_default);
    let token_arg = args.token.clone();

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

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!("Starting server on http://git-glance.local:{}", port);

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
