use serde::{de::DeserializeOwned, Deserialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::{fs::MetadataExt, fs::OpenOptionsExt},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{webview::Cookie, Url};

#[derive(Deserialize)]
pub struct Session {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub status: String,
    pub message: String,
    pub url: Option<String>,
    pub password: Option<String>,
    pub folder: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    #[serde(default)]
    pub step: u8,
}

fn read_private<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    for candidate in [path.parent().ok_or("Missing session directory")?, path] {
        let metadata =
            fs::symlink_metadata(candidate).map_err(|_| "Cannot read startup session")?;
        if metadata.file_type().is_symlink()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("Startup session must be private and owned by the current user".into());
        }
    }
    let metadata = fs::metadata(path).map_err(|_| "Cannot inspect startup session")?;
    if !metadata.is_file() || metadata.len() > 16_384 {
        return Err("Invalid startup session file".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read session")?)
        .map_err(|_| "Invalid startup session format".into())
}

pub fn read_session(path: &Path) -> Result<Session, String> {
    let session: Session = read_private(path)?;
    if session.version != 1
        || session.id.len() != 20
        || !session.id.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err("Unsupported startup session".into());
    }
    Ok(session)
}

pub fn validate_folder(value: &str) -> Result<&str, String> {
    let path = Path::new(value);
    if !path.starts_with("/workspace")
        || !path.is_absolute()
        || value.contains('\0')
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("The editor folder must stay inside the mounted repository".into());
    }
    Ok(value)
}

#[derive(Deserialize)]
pub struct FocusRequest {
    pub id: String,
    pub action: String,
}

pub fn read_focus_request(path: &Path) -> Result<Option<FocusRequest>, String> {
    let request_path = path.with_file_name("request.json");
    if !request_path
        .try_exists()
        .map_err(|_| "Cannot inspect window request")?
    {
        return Ok(None);
    }
    let request: FocusRequest = read_private(&request_path)?;
    if !matches!(request.action.as_str(), "focus" | "close")
        || request.id.len() != 24
        || !request.id.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err("Unsupported window request".into());
    }
    Ok(Some(request))
}

pub fn respond_focus(path: &Path, id: &str) -> Result<(), String> {
    write_status(
        path.with_file_name("response.json"),
        serde_json::json!({"id": id}),
    )
}

pub fn validate_origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid editor URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Editor must use a credential-free literal loopback origin".into());
    }
    Ok(url)
}

pub fn authenticate(origin: &Url, password: &str) -> Result<Cookie<'static>, String> {
    if password.len() != 64 || !password.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Invalid runtime credentials".into());
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize authentication")?;
    let response = client
        .post(origin.join("/login").map_err(|_| "Invalid login URL")?)
        .form(&[("password", password)])
        .send()
        .map_err(|_| "Cannot contact editor for authentication")?;
    if response.status() != reqwest::StatusCode::FOUND {
        return Err("Editor authentication failed".into());
    }
    let header = response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .ok_or("Editor did not return a session cookie")?;
    let mut cookie = Cookie::parse(header.to_owned())
        .map_err(|_| "Invalid editor cookie")?
        .into_owned();
    cookie.set_domain("127.0.0.1");
    cookie.set_path("/");
    cookie.set_http_only(true);
    Ok(cookie)
}

pub fn matches_session_cookie(cookie: &Cookie<'_>, name: &str, value: &str) -> bool {
    cookie.domain() == Some("127.0.0.1") && cookie.name() == name && cookie.value() == value
}

pub fn acknowledge(path: &Path, stage: &str, message: &str) -> Result<(), String> {
    write_status(
        path.with_file_name("ack.json"),
        serde_json::json!({"stage": stage, "message": message}),
    )
}

fn write_status(destination: PathBuf, value: serde_json::Value) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temporary = destination.with_extension(format!(
        "{}.{}.pending",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "Cannot acknowledge startup")?;
    file.write_all(value.to_string().as_bytes())
        .map_err(|_| "Cannot write startup status")?;
    fs::rename(temporary, destination).map_err(|_| "Cannot publish startup status".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_editor_folders_to_repository() {
        assert!(validate_folder("/workspace").is_ok());
        assert!(validate_folder("/workspace/my project/api").is_ok());
        for folder in ["/workspace-other", "/workspace/../etc", "/etc", "relative"] {
            assert!(validate_folder(folder).is_err());
        }
    }

    #[test]
    fn matches_ip_literal_session_without_url_domain_filtering() {
        let origin = validate_origin("http://127.0.0.1:49152").unwrap();
        assert_eq!(origin.domain(), None);
        let mut cookie = Cookie::new("session", "opaque");
        cookie.set_domain("127.0.0.1");
        assert!(matches_session_cookie(&cookie, "session", "opaque"));
        assert!(!matches_session_cookie(&cookie, "session", "wrong"));
        cookie.set_domain("example.com");
        assert!(!matches_session_cookie(&cookie, "session", "opaque"));
    }

    #[test]
    fn restricts_editor_origins() {
        assert!(validate_origin("http://127.0.0.1:49152").is_ok());
        for value in [
            "http://localhost:8080",
            "http://127.0.0.1:8080?password=secret",
            "http://user:secret@127.0.0.1:8080",
            "https://example.com",
            "file:///etc/passwd",
        ] {
            assert!(validate_origin(value).is_err());
        }
    }
}
