use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;

const BACKEND_PORT: u16 = 8787;
/// A child that survives this long is considered healthy; the restart
/// backoff resets so a later crash restarts quickly again.
const STABLE_AFTER: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct BackendSupervisor {
    child: Arc<Mutex<Option<Child>>>,
    shutting_down: Arc<AtomicBool>,
}

fn backend_port_open() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], BACKEND_PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Resolve the bundled backend executable next to the app binary.
///
/// Deliberately NOT canonicalized: Windows canonicalization produces
/// `\\?\`-prefixed extended-length paths, and Dart AOT executables fail
/// to launch through them ("\\?\ prefix is not supported",
/// dart-lang/sdk#42971) — which is exactly why this spawns via
/// std::process instead of the shell plugin's sidecar API.
fn backend_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "backend-cache.exe"
    } else {
        "backend-cache"
    };
    let path = dir.join(name);
    path.exists().then_some(path)
}

fn spawn_backend(executable: &PathBuf, cache_dir: &str) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(["--port", &BACKEND_PORT.to_string(), "--cache-dir", cache_dir])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Without this, every spawn pops a console window over the app.
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// Pipe a child stream into the app log, line by line, on its own thread.
fn forward_output<R: std::io::Read + Send + 'static>(stream: R, is_stderr: bool) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if is_stderr {
                log::warn!("[backend] {line}");
            } else {
                log::info!("[backend] {line}");
            }
        }
    });
}

/// Spawns and supervises the backend cache process for the lifetime of
/// the app:
///   - If something is already serving on the port (a dev server or an
///     orphan from a previous run), it is reused instead of spawning a
///     duplicate — the supervisor just keeps watching.
///   - On crash/exit, the backend is restarted with exponential backoff
///     (1s → 2s → … → 30s), resetting after a stable run.
///   - On app exit, the child is killed.
fn start_backend_supervisor(app: &tauri::AppHandle, supervisor: &BackendSupervisor) {
    let child_slot = Arc::clone(&supervisor.child);
    let shutting_down = Arc::clone(&supervisor.shutting_down);

    // Cache directory inside the per-user app-data folder so the packaged
    // app never depends on its install directory being writable.
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .map(|dir| dir.join("market_data_cache"))
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_else(|_| "market_data_cache".to_string());

    std::thread::spawn(move || {
        let mut backoff = Duration::from_secs(1);
        loop {
            if shutting_down.load(Ordering::SeqCst) {
                return;
            }

            // Reuse any healthy server already on the port (dev backend or
            // orphan). Poll until it disappears, then take over.
            if backend_port_open() {
                log::info!(
                    "backend already serving on {BACKEND_PORT}; supervising without spawning"
                );
                while backend_port_open() && !shutting_down.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_secs(15));
                }
                continue;
            }

            let Some(executable) = backend_executable() else {
                log::error!("backend-cache executable not found next to the app binary");
                std::thread::sleep(MAX_BACKOFF);
                continue;
            };

            log::info!(
                "starting backend ({}; cache dir: {cache_dir})",
                executable.display()
            );
            let mut child = match spawn_backend(&executable, &cache_dir) {
                Ok(child) => child,
                Err(error) => {
                    log::error!("failed to spawn backend: {error}");
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            };

            if let Some(stdout) = child.stdout.take() {
                forward_output(stdout, false);
            }
            if let Some(stderr) = child.stderr.take() {
                forward_output(stderr, true);
            }

            let started = Instant::now();
            let pid = child.id();
            *child_slot.lock().expect("backend child lock") = Some(child);

            // Block this supervisor thread until the child terminates. The
            // child handle stays in the slot so the exit handler can kill it;
            // poll try_wait through the slot instead of moving it out.
            let status = loop {
                let mut slot = child_slot.lock().expect("backend child lock");
                match slot.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => {}
                        Err(error) => {
                            log::error!("backend wait failed: {error}");
                            break None;
                        }
                    },
                    // Exit handler took and killed the child.
                    None => break None,
                }
                drop(slot);
                std::thread::sleep(Duration::from_millis(500));
            };

            child_slot.lock().expect("backend child lock").take();

            if shutting_down.load(Ordering::SeqCst) {
                return;
            }

            log::warn!("backend (pid {pid}) exited: {status:?}");
            if started.elapsed() > STABLE_AFTER {
                backoff = Duration::from_secs(1);
            }
            log::info!("restarting backend in {backoff:?}");
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let supervisor = BackendSupervisor {
        child: Arc::new(Mutex::new(None)),
        shutting_down: Arc::new(AtomicBool::new(false)),
    };
    let exit_child = Arc::clone(&supervisor.child);
    let exit_flag = Arc::clone(&supervisor.shutting_down);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(move |app| {
            start_backend_supervisor(app.handle(), &supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Finance Oracle Workstation")
        .run(move |_app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                exit_flag.store(true, Ordering::SeqCst);
                if let Some(mut child) = exit_child.lock().expect("backend child lock").take() {
                    let _ = child.kill();
                }
            }
        });
}
