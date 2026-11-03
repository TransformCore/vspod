mod session;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{webview::NewWindowResponse, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

fn show_status(window: &WebviewWindow, message: &str, detail: &str, step: u8, failed: bool) {
    let status = serde_json::json!({"title": message, "detail": detail, "step": step.min(5), "failed": failed});
    let _ = window.eval(format!(
        "if(location.protocol==='tauri:' && document.getElementById('status')) {{const s={status}; document.getElementById('status').textContent=s.title; document.getElementById('detail').textContent=s.detail; document.getElementById('progress').value=s.step; document.body.dataset.state=s.failed?'error':'loading'; document.querySelectorAll('[data-step]').forEach((el,i)=>{{el.dataset.state=i<s.step?'done':i===s.step?'active':'pending';}});}}"
    ));
}

fn connect(
    window: &WebviewWindow,
    path: &std::path::Path,
    allowed: Arc<Mutex<Option<Url>>>,
    closed: &AtomicBool,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(900);
    let session = loop {
        if closed.load(Ordering::Relaxed) {
            return Err("Workspace window closed".into());
        }
        if Instant::now() >= deadline {
            return Err("Workspace startup timed out".into());
        }
        let session = session::read_session(path)?;
        show_status(
            window,
            &session.message,
            session.detail.as_deref().unwrap_or(""),
            session.step,
            session.status == "error",
        );
        match session.status.as_str() {
            "ready" => break session,
            "error" => {
                return Err(format!(
                    "{}\n{}",
                    session.message,
                    session.hint.unwrap_or_default()
                ))
            }
            _ => thread::sleep(Duration::from_millis(200)),
        }
    };
    let origin = session::validate_origin(session.url.as_deref().ok_or("Missing editor URL")?)?;
    let password = session.password.ok_or("Missing runtime credential")?;
    show_status(
        window,
        "Connecting securely",
        "Establishing your private editor session",
        3,
        false,
    );
    let cookie = session::authenticate(&origin, &password)?;
    drop(password);
    let expected_name = cookie.name().to_owned();
    let expected_value = cookie.value().to_owned();
    window
        .set_cookie(cookie)
        .map_err(|_| "Cannot initialize native editor session")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let installed = window
            .cookies()
            .map_err(|_| "Cannot verify native session cookie")?
            .iter()
            .any(|cookie| session::matches_session_cookie(cookie, &expected_name, &expected_value));
        if installed {
            break;
        }
        if Instant::now() >= deadline {
            return Err("Native session cookie installation timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
    let mut editor = origin.clone();
    editor.query_pairs_mut().append_pair(
        "folder",
        session::validate_folder(session.folder.as_deref().unwrap_or("/workspace"))?,
    );
    *allowed.lock().map_err(|_| "Cannot set editor origin")? = Some(origin);
    session::acknowledge(path, "authenticated", "Native authentication complete")?;
    window
        .navigate(editor)
        .map_err(|_| "Cannot navigate to editor")?;
    Ok(())
}

fn watch_window(
    window: WebviewWindow,
    path: PathBuf,
    ready: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
) {
    let mut last_request = String::new();
    while !closed.load(Ordering::Relaxed) {
        if let Ok(Some(request)) = session::read_focus_request(&path) {
            if request.id != last_request {
                if request.action == "close" {
                    let _ = session::respond_focus(&path, &request.id);
                    let _ = window.close();
                    break;
                }
                if ready.load(Ordering::Relaxed) {
                    let focused = window
                        .unminimize()
                        .and_then(|_| window.show())
                        .and_then(|_| window.set_focus());
                    if focused.is_ok() {
                        let _ = session::respond_focus(&path, &request.id);
                        last_request = request.id;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--session")) {
        eprintln!("Launch VSPod with vspod open.");
        std::process::exit(2);
    }
    let path = PathBuf::from(args.next().unwrap_or_default());
    if !path.is_absolute() || args.next().is_some() {
        eprintln!("Expected an absolute private startup session path.");
        std::process::exit(2);
    }
    let initial = match session::read_session(&path) {
        Ok(session) => session,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let allowed: Arc<Mutex<Option<Url>>> = Arc::new(Mutex::new(None));
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(move |app| {
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            let navigation_origin = allowed.clone();
            let load_origin = allowed.clone();
            let closed = Arc::new(AtomicBool::new(false));
            let title = format!("{} - VSPod", initial.name);
            let load_title = title.clone();
            let window = WebviewWindowBuilder::new(
                app,
                format!("project-{}", initial.id),
                WebviewUrl::App("index.html".into()),
            )
            .title(title)
            .inner_size(1200.0, 800.0)
            .min_inner_size(640.0, 480.0)
            .incognito(true)
            .on_navigation(move |url| {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || navigation_origin
                        .lock()
                        .ok()
                        .and_then(|origin| origin.clone())
                        .is_some_and(|origin| url.origin() == origin.origin())
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(move |window, payload| {
                let is_editor = load_origin
                    .lock()
                    .ok()
                    .and_then(|origin| origin.clone())
                    .is_some_and(|origin| payload.url().origin() == origin.origin());
                if is_editor {
                    let _ = window.set_title(&load_title);
                }
            })
            .build()?;
            let close_path = path.clone();
            let closed_event = closed.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    closed_event.store(true, Ordering::Relaxed);
                    let _ = session::acknowledge(&close_path, "closed", "Window closed");
                }
            });
            session::acknowledge(&path, "loading", "Native window opened")?;
            let ready = Arc::new(AtomicBool::new(false));
            let control_window = window.clone();
            let control_path = path.clone();
            let control_ready = ready.clone();
            let control_closed = closed.clone();
            thread::spawn(move || {
                watch_window(control_window, control_path, control_ready, control_closed)
            });
            let worker_window = window.clone();
            thread::spawn(move || {
                if let Err(message) = connect(&worker_window, &path, allowed, &closed) {
                    if closed.load(Ordering::Relaxed) {
                        return;
                    }
                    let (title, hint) = message.split_once('\n').unwrap_or((
                        &message,
                        "Run vspod doctor, then try opening the folder again.",
                    ));
                    show_status(&worker_window, title, hint, 0, true);
                    let _ = session::acknowledge(&path, "error", &message);
                    return;
                }
                while !closed.load(Ordering::Relaxed) && !ready.load(Ordering::Relaxed) {
                    if !ready.load(Ordering::Relaxed) {
                        let ack_path = path.clone();
                        let callback_ready = ready.clone();
                        let callback_closed = closed.clone();
                        let _ = worker_window.eval_with_callback(
                            "Boolean(document.querySelector('.monaco-workbench .part.editor'))",
                            move |result| {
                                if result == "true"
                                    && !callback_closed.load(Ordering::Relaxed)
                                    && !callback_ready.swap(true, Ordering::Relaxed)
                                {
                                    let _ = session::acknowledge(
                                        &ack_path,
                                        "editor-ready",
                                        "Editor workbench rendered",
                                    );
                                }
                            },
                        );
                    }
                    thread::sleep(Duration::from_millis(250));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("VSPod desktop failed");
}
