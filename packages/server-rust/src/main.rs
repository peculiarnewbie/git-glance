mod cache;
mod git;
mod opencode;
mod peer;
mod scanner;
mod types;
mod ws;

#[cfg(windows)]
mod windows_service;

use std::io;
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

#[derive(Clone)]
pub struct CliArgs {
    pub port: u16,
    pub static_dir: Option<String>,
    pub dev_url: Option<String>,
    pub machine_name: Option<String>,
    pub token: Option<String>,
    pub install_service: bool,
    pub uninstall_service: bool,
    pub install_startup: bool,
    pub uninstall_startup: bool,
}

fn hostname_or_default() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "local".to_string())
}

pub fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().collect();
    let mut port = 3451u16;
    let mut static_dir = None;
    let mut dev_url = None;
    let mut machine_name = None;
    let mut token = None;
    let mut install_service = false;
    let mut uninstall_service = false;
    let mut install_startup = false;
    let mut uninstall_startup = false;

    let mut i = 1;
    while i < args.len() {
        let (flag, inline_value) = if let Some(idx) = args[i].find('=') {
            let (k, v) = args[i].split_at(idx);
            (k.to_string(), Some(v[1..].to_string()))
        } else {
            (args[i].clone(), None)
        };
        let value_from_next: Option<String> = if inline_value.is_none() {
            args.get(i + 1).cloned()
        } else {
            None
        };
        let consumed_next = inline_value.is_none() && value_from_next.is_some();
        match flag.as_str() {
            "--port" => {
                let v = inline_value.or(value_from_next);
                if let Some(v) = v {
                    port = v.parse().unwrap_or(3451);
                }
            }
            "--static" => {
                if let Some(v) = inline_value.or(value_from_next) {
                    static_dir = Some(v);
                }
            }
            "--dev-url" => {
                if let Some(v) = inline_value.or(value_from_next) {
                    dev_url = Some(v);
                }
            }
            "--name" => {
                if let Some(v) = inline_value.or(value_from_next) {
                    machine_name = Some(v);
                }
            }
            "--token" => {
                if let Some(v) = inline_value.or(value_from_next) {
                    token = Some(v);
                }
            }
            "--install-service" => {
                install_service = true;
            }
            "--uninstall-service" => {
                uninstall_service = true;
            }
            "--install-startup" => {
                install_startup = true;
            }
            "--uninstall-startup" => {
                uninstall_startup = true;
            }
            "--windows-service" => {
                std::env::set_var("GIT_GLANCE_WINDOWS_SERVICE", "1");
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            _ => {}
        }
        if consumed_next {
            i += 2;
        } else {
            i += 1;
        }
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
        install_startup,
        uninstall_startup,
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
    println!("  --install-startup          Register for auto-start at logon (Windows Run key / Linux systemd user)");
    println!("  --uninstall-startup        Remove the auto-start entry");
    println!("  --install-service          Install as auto-starting service (systemd on Linux, Windows Service on Windows)");
    println!("  --uninstall-service        Remove the service");
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

fn find_workspace_root() -> Option<PathBuf> {
    let markers = ["pnpm-workspace.yaml", "pnpm-workspace.yml", "Cargo.toml"];
    let starting_dirs: Vec<PathBuf> = std::env::current_dir()
        .into_iter()
        .chain(
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .into_iter(),
        )
        .collect();

    for start in starting_dirs {
        let mut dir = start;
        loop {
            for marker in &markers {
                let candidate = dir.join(marker);
                if candidate.exists() {
                    return Some(dir);
                }
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

fn resolve_static_dir(cli_static: &Option<String>) -> Option<PathBuf> {
    if let Some(d) = cli_static {
        let path = PathBuf::from(d);
        if path.join("index.html").exists() {
            return Some(path);
        }
        return std::fs::canonicalize(d).ok().or(Some(path));
    }

    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("public"),
        PathBuf::from("packages/desktop/renderer-dist"),
        PathBuf::from("../desktop/renderer-dist"),
        PathBuf::from("../../desktop/renderer-dist"),
    ];

    if let Some(ws) = find_workspace_root() {
        candidates.push(ws.join("packages/desktop/renderer-dist"));
    }

    let binary_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let search_roots: Vec<PathBuf> = std::env::current_dir()
        .into_iter()
        .chain(binary_dir.into_iter())
        .collect();

    for root in search_roots {
        for c in &candidates {
            let abs = if c.is_absolute() {
                c.clone()
            } else {
                root.join(c)
            };
            if abs.join("index.html").exists() {
                return Some(abs);
            }
        }
    }

    None
}

fn install_service(args: &CliArgs) {
    #[cfg(windows)]
    {
        windows_service::install(args);
    }
    #[cfg(not(windows))]
    {
        install_service_linux(args);
    }
}

fn uninstall_service() {
    #[cfg(windows)]
    {
        windows_service::uninstall();
    }
    #[cfg(not(windows))]
    {
        uninstall_service_linux();
    }
}

#[cfg(not(windows))]
fn install_service_linux(args: &CliArgs) {
    let binary = resolve_binary_path();
    let static_dir =
        resolve_static_dir(&args.static_dir).unwrap_or_else(|| PathBuf::from("public"));
    let unit_dir = systemd_user_dir();
    let unit_path = unit_dir.join(format!("{}.service", SERVICE_NAME));
    let static_dir_str = static_dir.to_string_lossy().to_string();
    let unit_content = generate_unit(args.port, &static_dir_str, &binary);

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

#[cfg(not(windows))]
fn uninstall_service_linux() {
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

#[cfg(windows)]
mod startup;

#[tokio::main]
async fn main() {
    let args = parse_args();

    if args.install_startup {
        #[cfg(windows)]
        startup::install(&args);
        #[cfg(not(windows))]
        {
            let _ = &args;
            eprintln!("--install-startup not yet implemented for this platform");
        }
        return;
    }
    if args.uninstall_startup {
        #[cfg(windows)]
        startup::uninstall();
        return;
    }

    if args.install_service {
        install_service(&args);
        return;
    }
    if args.uninstall_service {
        uninstall_service();
        return;
    }

    #[cfg(windows)]
    {
        if std::env::var("GIT_GLANCE_WINDOWS_SERVICE").is_ok() {
            if let Err(e) = windows_service::run_service_dispatcher() {
                eprintln!("service dispatcher failed: {e}");
                std::process::exit(1);
            }
            return;
        }
    }

    let port = args.port;
    if let Err(err) = run_server(args).await {
        eprintln!("{}", server_error_message(&err, port));
        std::process::exit(1);
    }
}

pub(crate) fn server_error_message(err: &io::Error, port: u16) -> String {
    if err.kind() == io::ErrorKind::AddrInUse {
        format!("port {port} is already in use; another git-glance server may already be running")
    } else {
        format!("server failed: {err}")
    }
}

pub async fn run_server(args: CliArgs) -> io::Result<()> {
    let port = args.port;
    let static_dir_arg = args.static_dir.clone();
    let dev_url = args.dev_url.clone();
    let machine_name = args
        .machine_name
        .clone()
        .unwrap_or_else(hostname_or_default);
    let token_arg = args.token.clone();

    let home_dir = dirs::home_dir().expect("cannot get home dir");
    let config_dir = std::env::var("CONFIG_DIR")
        .unwrap_or_else(|_| home_dir.join(".git-glance").to_string_lossy().to_string());

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

    let static_dir = resolve_static_dir(&static_dir_arg);
    if let Some(ref d) = static_dir {
        println!("Serving static files from {}", d.display());
    } else {
        println!("No static directory found, running API-only mode");
    }

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

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == io::ErrorKind::AddrInUse => return Err(err),
        Err(err) => return Err(err),
    };
    axum::serve(listener, app.into_make_service())
        .await
        .map_err(io::Error::other)
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

async fn static_handler(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response<Body> {
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
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
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
