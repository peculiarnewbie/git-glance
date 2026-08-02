use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use windows_service::define_windows_service;
use windows_service::service::ServiceAccess;
use windows_service::service::ServiceControl;
use windows_service::service::ServiceControlAccept;
use windows_service::service::ServiceErrorControl;
use windows_service::service::ServiceExitCode;
use windows_service::service::ServiceInfo;
use windows_service::service::ServiceStartType;
use windows_service::service::ServiceState;
use windows_service::service::ServiceStatus;
use windows_service::service::ServiceType;
use windows_service::service_control_handler;
use windows_service::service_control_handler::ServiceControlHandlerResult;
use windows_service::service_dispatcher;
use windows_service::service_manager::ServiceManager;
use windows_service::service_manager::ServiceManagerAccess;

use crate::CliArgs;

pub const SERVICE_NAME: &str = "GitGlance";
pub const SERVICE_DISPLAY_NAME: &str = "Git Glance Dashboard";
pub const SERVICE_DESCRIPTION: &str =
    "Local HTTP server exposing the Git Glance dashboard (auto-started in background)";

define_windows_service!(ffi_service_main, service_main);

fn service_main(_arguments: Vec<OsString>) {
    if let Err(e) = run_service() {
        log_event("error", &format!("service_main failed: {e}"));
    }
}

fn run_service() -> windows_service::Result<()> {
    let args = crate::parse_args();

    log_event(
        "info",
        &format!(
            "GitGlance service starting (host={}, port={}, static_dir={:?})",
            args.host, args.port, args.static_dir
        ),
    );

    let (shutdown_tx, shutdown_rx) = mpsc::channel();

    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    let server_handle = std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log_event("error", &format!("tokio build failed: {e}"));
                return;
            }
        };
        rt.block_on(async move {
            let port = args.port;
            if let Err(e) = crate::run_server(args).await {
                log_event("error", &crate::server_error_message(&e, port));
            }
        });
    });

    // Wait for shutdown signal from SCM
    let _ = shutdown_rx.recv();
    log_event("info", "shutdown signal received");

    // For a tokio server, the cleanest way to stop is to exit the process —
    // the SCM will restart us if configured to. For now we just notify and exit.
    let _ = status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    });

    drop(server_handle);
    Ok(())
}

pub fn install(args: &CliArgs) {
    let binary = resolve_binary_path();
    let static_dir =
        resolve_static_dir(&args.static_dir).unwrap_or_else(|| PathBuf::from("public"));

    println!("Installing Windows service...");
    println!("  binary:      {binary}");
    println!("  static dir:  {}", static_dir.display());
    println!("  port:        {}", args.port);
    println!("  host:        {}", args.host);

    // The service runs as LocalSystem. Tell git to allow that user to access
    // any repo so it doesn't error with "dubious ownership" on every scan.
    // Setting `safe.directory = *` at system scope is the standard fix.
    let _ = std::process::Command::new("git")
        .args(["config", "--system", "--add", "safe.directory", "*"])
        .status();

    let manager =
        match ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::ALL_ACCESS) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("cannot connect to Service Control Manager: {e}");
                eprintln!("(you may need to run this command as Administrator)");
                install_via_sc(&binary, args, &static_dir);
                return;
            }
        };

    let port_arg: String = args.port.to_string();
    let host_arg: String = args.host.to_string();

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: std::path::PathBuf::from(&binary),
        launch_arguments: vec![
            OsString::from("--host"),
            OsString::from(host_arg),
            OsString::from("--port"),
            OsString::from(port_arg),
            OsString::from("--static"),
            OsString::from(static_dir.as_os_str()),
            OsString::from("--windows-service"),
        ],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };

    let service_result = manager.create_service(&service_info, ServiceAccess::ALL_ACCESS);
    let service = match service_result {
        Ok(s) => {
            println!("Created service '{}'", SERVICE_NAME);
            s
        }
        Err(e) => {
            // Check for ERROR_SERVICE_EXISTS (1071) and reconfigure the existing one.
            let os_err = match &e {
                windows_service::Error::Winapi(io_err) => io_err.raw_os_error(),
                _ => None,
            };
            if os_err == Some(1071) || os_err == Some(0x80070431u32 as i32) {
                println!(
                    "Service '{}' already exists; reapplying configuration",
                    SERVICE_NAME
                );
                match manager.open_service(SERVICE_NAME, ServiceAccess::ALL_ACCESS) {
                    Ok(s) => match s.change_config(&service_info) {
                        Ok(()) => s,
                        Err(e2) => {
                            eprintln!("cannot update existing service: {e2}");
                            install_via_sc(&binary, args, &static_dir);
                            return;
                        }
                    },
                    Err(e2) => {
                        eprintln!("service exists but cannot be opened: {e2}");
                        install_via_sc(&binary, args, &static_dir);
                        return;
                    }
                }
            } else {
                eprintln!("create_service failed: {e}");
                install_via_sc(&binary, args, &static_dir);
                return;
            }
        }
    };

    if let Err(e) = service.set_description(SERVICE_DESCRIPTION) {
        eprintln!("warning: could not set service description: {e}");
    }

    match service.start::<&str>(&[]) {
        Ok(_) => println!("Started service '{}'", SERVICE_NAME),
        Err(e) => eprintln!("warning: could not start service automatically: {e}"),
    }

    println!();
    println!("Git Glance is now installed as a Windows service.");
    println!("It will auto-start at boot. Manage with:");
    println!("  sc query {}", SERVICE_NAME);
    println!("  sc stop {}", SERVICE_NAME);
    println!("  sc start {}", SERVICE_NAME);
    println!("  services.msc   (GUI)");
}

