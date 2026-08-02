use std::path::PathBuf;

use crate::CliArgs;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE_NAME: &str = "GitGlance";
const INSTALL_DIR: &str = r"git-glance";

fn install_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join("AppData").join("Local"))
        .join(INSTALL_DIR)
}

fn source_binary() -> PathBuf {
    std::env::current_exe().expect("cannot determine current exe path")
}

fn copy_to_install_dir(source: &PathBuf) -> std::io::Result<PathBuf> {
    let target_dir = install_dir();
    std::fs::create_dir_all(&target_dir)?;
    let target = target_dir.join("git-glance-serve.exe");
    std::fs::copy(source, &target)?;
    Ok(target)
}

pub fn install(args: &CliArgs) {
    let source = source_binary();
    println!("Installing git-glance as a user startup app...");

    let binary = match copy_to_install_dir(&source) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("warning: could not copy binary to install dir ({e}); using source path");
            source.clone()
        }
    };
    println!("  binary:     {}", binary.display());

    // Pick the static dir the same way the install path does.
    let static_dir = resolve_static_dir_for_install(&args.static_dir);
    println!("  static dir: {}", static_dir.display());

    let static_dir_arg = format!("\"{}\"", static_dir.display());

    let command = format!(
        "\"{}\" --host {} --port {} --static {}",
        binary.display(),
        args.host,
        args.port,
        static_dir_arg
    );
    println!("  command:    {command}");

    // Write to HKCU\Software\Microsoft\Windows\CurrentVersion\Run
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (run_key, _) = match hkcu.create_subkey(RUN_KEY) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("cannot open Run key: {e}");
            return;
        }
    };

    match run_key.set_value(RUN_VALUE_NAME, &command) {
        Ok(()) => println!("Registered '{}' in HKCU\\...\\Run", RUN_VALUE_NAME),
        Err(e) => {
            eprintln!("cannot write Run value: {e}");
            return;
        }
    }

    println!("\ngit-glance is now installed as a startup app.");
    println!("It will auto-start when you log in, in the background.");
    println!("Manage with:");
    println!("  --uninstall-startup        Remove the auto-start entry");
    println!("  Task Manager -> Startup    (GUI)");
    println!("  regedit -> {} ", RUN_KEY);
}

pub fn uninstall() {
    println!("Removing git-glance from startup...");

    let hkcu = match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey(RUN_KEY) {
        Ok(k) => k,
        Err(_) => {
            println!("No startup entry found.");
            return;
        }
    };

    match hkcu.delete_value(RUN_VALUE_NAME) {
        Ok(()) => println!("Removed HKCU\\...\\Run\\{}", RUN_VALUE_NAME),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            println!("No startup entry to remove.");
        }
        Err(e) => eprintln!("cannot delete Run value: {e}"),
    }
}

fn resolve_static_dir_for_install(cli_static: &Option<String>) -> PathBuf {
    if let Some(d) = cli_static {
        let p = PathBuf::from(d);
        if p.join("index.html").exists() {
            return std::fs::canonicalize(&p).unwrap_or(p);
        }
        return p;
    }

    // Walk up from the binary looking for renderer-dist/index.html
    let target = std::path::Path::new("index.html");
    let mut dir = source_binary();
    if let Some(parent) = dir.parent() {
        dir = parent.to_path_buf();
    }
    loop {
        for rel in &[
            "renderer-dist",
            "packages/desktop/renderer-dist",
            "../desktop/renderer-dist",
            "../../desktop/renderer-dist",
        ] {
            let candidate = dir.join(rel);
            if candidate.join(target).is_file() {
                return std::fs::canonicalize(&candidate).unwrap_or(candidate);
            }
        }
        if !dir.pop() {
            break;
        }
    }

    // Fallback to the source-relative path so the user can fix it manually
    if let Some(parent) = source_binary().parent() {
        return parent
            .join("../../desktop/renderer-dist")
            .canonicalize()
            .unwrap_or_else(|_| parent.join("../../desktop/renderer-dist"));
    }
    PathBuf::from("public")
}