fn install_via_sc(binary: &str, args: &CliArgs, static_dir: &PathBuf) {
    let bin_path = format!(
        "\"{}\" --host {} --port {} --static \"{}\" --windows-service",
        binary,
        args.host,
        args.port,
        static_dir.display()
    );

    let bin_arg = format!("binPath= {}", bin_path);
    let display_arg = format!("DisplayName= {}", SERVICE_DISPLAY_NAME);

    let status = std::process::Command::new("sc")
        .args([
            "create",
            SERVICE_NAME,
            &bin_arg,
            "start= auto",
            &display_arg,
        ])
        .status()
        .expect("failed to invoke sc.exe");
    if !status.success() {
        panic!("sc create failed");
    }

    let _ = std::process::Command::new("sc")
        .args(["description", SERVICE_NAME, SERVICE_DESCRIPTION])
        .status();

    let status = std::process::Command::new("sc")
        .args(["start", SERVICE_NAME])
        .status()
        .expect("failed to invoke sc.exe start");
    if !status.success() {
        eprintln!("sc start returned non-zero (service may already be running)");
    }
}

pub fn uninstall() {
    println!("Uninstalling Windows service '{}'...", SERVICE_NAME);

    let manager =
        match ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::ALL_ACCESS) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("cannot connect to SCM ({e}); falling back to sc.exe");
                let _ = std::process::Command::new("sc")
                    .args(["stop", SERVICE_NAME])
                    .status();
                let _ = std::process::Command::new("sc")
                    .args(["delete", SERVICE_NAME])
                    .status();
                return;
            }
        };

    if let Ok(service) = manager.open_service(SERVICE_NAME, ServiceAccess::ALL_ACCESS) {
        let _ = service.stop();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        match service.delete() {
            Ok(()) => println!("Deleted service '{}'", SERVICE_NAME),
            Err(e) => eprintln!("cannot delete service: {e}"),
        }
    } else {
        let _ = std::process::Command::new("sc")
            .args(["stop", SERVICE_NAME])
            .status();
        let status = std::process::Command::new("sc")
            .args(["delete", SERVICE_NAME])
            .status()
            .expect("failed to invoke sc.exe");
        if status.success() {
            println!("Deleted service '{}'", SERVICE_NAME);
        } else {
            eprintln!(
                "Service '{}' not found (or could not be deleted)",
                SERVICE_NAME
            );
        }
    }
}

fn resolve_binary_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "git-glance-serve.exe".to_string())
}

fn resolve_static_dir(cli_static: &Option<String>) -> Option<PathBuf> {
    if let Some(d) = cli_static {
        let path = PathBuf::from(d);
        if path.join("index.html").exists() {
            return Some(path);
        }
        return std::fs::canonicalize(d).ok().or(Some(path));
    }

    // Strategy: walk up the tree from both cwd and the binary's directory,
    // checking well-known relative locations at every level until we find
    // a directory containing index.html. This is robust regardless of
    // where the binary was invoked from (e.g. SCM starts it in System32).
    let target_name = std::path::Path::new("index.html");

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(bin) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
    {
        let mut dir = bin;
        loop {
            roots.push(dir.clone());
            if !dir.pop() {
                break;
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd;
        loop {
            if !roots.contains(&dir) {
                roots.push(dir.clone());
            }
            if !dir.pop() {
                break;
            }
        }
    }

    for root in &roots {
        for rel in &[
            "renderer-dist",
            "packages/desktop/renderer-dist",
            "../desktop/renderer-dist",
            "../../desktop/renderer-dist",
            "public",
        ] {
            let candidate = root.join(rel);
            if candidate.is_file() {
                continue;
            }
            if candidate.join(target_name).is_file() {
                return Some(candidate);
            }
        }
    }

    None
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

fn log_event(level: &str, msg: &str) {
    eprintln!("[git-glance/{}] {}", level, msg);
}

pub fn run_service_dispatcher() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}
