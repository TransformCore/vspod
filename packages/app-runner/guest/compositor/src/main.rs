//! Headless Wayland compositor for the isolated application runner.
//!
//! Every mapped xdg toplevel and xdg popup becomes one native host window. Pixels come straight from the
//! client's wl_shm buffers, retaining popup shadow margins outside xdg window geometry, and streamed with the same
//! length-prefixed JSON protocol as the X11 agent (plus a `scale` field). The host attaches through
//! `vspod-compositor --bridge`, so it can disconnect and reattach while the editor keeps running.

use std::{
    collections::{HashMap, HashSet},
    env,
    error::Error,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::{
            fs::{DirBuilderExt, OpenOptionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Component, Path, PathBuf},
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use flate2::{write::DeflateEncoder, Compression};
use serde_json::{json, Value};
use smithay::{
    backend::input::{Axis, AxisSource, ButtonState, KeyState},
    delegate_compositor, delegate_cursor_shape, delegate_data_device, delegate_output, delegate_seat,
    delegate_kde_decoration, delegate_shm, delegate_xdg_decoration, delegate_xdg_foreign, delegate_xdg_shell,
    input::{
        keyboard::{FilterResult, XkbConfig},
        pointer::{AxisFrame, ButtonEvent, CursorImageStatus, GrabStartData as PointerGrabStartData, MotionEvent},
        Seat, SeatHandler, SeatState,
    },
    output::{Mode as OutputMode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::{
        calloop::{
            channel,
            generic::Generic,
            timer::{TimeoutAction, Timer},
            EventLoop, Interest, LoopHandle, Mode, PostAction,
        },
        wayland_protocols::xdg::{
            decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as DecorationMode,
            shell::server::xdg_toplevel,
        },
        wayland_protocols_misc::server_decoration::server::{
            org_kde_kwin_server_decoration::{Mode as KdeMode, OrgKdeKwinServerDecoration},
            org_kde_kwin_server_decoration_manager::Mode as KdeDefaultMode,
        },
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason, ObjectId},
            protocol::{wl_buffer, wl_data_device_manager::DndAction, wl_seat, wl_shm, wl_surface::WlSurface},
            Client, Display, DisplayHandle, Resource, WEnum,
        },
    },
    utils::{Logical, Point, Rectangle, Serial, Transform, SERIAL_COUNTER},
    wayland::{
        buffer::BufferHandler,
        compositor::{
            with_states, BufferAssignment, CompositorClientState, CompositorHandler, CompositorState, Damage,
            SurfaceAttributes,
        },
        cursor_shape::CursorShapeManagerState,
        xdg_foreign::{XdgForeignHandler, XdgForeignState},
        output::{OutputHandler, OutputManagerState},
        selection::{
            data_device::{
                request_data_device_client_selection, set_data_device_focus, set_data_device_selection, start_dnd,
                ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler, SourceMetadata,
            },
            SelectionHandler, SelectionSource, SelectionTarget,
        },
        shell::kde::decoration::{KdeDecorationHandler, KdeDecorationState},
        shell::xdg::{
            decoration::{XdgDecorationHandler, XdgDecorationState},
            PopupSurface, PositionerState, SurfaceCachedState, ToplevelSurface, XdgPopupSurfaceData,
            XdgShellHandler, XdgShellState, XdgToplevelSurfaceData,
        },
        shm::{with_buffer_contents, ShmHandler, ShmState},
        socket::ListeningSocketSource,
        tablet_manager::TabletSeatHandler,
    },
};

const HOST_SOCKET: &str = "/tmp/runtime/vspod-host.sock";
/// `xdg-open` in the image is a shim that hands URLs to this socket (`vspod-compositor --open URL`).
const OPEN_SOCKET: &str = "/tmp/runtime/vspod-open.sock";
/// Host files (paste and drop) are staged here; guest file copies may only export from here or the workspace.
const STAGING: &str = "/tmp/vspod-transfer";
const TRANSFER_LIMIT: usize = 8 << 20;
const MAX_ENTRIES: usize = 100;
/// Guest clipboard changes reach the host only shortly after a host key or button press (user activation),
/// so a background process in the container cannot silently overwrite the macOS clipboard.
const COPY_GATE: Duration = Duration::from_secs(1);
/// URL opens need a recent host gesture, and each gesture allows at most one open.
const OPEN_GATE: Duration = Duration::from_secs(10);
const TEXT_MIMES: [&str; 5] = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"];
const FILE_MIMES: [&str; 2] = ["code/file-list", "text/uri-list"];
const MAX_RECTS: usize = 24;
const MAX_POINTER: i64 = 16384;
const MAX_LOGICAL: (i32, i32) = (4096, 2160);
const COMPRESS_MIN_BYTES: usize = 4096;
const FULL_CAPTURE_SHARE: usize = 60;
const MAIN_SIZE: (i32, i32) = (900, 650);
const OUTPUT_SIZE: (i32, i32) = (1800, 1300);
// Host buttons 1/2/3 (left/middle/right) to linux/input-event-codes.h.
const BUTTONS: [u32; 3] = [0x110, 0x112, 0x111];

enum Role {
    Toplevel(ToplevelSurface),
    Popup(PopupSurface),
}

struct Win {
    role: Role,
    mapped: bool,
    /// Window-geometry origin in the shared logical layout (toplevels at 0,0; popups relative to parents).
    pos: (i32, i32),
    /// xdg window geometry within the surface, in logical coordinates.
    geo: Rectangle<i32, Logical>,
    /// Captured surface bounds; popups retain the pixels outside window geometry for client shadows.
    capture: Rectangle<i32, Logical>,
    scale: i32,
    width: usize,
    height: usize,
    /// CPU copy of the captured pixels; serves snapshots, probes and host reattachment.
    pixels: Vec<u8>,
    /// Popup buffer carries premultiplied alpha (ARGB8888), e.g. Chromium's rounded menu corners.
    alpha: bool,
    meta: Option<Value>,
    sequence: u64,
}

impl Win {
    fn capture_origin(&self) -> (i32, i32) {
        (self.pos.0 + self.capture.loc.x - self.geo.loc.x,
         self.pos.1 + self.capture.loc.y - self.geo.loc.y)
    }

    fn surface(&self) -> &WlSurface {
        match &self.role {
            Role::Toplevel(toplevel) => toplevel.wl_surface(),
            Role::Popup(popup) => popup.wl_surface(),
        }
    }
}

enum HostEvent {
    Command(u64, Value),
    Closed(u64),
    /// A guest clipboard read finished on a worker thread: (serial, header, payload).
    GuestClipboard(u64, Value, Vec<u8>),
    Open(String),
}

/// Host files dropped onto a guest window: an in-progress server-side drag.
struct HostDrop {
    id: u64,
    x: i64,
    y: i64,
    uris: Arc<Vec<u8>>,
}

struct State {
    dh: DisplayHandle,
    compositor: CompositorState,
    xdg: XdgShellState,
    shm: ShmState,
    seat_state: SeatState<State>,
    data_device: DataDeviceState,
    // GTK dialogs use a separate Wayland connection and link to Chromium's window via an exported handle.
    xdg_foreign: XdgForeignState,
    // GTK 3 ignores xdg-decoration and only drops its client-side title bar for KDE server decoration.
    kde_decoration: KdeDecorationState,
    output: Output,
    seat: Seat<State>,
    start: Instant,
    next_id: u64,
    windows: HashMap<u64, Win>,
    surfaces: HashMap<ObjectId, u64>,
    stacking: Vec<u64>,
    grabs: Vec<u64>,
    active: Option<u64>,
    host: Option<UnixStream>,
    host_generation: u64,
    host_events: channel::Sender<HostEvent>,
    cursor: Value,
    cursor_serial: u64,
    pressed_keys: HashSet<u32>,
    pressed_buttons: HashSet<u32>,
    last_input: Option<Instant>,
    pointer_trace: bool,
    handle: LoopHandle<'static, State>,
    /// Visible host screen area per toplevel, relative to its window-geometry origin (logical points).
    bounds: HashMap<u64, Rectangle<i32, Logical>>,
    clipboard_serial: u64,
    transfer_serial: u64,
    drop: Option<HostDrop>,
    last_open: Option<Instant>,
    /// Last host pointer move (host window, window-relative point, when), for the menu-switch nudge.
    last_pointer: Option<(u64, i64, i64, Instant)>,
    electron_menu_nudge: bool,
    export_roots: Vec<PathBuf>,
}

impl State {
    fn now(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }

    fn send(&mut self, mut header: Value, payload: &[u8]) {
        let Some(host) = self.host.as_mut() else { return };
        header["bytes"] = json!(payload.len());
        let encoded = serde_json::to_vec(&header).expect("serialisable header");
        let started = Instant::now();
        let result = host
            .write_all(&(encoded.len() as u32).to_be_bytes())
            .and_then(|_| host.write_all(&encoded))
            .and_then(|_| host.write_all(payload));
        if self.pointer_trace && started.elapsed() > Duration::from_millis(5) {
            eprintln!("POINTER t={} host_write_blocked_ms={} bytes={}", self.now(), started.elapsed().as_millis(), payload.len());
        }
        if let Err(error) = result {
            eprintln!("Host stream failed: {error}");
            self.drop_host();
        }
    }

    fn drop_host(&mut self) {
        if let Some(host) = self.host.take() {
            let _ = host.shutdown(std::net::Shutdown::Both);
            eprintln!("VSPOD_HOST_DETACHED");
        }
        self.release();
    }

    fn attach(&mut self, stream: UnixStream) -> io::Result<()> {
        self.drop_host();
        stream.set_nonblocking(false)?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        let reader = stream.try_clone()?;
        self.host_generation += 1;
        let generation = self.host_generation;
        let events = self.host_events.clone();
        thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                match serde_json::from_str(&line) {
                    Ok(request) => {
                        if events.send(HostEvent::Command(generation, request)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        eprintln!("Invalid host command: {error}");
                        break;
                    }
                }
            }
            let _ = events.send(HostEvent::Closed(generation));
        });
        self.host = Some(stream);
        eprintln!("VSPOD_HOST_ATTACHED generation={generation}");
        self.send(json!({"type": "ready", "version": 1, "wayland": true}), &[]);
        // Replay in mapping order so parents exist before their popups.
        for id in self.stacking.clone() {
            if let Some(meta) = self.metadata(id) {
                self.windows.get_mut(&id).unwrap().meta = Some(meta.clone());
                self.send(meta, &[]);
                self.send_full(id, "", Instant::now());
            }
        }
        let cursor = self.cursor.clone();
        if !cursor.is_null() {
            self.send(cursor, &[0; 4]);
        }
        Ok(())
    }

    fn host_event(&mut self, event: HostEvent) {
        match event {
            HostEvent::Command(generation, request) if generation == self.host_generation => {
                if let Err(error) = self.command(&request) {
                    eprintln!("Rejected host command {request}: {error}");
                }
            }
            HostEvent::Closed(generation) if generation == self.host_generation => self.drop_host(),
            // A newer host paste or guest copy supersedes a slow read.
            HostEvent::GuestClipboard(serial, header, payload) if serial == self.clipboard_serial => {
                self.send(header, &payload)
            }
            HostEvent::Open(url) => self.open(url),
            _ => {}
        }
    }

    fn register(&mut self, role: Role) {
        self.next_id += 1;
        let id = self.next_id;
        let surface = match &role {
            Role::Toplevel(toplevel) => toplevel.wl_surface().id(),
            Role::Popup(popup) => popup.wl_surface().id(),
        };
        self.surfaces.insert(surface, id);
        self.windows.insert(id, Win {
            role,
            mapped: false,
            pos: (0, 0),
            geo: Rectangle::default(),
            capture: Rectangle::default(),
            scale: 1,
            width: 0,
            height: 0,
            pixels: Vec::new(),
            alpha: false,
            meta: None,
            sequence: 0,
        });
    }

    fn id_of(&self, surface: &WlSurface) -> Option<u64> {
        self.surfaces.get(&surface.id()).copied()
    }

    fn parent(&self, id: u64) -> Option<u64> {
        match &self.windows.get(&id)?.role {
            Role::Popup(popup) => popup.get_parent_surface().and_then(|parent| self.id_of(&parent)),
            Role::Toplevel(_) => None,
        }
    }

    /// The toplevel (main window or dialog) that owns a popup chain.
    fn root(&self, mut id: u64) -> u64 {
        while let Some(parent) = self.parent(id) {
            id = parent;
        }
        id
    }

    fn place(&mut self, id: u64) {
        let Some(win) = self.windows.get(&id) else { return };
        let pos = match &win.role {
            Role::Toplevel(toplevel) => {
                match toplevel.parent().and_then(|parent| self.id_of(&parent)).and_then(|parent| self.windows.get(&parent)) {
                    // Dialogs are centred over their parent, as a macOS sheet-like child window.
                    Some(parent) => (
                        parent.pos.0 + (parent.geo.size.w - win.geo.size.w) / 2,
                        parent.pos.1 + (parent.geo.size.h - win.geo.size.h) / 2,
                    ),
                    None => (0, 0),
                }
            }
            Role::Popup(popup) => {
                // xdg_popup geometry is relative to the parent's window geometry.
                let geometry = with_states(popup.wl_surface(), |states| {
                    states.data_map.get::<XdgPopupSurfaceData>().unwrap().lock().unwrap().current.geometry
                });
                let parent = self.parent(id).and_then(|parent| self.windows.get(&parent)).map_or((0, 0), |p| p.pos);
                (parent.0 + geometry.loc.x, parent.1 + geometry.loc.y)
            }
        };
        self.windows.get_mut(&id).unwrap().pos = pos;
    }

    fn metadata(&self, id: u64) -> Option<Value> {
        let win = self.windows.get(&id).filter(|win| win.mapped)?;
        let (title, owner, popup) = match &win.role {
            Role::Toplevel(toplevel) => {
                let title = with_states(toplevel.wl_surface(), |states| {
                    states.data_map.get::<XdgToplevelSurfaceData>().and_then(|data| data.lock().unwrap().title.clone())
                });
                let owner = toplevel.parent().and_then(|parent| self.id_of(&parent)).unwrap_or(0);
                (title.unwrap_or_default(), owner, false)
            }
            Role::Popup(_) => (String::new(), self.root(id), true),
        };
        let origin = win.capture_origin();
        Some(json!({
            "type": "window", "id": id, "title": title.chars().take(1024).collect::<String>(),
            "x": origin.0, "y": origin.1, "width": win.capture.size.w, "height": win.capture.size.h,
            "geometry": [win.geo.loc.x - win.capture.loc.x, win.geo.loc.y - win.capture.loc.y, win.geo.size.w, win.geo.size.h],
            "popup": popup, "owner": owner, "dialog": owner != 0 && !popup, "scale": win.scale, "alpha": win.alpha,
        }))
    }

    fn announce(&mut self, id: u64) {
        let meta = self.metadata(id);
        let win = self.windows.get_mut(&id).unwrap();
        if meta.is_some() && meta != win.meta {
            win.meta = meta.clone();
            self.send(meta.unwrap(), &[]);
        }
    }

    fn initial_configure(&mut self, id: u64) {
        let Some(win) = self.windows.get(&id) else { return };
        match &win.role {
            Role::Toplevel(toplevel) if !toplevel.is_initial_configure_sent() => {
                let dialog = toplevel.parent().is_some();
                toplevel.with_pending_state(|state| {
                    if !dialog {
                        state.size = Some(MAIN_SIZE.into());
                    }
                    state.decoration_mode = Some(DecorationMode::ServerSide);
                });
                self.output.enter(toplevel.wl_surface());
                toplevel.send_configure();
            }
            Role::Popup(popup) if !popup.is_initial_configure_sent() => {
                self.output.enter(popup.wl_surface());
                if let Err(error) = popup.send_configure() {
                    eprintln!("Popup configure failed: {error:?}");
                }
            }
            _ => {}
        }
    }

    fn capture(&mut self, id: u64, surface: &WlSurface, buffer: &wl_buffer::WlBuffer, damage: Vec<Damage>, scale: i32) {
        let started = Instant::now();
        let geometry = with_states(surface, |states| states.cached_state.get::<SurfaceCachedState>().current().geometry);
        let Some(win) = self.windows.get_mut(&id) else { return };
        let result = with_buffer_contents(buffer, |ptr, len, data| -> Result<Vec<[usize; 4]>, String> {
            if !matches!(data.format, wl_shm::Format::Argb8888 | wl_shm::Format::Xrgb8888) {
                return Err(format!("unsupported shm format {:?}", data.format));
            }
            let (bw, bh, stride, offset) = (data.width, data.height, data.stride, data.offset);
            if bw <= 0 || bh <= 0 || stride < bw * 4 || offset < 0
                || offset as usize + stride as usize * bh as usize > len {
                return Err("invalid shm buffer layout".into());
            }
            let surface_rect = Rectangle::from_size((bw / scale, bh / scale).into());
            let geo = geometry.and_then(|g| g.intersection(surface_rect)).unwrap_or(surface_rect);
            if geo.size.w <= 0 || geo.size.h <= 0 || geo.size.w > MAX_LOGICAL.0 || geo.size.h > MAX_LOGICAL.1 {
                return Err("window exceeds capture dimensions".into());
            }
            let capture = if matches!(win.role, Role::Popup(_)) { surface_rect } else { geo };
            if capture.size.w > MAX_LOGICAL.0 || capture.size.h > MAX_LOGICAL.1 {
                return Err("surface exceeds capture dimensions".into());
            }
            let (gx, gy) = ((capture.loc.x * scale) as i64, (capture.loc.y * scale) as i64);
            let (w, h) = ((capture.size.w * scale) as usize, (capture.size.h * scale) as usize);
            let full = !win.mapped || win.capture != capture || win.scale != scale;
            if full {
                win.pixels = vec![0; w * h * 4];
                win.width = w;
                win.height = h;
            }
            win.geo = geo;
            win.capture = capture;
            win.scale = scale;
            win.alpha = data.format == wl_shm::Format::Argb8888 && matches!(win.role, Role::Popup(_));
            let mut rects: Vec<[usize; 4]> = if full {
                vec![[0, 0, w, h]]
            } else {
                damage
                    .iter()
                    .filter_map(|damage| {
                        let (x, y, dw, dh) = match damage {
                            Damage::Surface(r) => (r.loc.x * scale, r.loc.y * scale, r.size.w * scale, r.size.h * scale),
                            Damage::Buffer(r) => (r.loc.x, r.loc.y, r.size.w, r.size.h),
                        };
                        let x0 = (x as i64 - gx).clamp(0, w as i64) as usize;
                        let y0 = (y as i64 - gy).clamp(0, h as i64) as usize;
                        let x1 = (x as i64 + dw as i64 - gx).clamp(0, w as i64) as usize;
                        let y1 = (y as i64 + dh as i64 - gy).clamp(0, h as i64) as usize;
                        (x1 > x0 && y1 > y0).then_some([x0, y0, x1 - x0, y1 - y0])
                    })
                    .collect()
            };
            let area: usize = rects.iter().map(|r| r[2] * r[3]).sum();
            if area * 100 > w * h * FULL_CAPTURE_SHARE {
                rects = vec![[0, 0, w, h]];
            } else if rects.len() > MAX_RECTS {
                let x0 = rects.iter().map(|r| r[0]).min().unwrap();
                let y0 = rects.iter().map(|r| r[1]).min().unwrap();
                let x1 = rects.iter().map(|r| r[0] + r[2]).max().unwrap();
                let y1 = rects.iter().map(|r| r[1] + r[3]).max().unwrap();
                rects = vec![[x0, y0, x1 - x0, y1 - y0]];
            }
            // SAFETY: the pool mapping is valid for `len` bytes and the buffer extent was checked above.
            let source = unsafe { std::slice::from_raw_parts(ptr.add(offset as usize), stride as usize * bh as usize) };
            let stride = stride as usize;
            for r in &rects {
                for row in r[1]..r[1] + r[3] {
                    let src = (gy as usize + row) * stride + (gx as usize + r[0]) * 4;
                    let dst = (row * w + r[0]) * 4;
                    win.pixels[dst..dst + r[2] * 4].copy_from_slice(&source[src..src + r[2] * 4]);
                }
            }
            Ok(rects)
        });
        let rects = match result {
            Ok(Ok(rects)) => rects,
            Ok(Err(error)) => return eprintln!("Window {id} capture skipped: {error}"),
            Err(error) => return eprintln!("Window {id} buffer unreadable: {error:?}"),
        };
        let win = self.windows.get_mut(&id).unwrap();
        let newly_mapped = !win.mapped;
        win.mapped = true;
        self.place(id);
        if newly_mapped {
            self.stacking.push(id);
            if let Role::Popup(_) = self.windows[&id].role {
                if self.pointer_trace {
                    eprintln!("POINTER map={id} at={:?}", self.windows[&id].pos);
                }
                if self.electron_menu_nudge { self.nudge_pointer(); }
            }
            if let Role::Toplevel(_) = self.windows[&id].role {
                eprintln!("VSPOD_MAPPED id={id}");
                self.activate(id);
            }
        }
        self.announce(id);
        if !rects.is_empty() {
            self.send_frame(id, &rects, "", started);
        }
    }

    fn send_frame(&mut self, id: u64, rects: &[[usize; 4]], tag: &str, started: Instant) {
        if self.host.is_none() {
            return;
        }
        let win = self.windows.get_mut(&id).unwrap();
        let mut payload = Vec::with_capacity(rects.iter().map(|r| r[2] * r[3] * 4).sum());
        for r in rects {
            for row in r[1]..r[1] + r[3] {
                let start = (row * win.width + r[0]) * 4;
                payload.extend_from_slice(&win.pixels[start..start + r[2] * 4]);
            }
        }
        let captured = Instant::now();
        let (payload, encoding) = if payload.len() >= COMPRESS_MIN_BYTES {
            // Raw DEFLATE at the fastest level, like the X11 agent: flat editor backgrounds compress well.
            let mut encoder = DeflateEncoder::new(Vec::with_capacity(payload.len() / 8), Compression::fast());
            encoder.write_all(&payload).expect("in-memory compression");
            (encoder.finish().expect("in-memory compression"), json!("deflate"))
        } else {
            (payload, Value::Null)
        };
        win.sequence += 1;
        let header = json!({
            "type": "frame", "id": id, "width": win.width, "height": win.height,
            "rects": rects, "sequence": win.sequence, "tag": tag, "encoding": encoding,
            "cap_us": (captured - started).as_micros() as u64,
            "comp_us": captured.elapsed().as_micros() as u64,
            "input_us": self.last_input.map_or(0, |at| started.saturating_duration_since(at).as_micros() as u64),
            "dirty_us": 0,
        });
        self.send(header, &payload);
    }

    fn send_full(&mut self, id: u64, tag: &str, started: Instant) {
        let (width, height) = (self.windows[&id].width, self.windows[&id].height);
        self.send_frame(id, &[[0, 0, width, height]], tag, started);
    }

    fn unmap(&mut self, id: u64) {
        if self.pointer_trace {
            eprintln!("POINTER unmap={id}");
        }
        let Some(win) = self.windows.get_mut(&id) else { return };
        if !win.mapped {
            return;
        }
        win.mapped = false;
        win.meta = None;
        self.stacking.retain(|&other| other != id);
        self.send(json!({"type": "destroy", "id": id}), &[]);
        if self.grabs.contains(&id) {
            self.grabs.retain(|&other| other != id);
            if self.grabs.is_empty() {
                self.restore_keyboard();
            }
        }
        if self.active == Some(id) {
            self.active = None;
        }
    }

    fn forget(&mut self, surface: &WlSurface) {
        if let Some(id) = self.id_of(surface) {
            self.unmap(id);
            self.windows.remove(&id);
            self.surfaces.remove(&surface.id());
        }
    }

    fn restore_keyboard(&mut self) {
        let focus = self.active.and_then(|id| self.windows.get(&id)).map(|win| win.surface().clone());
        let keyboard = self.seat.get_keyboard().unwrap();
        keyboard.set_focus(self, focus, SERIAL_COUNTER.next_serial());
    }

    fn activate(&mut self, id: u64) {
        let Some(Role::Toplevel(_)) = self.windows.get(&id).map(|win| &win.role) else { return };
        if self.active != Some(id) {
            for (&other, win) in &self.windows {
                if let Role::Toplevel(toplevel) = &win.role {
                    toplevel.with_pending_state(|state| {
                        if other == id {
                            state.states.set(xdg_toplevel::State::Activated);
                        } else {
                            state.states.unset(xdg_toplevel::State::Activated);
                        }
                    });
                    if toplevel.is_initial_configure_sent() {
                        toplevel.send_pending_configure();
                    }
                }
            }
            self.active = Some(id);
        }
        if self.grabs.is_empty() {
            self.restore_keyboard();
        }
    }

    fn dismiss_grabs(&mut self) {
        for id in std::mem::take(&mut self.grabs).into_iter().rev() {
            if let Some(Win { role: Role::Popup(popup), .. }) = self.windows.get(&id) {
                popup.send_popup_done();
            }
        }
        self.restore_keyboard();
    }

    fn key_event(&mut self, key: u32, down: bool) {
        let keyboard = self.seat.get_keyboard().unwrap();
        let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now());
        let state = if down { KeyState::Pressed } else { KeyState::Released };
        keyboard.input::<(), _>(self, key.into(), state, serial, time, |_, _, _| FilterResult::Forward);
        if down {
            self.pressed_keys.insert(key);
        } else {
            self.pressed_keys.remove(&key);
        }
    }

    fn button_event(&mut self, button: u32, down: bool) {
        let pointer = self.seat.get_pointer().unwrap();
        let state = if down { ButtonState::Pressed } else { ButtonState::Released };
        let event = ButtonEvent { serial: SERIAL_COUNTER.next_serial(), time: self.now(), button, state };
        pointer.button(self, &event);
        if down {
            self.pressed_buttons.insert(button);
        } else {
            self.pressed_buttons.remove(&button);
        }
    }

    fn release(&mut self) {
        for key in self.pressed_keys.clone() {
            self.key_event(key, false);
        }
        for button in self.pressed_buttons.clone() {
            self.button_event(button, false);
        }
        if let Some(pointer) = self.seat.get_pointer() {
            pointer.frame(self);
        }
    }

    /// Maps host-window coordinates into the shared layout and finds the topmost surface of the window's chain.
    #[allow(clippy::type_complexity)]
    fn target(&self, id: u64, x: i64, y: i64) -> (Point<f64, Logical>, Option<u64>, Option<(WlSurface, Point<f64, Logical>)>) {
        let root = self.root(id);
        let origin = self.windows[&id].capture_origin();
        let location: Point<f64, Logical> = ((origin.0 as i64 + x) as f64, (origin.1 as i64 + y) as f64).into();
        // Coordinates are relative to the host window but may lie outside it (AppKit's key window also sees
        // moves over its popup panels). Hit-test this toplevel's popups topmost first, then the toplevel.
        let hit = self.stacking.iter().rev().copied().find(|&other| {
            let win = &self.windows[&other];
            self.root(other) == root
                && location.x >= win.pos.0 as f64 && location.y >= win.pos.1 as f64
                && location.x < (win.pos.0 + win.geo.size.w) as f64 && location.y < (win.pos.1 + win.geo.size.h) as f64
        });
        let focus = hit.map(|hit| {
            let win = &self.windows[&hit];
            let origin = ((win.pos.0 - win.geo.loc.x) as f64, (win.pos.1 - win.geo.loc.y) as f64);
            (win.surface().clone(), Point::from(origin))
        });
        (location, hit, focus)
    }

    /// Electron switches menu-bar menus asynchronously and ignores moves at the position a menu opened at, so a
    /// pointer that comes to rest on another title mid-switch leaves the wrong menu open until it moves again.
    /// A real mouse jitters; when a menu maps under a resting pointer, move it 1 px and back.
    fn nudge_pointer(&mut self) {
        let timer = self.handle.insert_source(Timer::from_duration(Duration::from_millis(60)), |_, _, state| {
            if let Some((id, x, y, at)) = state.last_pointer {
                if at.elapsed() >= Duration::from_millis(50) && state.pressed_buttons.is_empty() && state.drop.is_none()
                    && state.windows.get(&id).is_some_and(|win| win.mapped && matches!(win.role, Role::Toplevel(_)))
                {
                    if state.pointer_trace {
                        eprintln!("POINTER nudge={id} at={x},{y}");
                    }
                    for (nx, ny) in [(x + 1, y), (x, y)] {
                        if let Err(error) = state.mouse(id, nx, ny, 0, false) {
                            eprintln!("Pointer nudge failed: {error}");
                        }
                    }
                    state.last_pointer = Some((id, x, y, at));
                }
            }
            TimeoutAction::Drop
        });
        if let Err(error) = timer {
            eprintln!("Pointer nudge timer: {error}");
        }
    }

    fn mouse(&mut self, id: u64, x: i64, y: i64, button: u64, down: bool) -> Result<(), String> {
        if !(-MAX_POINTER..=MAX_POINTER).contains(&x) || !(-MAX_POINTER..=MAX_POINTER).contains(&y) || button > 7 {
            return Err("invalid pointer input".into());
        }
        let root = self.root(id);
        self.last_pointer = Some((id, x, y, Instant::now()));
        let (location, hit, focus) = self.target(id, x, y);
        if (1..=3).contains(&button) && down {
            if !self.grabs.is_empty() && hit.map_or(true, |hit| !self.grabs.contains(&hit)) {
                // A press outside the grabbing popup chain dismisses it (xdg_popup.grab semantics).
                self.dismiss_grabs();
            }
            if !matches!(self.windows[&id].role, Role::Popup(_)) {
                self.activate(root);
            }
        }
        let pointer = self.seat.get_pointer().unwrap();
        let entering = focus.as_ref().map(|(surface, _)| surface.clone()) != pointer.current_focus();
        let event = MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time: self.now() };
        pointer.motion(self, focus.clone(), &event);
        if entering && focus.is_some() {
            // smithay sends only wl_pointer.enter on a focus change; Chromium updates menu hover on motion, so the
            // first move into a menu (or back into the window) would otherwise be lost until the pointer moves again.
            pointer.frame(self);
            let event = MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time: self.now() };
            pointer.motion(self, focus, &event);
        }
        match button {
            1..=3 => self.button_event(BUTTONS[button as usize - 1], down),
            4..=7 if down => {
                let (axis, sign) = match button {
                    4 => (Axis::Vertical, -1.0),
                    5 => (Axis::Vertical, 1.0),
                    6 => (Axis::Horizontal, -1.0),
                    _ => (Axis::Horizontal, 1.0),
                };
                let frame = AxisFrame::new(self.now()).source(AxisSource::Wheel).value(axis, sign * 15.0).v120(axis, (sign * 120.0) as i32);
                pointer.axis(self, frame);
            }
            _ => {}
        }
        pointer.frame(self);
        if self.pointer_trace {
            eprintln!("POINTER t={} from={id} at={:.0},{:.0} button={button} down={down} hit={hit:?} focus={:?} grabs={:?}",
                self.now(), location.x, location.y, pointer.current_focus().and_then(|surface| self.id_of(&surface)), self.grabs);
        }
        Ok(())
    }

    fn command(&mut self, request: &Value) -> Result<(), String> {
        let action = request["action"].as_str().unwrap_or_default();
        match action {
            "quit" => {
                self.drop_host();
                return Ok(());
            }
            "release" => {
                self.release();
                return Ok(());
            }
            "clipboard" => return self.set_clipboard(request),
            _ => {}
        }
        let Some(id) = request["id"].as_u64().filter(|id| self.windows.get(id).is_some_and(|win| win.mapped)) else {
            self.send(json!({"type": "rejected", "id": request["id"], "action": action, "message": "Unknown guest window"}), &[]);
            return Ok(());
        };
        if matches!(action, "key" | "mouse") && request["down"] == json!(true) {
            self.last_input = Some(Instant::now());
        }
        match action {
            "close" => {
                if let Role::Toplevel(toplevel) = &self.windows[&id].role {
                    toplevel.send_close();
                }
            }
            "resize" => {
                let (width, height) = (request["width"].as_i64().unwrap_or(0), request["height"].as_i64().unwrap_or(0));
                if !(300..=2400).contains(&width) || !(200..=1400).contains(&height) {
                    return Err("invalid native resize".into());
                }
                if let Role::Toplevel(toplevel) = &self.windows[&id].role {
                    toplevel.with_pending_state(|state| state.size = Some((width as i32, height as i32).into()));
                    toplevel.send_pending_configure();
                }
            }
            "focus" => self.activate(self.root(id)),
            "key" => {
                let (Some(key), Some(down)) = (request["key"].as_u64(), request["down"].as_bool()) else {
                    return Err("invalid key".into());
                };
                if !(8..=255).contains(&key) {
                    return Err("invalid key code".into());
                }
                let root = self.root(id);
                if self.grabs.is_empty() && self.active != Some(root) {
                    self.activate(root);
                }
                // macOS supplies auto-repeat (client repeat is disabled), so a repeated press is release+press.
                if down && self.pressed_keys.contains(&(key as u32)) {
                    self.key_event(key as u32, false);
                }
                self.key_event(key as u32, down);
            }
            "mouse" => {
                let (Some(x), Some(y), Some(button), Some(down)) =
                    (request["x"].as_i64(), request["y"].as_i64(), request["button"].as_u64(), request["down"].as_bool())
                else {
                    return Err("invalid mouse".into());
                };
                self.mouse(id, x, y, button, down)?;
            }
            "probe" => {
                let win = &self.windows[&id];
                let tag: String = request["tag"].as_str().unwrap_or_default().chars().take(80).collect();
                let header = json!({"type": "probe", "id": id, "width": win.width, "height": win.height, "tag": tag});
                let pixels = win.pixels.clone();
                self.send(header, &pixels);
            }
            "snapshot" => {
                let tag: String = request["tag"].as_str().unwrap_or_default().chars().take(80).collect();
                self.send_full(id, &tag, Instant::now());
            }
            "bounds" => {
                let values = ["x", "y", "width", "height"].map(|key| request[key].as_i64().unwrap_or(i64::MAX));
                if values.iter().any(|value| !(-MAX_POINTER..=MAX_POINTER).contains(value)) || values[2] < 1 || values[3] < 1 {
                    return Err("invalid screen bounds".into());
                }
                if let Role::Toplevel(_) = self.windows[&id].role {
                    let [x, y, width, height] = values.map(|value| value as i32);
                    self.bounds.insert(id, Rectangle::new((x, y).into(), (width, height).into()));
                }
            }
            "drop" => self.start_drop(id, request)?,
            _ => return Err("unsupported window command".into()),
        }
        Ok(())
    }
}

impl State {
    /// Writes host files into a fresh private staging directory and returns the top-level paths.
    fn stage(&mut self, entries: &Value) -> Result<Vec<PathBuf>, String> {
        let entries = entries.as_array().filter(|entries| !entries.is_empty() && entries.len() <= MAX_ENTRIES)
            .ok_or("invalid transfer entries")?;
        self.transfer_serial += 1;
        let _ = fs::DirBuilder::new().mode(0o700).create(STAGING);
        let root = Path::new(STAGING).join(self.transfer_serial.to_string());
        fs::DirBuilder::new().mode(0o700).create(&root).map_err(|error| format!("staging: {error}"))?;
        let (mut total, mut top) = (0, Vec::new());
        for entry in entries {
            let relative = entry["path"].as_str().ok_or("missing entry path")?;
            let path = Path::new(relative);
            let safe = relative.len() <= 1024
                && path.components().next().is_some()
                && path.components().all(|part| matches!(part, Component::Normal(name) if name.len() <= 255));
            if !safe {
                return Err("unsafe entry path".into());
            }
            let target = root.join(path);
            // Directories precede their contents, so nothing is created implicitly.
            if !target.parent().is_some_and(|parent| parent == root || parent.is_dir()) {
                return Err("entry parent is missing".into());
            }
            match entry["kind"].as_str() {
                Some("directory") => fs::DirBuilder::new().mode(0o700).create(&target),
                Some("file") => {
                    let data = decode(&entry["data"])?;
                    total += data.len();
                    if total > TRANSFER_LIMIT {
                        return Err("transfer exceeds 8 MiB".into());
                    }
                    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&target)
                        .and_then(|mut file| file.write_all(&data))
                }
                _ => return Err("invalid entry kind".into()),
            }
            .map_err(|error| format!("staging {relative}: {error}"))?;
            if path.components().count() == 1 {
                top.push(target);
            }
        }
        Ok(top)
    }

    /// Host paste: the compositor owns the guest clipboard until a guest client copies again.
    fn set_clipboard(&mut self, request: &Value) -> Result<(), String> {
        let kind = request["kind"].as_str().unwrap_or_default();
        let mut data = HashMap::new();
        match kind {
            "text" => {
                let text = request["text"].as_str().filter(|text| text.len() <= TRANSFER_LIMIT).ok_or("invalid clipboard text")?;
                for mime in TEXT_MIMES {
                    data.insert(mime.to_string(), text.as_bytes().to_vec());
                }
            }
            "image" => {
                let png = decode(&request["data"])?;
                if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
                    return Err("clipboard image is not a PNG".into());
                }
                data.insert("image/png".to_string(), png);
            }
            "files" => {
                let uris: Vec<String> = self.stage(&request["entries"])?.iter().map(|path| file_uri(path)).collect();
                data.insert("text/uri-list".to_string(), format!("{}\r\n", uris.join("\r\n")).into_bytes());
                data.insert("code/file-list".to_string(), uris.join("\n").into_bytes());
                data.insert("x-special/gnome-copied-files".to_string(), format!("copy\n{}", uris.join("\n")).into_bytes());
            }
            _ => return Err("invalid clipboard kind".into()),
        }
        let mimes = data.keys().cloned().collect();
        set_data_device_selection(&self.dh, &self.seat, mimes, Arc::new(data));
        self.clipboard_serial += 1;
        eprintln!("VSPOD_CLIPBOARD_SET kind={kind}");
        self.send(json!({"type": "clipboardSet", "kind": kind}), &[]);
        Ok(())
    }

    /// Guest copy: mirrored to the host only right after a host gesture, read off the event loop.
    fn guest_selection(&mut self, source: SelectionSource) {
        let mimes = source.mime_types();
        let recent = self.last_input.is_some_and(|time| time.elapsed() < COPY_GATE);
        let choice = FILE_MIMES.iter().find(|mime| mimes.iter().any(|offered| offered == *mime)).map(|mime| ("files", *mime))
            .or_else(|| mimes.iter().any(|mime| mime == "image/png").then_some(("image", "image/png")))
            .or_else(|| TEXT_MIMES.iter().find(|mime| mimes.iter().any(|offered| offered == *mime)).map(|mime| ("text", *mime)));
        let (Some((kind, mime)), true) = (choice, recent) else {
            eprintln!("VSPOD_CLIPBOARD_IGNORED recent={recent} mimes={mimes:?}");
            self.send(json!({"type": "clipboardIgnored", "reason": if recent { "unsupported" } else { "no recent input" }}), &[]);
            return;
        };
        self.clipboard_serial += 1;
        let serial = self.clipboard_serial;
        // smithay stores the new selection only after this callback returns.
        self.handle.insert_idle(move |state| state.read_guest_selection(serial, kind, mime));
    }

    fn read_guest_selection(&mut self, serial: u64, kind: &'static str, mime: &'static str) {
        if serial != self.clipboard_serial {
            return;
        }
        let (reader, writer) = match io::pipe() {
            Ok(pipe) => pipe,
            Err(error) => return eprintln!("Clipboard pipe failed: {error}"),
        };
        if let Err(error) = request_data_device_client_selection(&self.seat, mime.to_string(), OwnedFd::from(writer)) {
            return eprintln!("Guest clipboard read failed: {error}");
        }
        let events = self.host_events.clone();
        let export_roots = self.export_roots.clone();
        thread::spawn(move || {
            let (header, payload) = read_pipe(reader).and_then(|bytes| export(kind, bytes, &export_roots))
                .unwrap_or_else(|reason| (json!({"type": "clipboardIgnored", "reason": reason}), Vec::new()));
            let _ = events.send(HostEvent::GuestClipboard(serial, header, payload));
        });
    }

    /// Host Finder drop: stage the files, then run a server-side drag (enter, motion, drop) at the drop point.
    fn start_drop(&mut self, id: u64, request: &Value) -> Result<(), String> {
        let (Some(x), Some(y)) = (request["x"].as_i64(), request["y"].as_i64()) else { return Err("invalid drop point".into()) };
        if !(-MAX_POINTER..=MAX_POINTER).contains(&x) || !(-MAX_POINTER..=MAX_POINTER).contains(&y) {
            return Err("invalid drop point".into());
        }
        if self.drop.is_some() || !self.pressed_buttons.is_empty() {
            return Err("a drag is already in progress".into());
        }
        let uris: Vec<String> = self.stage(&request["entries"])?.iter().map(|path| file_uri(path)).collect();
        self.drop = Some(HostDrop { id, x, y, uris: Arc::new(format!("{}\r\n", uris.join("\r\n")).into_bytes()) });
        self.last_input = Some(Instant::now());
        self.mouse(id, x, y, 0, false)?;
        let (location, _, focus) = self.target(id, x, y);
        let (dh, seat) = (self.dh.clone(), self.seat.clone());
        let metadata = SourceMetadata { mime_types: vec!["text/uri-list".into()], dnd_action: DndAction::Copy };
        let start = PointerGrabStartData { focus, button: BUTTONS[0], location };
        start_dnd(&dh, &seat, self, SERIAL_COUNTER.next_serial(), Some(start), None, metadata);
        // The first motion enters the target with the offer; later ones let the client settle accept/action
        // (Chromium reads the data on enter) before the button release drops.
        self.mouse(id, x, y, 0, false)?;
        let steps = [(Duration::from_millis(150), false), (Duration::from_millis(400), true)];
        for (delay, release) in steps {
            let timer = self.handle.insert_source(Timer::from_duration(delay), move |_, _, state| {
                let Some((id, x, y)) = state.drop.as_ref().map(|drop| (drop.id, drop.x, drop.y)) else {
                    return TimeoutAction::Drop;
                };
                if !state.windows.contains_key(&id) {
                    state.end_drop("cancelled");
                } else if release {
                    state.button_event(BUTTONS[0], false);
                    if let Some(pointer) = state.seat.get_pointer() {
                        pointer.frame(state);
                    }
                } else if let Err(error) = state.mouse(id, x, y + 1, 0, false) {
                    eprintln!("Drop motion failed: {error}");
                }
                TimeoutAction::Drop
            });
            if let Err(error) = timer {
                return Err(format!("drop timer: {error}"));
            }
        }
        eprintln!("VSPOD_DROP_STARTED id={id} entries={}", uris.len());
        Ok(())
    }

    fn end_drop(&mut self, result: &str) {
        if self.drop.take().is_some() {
            eprintln!("VSPOD_DROP result={result}");
            self.send(json!({"type": "drop", "result": result}), &[]);
        }
    }

    fn open(&mut self, url: String) {
        let valid = (url.starts_with("https://") || url.starts_with("http://"))
            && url.len() <= 2048
            && !url.chars().any(|character| character.is_whitespace() || character.is_control());
        let recent = self.last_input.is_some_and(|time| time.elapsed() < OPEN_GATE) && self.last_open < self.last_input;
        if !valid || !recent {
            let reason = if valid { "no recent input" } else { "unsupported URL" };
            eprintln!("VSPOD_OPEN_REJECTED reason={reason}");
            self.send(json!({"type": "openRejected", "reason": reason}), &[]);
            return;
        }
        self.last_open = self.last_input;
        self.send(json!({"type": "open", "url": url}), &[]);
    }
}

fn decode(value: &Value) -> Result<Vec<u8>, String> {
    let text = value.as_str().filter(|text| text.len() <= TRANSFER_LIMIT / 3 * 4 + 4).ok_or("invalid or oversized data")?;
    BASE64.decode(text).map_err(|_| "invalid base64".to_string())
}

fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for &byte in path.as_os_str().as_encoded_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => uri.push(byte as char),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

fn uri_path(uri: &str) -> Option<PathBuf> {
    let encoded = uri.strip_prefix("file://")?.as_bytes();
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' {
            let hex = std::str::from_utf8(encoded.get(index + 1..index + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            bytes.push(encoded[index]);
            index += 1;
        }
    }
    let path = PathBuf::from(String::from_utf8(bytes).ok()?);
    path.is_absolute().then_some(path)
}

/// Reads a client's selection data with a size limit; a client that never closes the pipe times out.
fn read_pipe(reader: io::PipeReader) -> Result<Vec<u8>, String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = sender.send(reader.take(TRANSFER_LIMIT as u64 + 1).read_to_end(&mut bytes).map(|_| bytes));
    });
    match receiver.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(bytes)) if bytes.len() <= TRANSFER_LIMIT => Ok(bytes),
        Ok(Ok(_)) => Err("clipboard exceeds 8 MiB".into()),
        Ok(Err(error)) => Err(format!("clipboard read failed: {error}")),
        Err(_) => Err("clipboard read timed out".into()),
    }
}

/// Converts guest clipboard data into a host message; files are read only from the permitted export roots.
fn export(kind: &str, bytes: Vec<u8>, export_roots: &[PathBuf]) -> Result<(Value, Vec<u8>), String> {
    match kind {
        "text" => {
            String::from_utf8(bytes.clone()).map_err(|_| "clipboard text is not UTF-8")?;
            Ok((json!({"type": "clipboard", "kind": "text"}), bytes))
        }
        "image" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok((json!({"type": "clipboard", "kind": "image"}), bytes)),
        "files" => {
            let list = String::from_utf8(bytes).map_err(|_| "file list is not UTF-8")?;
            let (mut entries, mut payload, mut names) = (Vec::new(), Vec::new(), HashSet::new());
            for uri in list.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
                let path = uri_path(uri).ok_or("only container-local file URLs are exported")?;
                let canonical = path.canonicalize().map_err(|_| "copied file is missing")?;
                if canonical != path || !export_roots.iter().any(|root| path.starts_with(root) && path != *root) {
                    return Err("copied file is outside permitted export roots or follows a symlink".into());
                }
                let name = path.file_name().and_then(|name| name.to_str()).ok_or("invalid file name")?.to_string();
                if !names.insert(name.clone()) {
                    return Err("duplicate top-level file name".into());
                }
                collect(&path, &name, &mut entries, &mut payload)?;
            }
            if entries.is_empty() {
                return Err("empty file list".into());
            }
            Ok((json!({"type": "clipboard", "kind": "files", "entries": entries}), payload))
        }
        _ => Err("unsupported clipboard data".into()),
    }
}

fn collect(path: &Path, relative: &str, entries: &mut Vec<Value>, payload: &mut Vec<u8>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("{relative}: {error}"))?;
    if entries.len() >= MAX_ENTRIES {
        return Err("more than 100 files".into());
    }
    if metadata.is_dir() {
        entries.push(json!({"path": relative, "kind": "directory"}));
        let mut children: Vec<_> = fs::read_dir(path).map_err(|error| error.to_string())?
            .filter_map(|child| child.ok().and_then(|child| child.file_name().into_string().ok()))
            .collect();
        children.sort();
        for child in children {
            collect(&path.join(&child), &format!("{relative}/{child}"), entries, payload)?;
        }
    } else if metadata.is_file() {
        if payload.len() as u64 + metadata.len() > TRANSFER_LIMIT as u64 {
            return Err("copied files exceed 8 MiB".into());
        }
        let data = fs::read(path).map_err(|error| format!("{relative}: {error}"))?;
        entries.push(json!({"path": relative, "kind": "file", "bytes": data.len()}));
        payload.extend(data);
    } else {
        return Err("symlinks and special files are not exported".into());
    }
    Ok(())
}

impl CompositorHandler for State {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().unwrap().compositor
    }

    fn commit(&mut self, surface: &WlSurface) {
        let id = self.id_of(surface);
        if let Some(id) = id {
            self.initial_configure(id);
        }
        let (buffer, damage, scale, callbacks) = with_states(surface, |states| {
            let mut guard = states.cached_state.get::<SurfaceAttributes>();
            let attrs = guard.current();
            (
                attrs.buffer.take(),
                std::mem::take(&mut attrs.damage),
                attrs.buffer_scale.max(1),
                std::mem::take(&mut attrs.frame_callbacks),
            )
        });
        match (id, buffer) {
            (Some(id), Some(BufferAssignment::NewBuffer(buffer))) => {
                self.capture(id, surface, &buffer, damage, scale);
                buffer.release();
            }
            (Some(id), Some(BufferAssignment::Removed)) => self.unmap(id),
            // Cursor and subsurface buffers are not composited in this spike.
            (None, Some(BufferAssignment::NewBuffer(buffer))) => buffer.release(),
            _ => {}
        }
        // The frame is already written to the host (blocking), which paces the client.
        let time = self.now();
        for callback in callbacks {
            callback.done(time);
        }
    }
}

impl State {
    /// Applies the client's flip/slide/resize rules against the host screen's visible area, so menus near a
    /// screen edge open inwards like native ones (no host bounds yet: the requested position is used as is).
    fn popup_geometry(&self, surface: &PopupSurface, positioner: PositionerState) -> Rectangle<i32, Logical> {
        let Some(parent) = surface.get_parent_surface().and_then(|parent| self.id_of(&parent)) else {
            return positioner.get_geometry();
        };
        let root = self.root(parent);
        let (Some(bounds), Some(root_win), Some(parent_win)) = (self.bounds.get(&root), self.windows.get(&root), self.windows.get(&parent))
        else {
            return positioner.get_geometry();
        };
        // Bounds are relative to the root's window geometry; popup geometry is relative to the parent's.
        let offset = (root_win.pos.0 - parent_win.pos.0, root_win.pos.1 - parent_win.pos.1);
        let target = Rectangle::new((bounds.loc.x + offset.0, bounds.loc.y + offset.1).into(), bounds.size);
        positioner.get_unconstrained_geometry(target)
    }
}

impl XdgShellHandler for State {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        self.register(Role::Toplevel(surface));
    }

    fn new_popup(&mut self, surface: PopupSurface, positioner: PositionerState) {
        let geometry = self.popup_geometry(&surface, positioner);
        surface.with_pending_state(|state| state.geometry = geometry);
        self.register(Role::Popup(surface));
    }

    fn grab(&mut self, surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        if let Some(id) = self.id_of(surface.wl_surface()) {
            self.grabs.push(id);
            let keyboard = self.seat.get_keyboard().unwrap();
            keyboard.set_focus(self, Some(surface.wl_surface().clone()), SERIAL_COUNTER.next_serial());
        }
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        let geometry = self.popup_geometry(&surface, positioner);
        surface.with_pending_state(|state| {
            state.geometry = geometry;
            state.positioner = positioner;
        });
        surface.send_repositioned(token);
        if let Err(error) = surface.send_configure() {
            eprintln!("Popup reposition failed: {error:?}");
        }
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        self.forget(surface.wl_surface());
    }

    fn popup_destroyed(&mut self, surface: PopupSurface) {
        self.forget(surface.wl_surface());
    }

    fn title_changed(&mut self, surface: ToplevelSurface) {
        if let Some(id) = self.id_of(surface.wl_surface()) {
            self.announce(id);
        }
    }

    fn parent_changed(&mut self, surface: ToplevelSurface) {
        if let Some(id) = self.id_of(surface.wl_surface()) {
            self.place(id);
            self.announce(id);
        }
    }
}

impl XdgDecorationHandler for State {
    // Server-side decoration: the native macOS title bar replaces Chromium's client-side frame.
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        force_server_decoration(&toplevel);
    }
    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: DecorationMode) {
        force_server_decoration(&toplevel);
    }
    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        force_server_decoration(&toplevel);
    }
}

impl KdeDecorationHandler for State {
    fn kde_decoration_state(&self) -> &KdeDecorationState {
        &self.kde_decoration
    }
    fn new_decoration(&mut self, _surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration) {
        decoration.mode(KdeMode::Server);
    }
    fn request_mode(&mut self, _surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration, _mode: WEnum<KdeMode>) {
        decoration.mode(KdeMode::Server);
    }
}

fn force_server_decoration(toplevel: &ToplevelSurface) {
    toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
    if toplevel.is_initial_configure_sent() {
        toplevel.send_pending_configure();
    }
}

impl SeatHandler for State {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|surface| self.dh.get_client(surface.id()).ok());
        set_data_device_focus(&self.dh, seat, client);
    }

    fn cursor_image(&mut self, _seat: &Seat<Self>, image: CursorImageStatus) {
        // Names only: the host maps CSS cursor names to native NSCursors; "default" is the fallback.
        let names: Vec<String> = match image {
            CursorImageStatus::Hidden => vec![],
            CursorImageStatus::Named(icon) => vec![icon.name().to_string(), "default".into()],
            CursorImageStatus::Surface(_) => vec!["default".into()],
        };
        if self.cursor.get("names") == Some(&json!(names)) {
            return;
        }
        self.cursor_serial += 1;
        self.cursor = json!({"type": "cursor", "width": 1, "height": 1, "xhot": 0, "yhot": 0,
                             "names": names, "serial": self.cursor_serial});
        // A transparent 1x1 image: an empty name list therefore hides the cursor.
        self.send(self.cursor.clone(), &[0; 4]);
    }
}

impl BufferHandler for State {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for State {
    fn shm_state(&self) -> &ShmState {
        &self.shm
    }
}

impl SelectionHandler for State {
    type SelectionUserData = Arc<HashMap<String, Vec<u8>>>;

    fn new_selection(&mut self, ty: SelectionTarget, source: Option<SelectionSource>, _seat: Seat<Self>) {
        if let (SelectionTarget::Clipboard, Some(source)) = (ty, source) {
            self.guest_selection(source);
        }
    }

    fn send_selection(&mut self, _ty: SelectionTarget, mime: String, fd: OwnedFd, _seat: Seat<Self>, data: &Self::SelectionUserData) {
        if let Some(bytes) = data.get(&mime) {
            write_async(fd, Arc::new(bytes.clone()));
        }
    }
}

/// Writes selection or drag data without blocking the event loop on a slow reader.
fn write_async(fd: OwnedFd, bytes: Arc<Vec<u8>>) {
    thread::spawn(move || {
        if let Err(error) = File::from(fd).write_all(&bytes) {
            eprintln!("Transfer write failed: {error}");
        }
    });
}

impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device
    }
}

impl ClientDndGrabHandler for State {}
impl ServerDndGrabHandler for State {
    fn send(&mut self, mime_type: String, fd: OwnedFd, _seat: Seat<Self>) {
        if let (Some(drop), "text/uri-list") = (&self.drop, mime_type.as_str()) {
            write_async(fd, drop.uris.clone());
        }
    }
    fn dropped(&mut self, _seat: Seat<Self>) {
        eprintln!("VSPOD_DROP_RELEASED");
    }
    fn cancelled(&mut self, _seat: Seat<Self>) {
        self.end_drop("cancelled");
    }
    fn finished(&mut self, _seat: Seat<Self>) {
        self.end_drop("dropped");
    }
}

impl OutputHandler for State {}
impl TabletSeatHandler for State {}

#[derive(Default)]
struct ClientState {
    compositor: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, client: ClientId) {
        eprintln!("Wayland client connected: {client:?}");
    }
    fn disconnected(&self, client: ClientId, reason: DisconnectReason) {
        eprintln!("Wayland client disconnected: {client:?} {reason:?}");
    }
}

delegate_compositor!(State);
delegate_xdg_shell!(State);
delegate_xdg_decoration!(State);
delegate_kde_decoration!(State);
delegate_shm!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_output!(State);
delegate_cursor_shape!(State);
delegate_xdg_foreign!(State);

impl XdgForeignHandler for State {
    fn xdg_foreign_state(&mut self) -> &mut XdgForeignState {
        &mut self.xdg_foreign
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut export_roots: Vec<PathBuf> = serde_json::from_str(&env::var("APP_RUNNER_EXPORT_ROOTS").unwrap_or("[]".into()))?;
    for root in &export_roots {
        if !root.is_absolute() || root == Path::new("/") ||
            root.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
            return Err("invalid app-runner export root".into());
        }
    }
    export_roots.push(PathBuf::from(STAGING));
    let scale: i32 = env::var("APP_RUNNER_SCALE").unwrap_or("2".into()).parse()?;
    if !(1..=2).contains(&scale) { return Err("app-runner scale must be 1 or 2".into()); }
    let mut event_loop: EventLoop<'static, State> = EventLoop::try_new()?;
    let display: Display<State> = Display::new()?;
    let dh = display.handle();

    let output = Output::new("vspod-0".into(), PhysicalProperties {
        size: (0, 0).into(),
        subpixel: Subpixel::Unknown,
        make: "VSPod".into(),
        model: "Native host".into(),
    });
    let _output_global = output.create_global::<State>(&dh);
    let mode = OutputMode { size: (OUTPUT_SIZE.0 * scale, OUTPUT_SIZE.1 * scale).into(), refresh: 60_000 };
    output.change_current_state(Some(mode), Some(Transform::Normal), Some(Scale::Integer(scale)), Some((0, 0).into()));
    output.set_preferred(mode);

    let mut seat_state = SeatState::new();
    let mut seat = seat_state.new_wl_seat(&dh, "seat0");
    // Repeat rate 0 disables client-side repeat; the host forwards macOS auto-repeat instead.
    seat.add_keyboard(XkbConfig::default(), 400, 0)?;
    seat.add_pointer();

    let (host_events, host_receiver) = channel::channel::<HostEvent>();
    let handle = event_loop.handle();
    handle.insert_source(host_receiver, |event, _, state| {
        if let channel::Event::Msg(event) = event {
            state.host_event(event);
        }
    }).map_err(|error| error.error)?;

    let _ = std::fs::remove_file(HOST_SOCKET);
    let listener = UnixListener::bind(HOST_SOCKET)?;
    listener.set_nonblocking(true)?;
    handle.insert_source(Generic::new(listener, Interest::READ, Mode::Level), |_, listener, state| {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(error) = state.attach(stream) {
                    eprintln!("Host attach failed: {error}");
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => eprintln!("Host accept failed: {error}"),
        }
        Ok(PostAction::Continue)
    }).map_err(|error| error.error)?;

    let _ = std::fs::remove_file(OPEN_SOCKET);
    let opener = UnixListener::bind(OPEN_SOCKET)?;
    opener.set_nonblocking(true)?;
    let open_events = host_events.clone();
    handle.insert_source(Generic::new(opener, Interest::READ, Mode::Level), move |_, listener, _| {
        if let Ok((stream, _)) = listener.accept() {
            let events = open_events.clone();
            thread::spawn(move || {
                let _ = stream.set_nonblocking(false).and_then(|_| stream.set_read_timeout(Some(Duration::from_secs(2))));
                let mut line = String::new();
                if BufReader::new(stream.take(4096)).read_line(&mut line).is_ok() {
                    let _ = events.send(HostEvent::Open(line.trim_end_matches('\n').to_string()));
                }
            });
        }
        Ok(PostAction::Continue)
    }).map_err(|error| error.error)?;

    let socket = ListeningSocketSource::with_name("wayland-1")?;
    handle.insert_source(socket, |stream, _, state| {
        if let Err(error) = state.dh.insert_client(stream, Arc::new(ClientState::default())) {
            eprintln!("Cannot add Wayland client: {error}");
        }
    }).map_err(|error| error.error)?;
    handle.insert_source(Generic::new(display, Interest::READ, Mode::Level), |_, display, state| {
        // SAFETY: the display is not dropped while the event loop dispatches it.
        unsafe { display.get_mut().dispatch_clients(state)?; }
        Ok(PostAction::Continue)
    }).map_err(|error| error.error)?;

    let mut state = State {
        compositor: CompositorState::new::<State>(&dh),
        xdg: XdgShellState::new::<State>(&dh),
        shm: ShmState::new::<State>(&dh, vec![]),
        data_device: DataDeviceState::new::<State>(&dh),
        xdg_foreign: XdgForeignState::new::<State>(&dh),
        kde_decoration: KdeDecorationState::new::<State>(&dh, KdeDefaultMode::Server),
        seat_state,
        output,
        seat,
        start: Instant::now(),
        next_id: 0,
        windows: HashMap::new(),
        surfaces: HashMap::new(),
        stacking: Vec::new(),
        grabs: Vec::new(),
        active: None,
        host: None,
        host_generation: 0,
        host_events,
        cursor: Value::Null,
        cursor_serial: 0,
        pressed_keys: HashSet::new(),
        pressed_buttons: HashSet::new(),
        last_input: None,
        pointer_trace: env::var("APP_RUNNER_POINTER_TRACE").is_ok_and(|value| value == "1"),
        handle: handle.clone(),
        bounds: HashMap::new(),
        clipboard_serial: 0,
        transfer_serial: 0,
        drop: None,
        last_open: None,
        last_pointer: None,
        electron_menu_nudge: env::var("APP_RUNNER_ELECTRON_MENU_NUDGE").is_ok_and(|value| value == "1"),
        export_roots,
        dh: dh.clone(),
    };
    let _decoration = XdgDecorationState::new::<State>(&dh);
    let _output_manager = OutputManagerState::new_with_xdg_output::<State>(&dh);
    let _cursor_shape = CursorShapeManagerState::new::<State>(&dh);
    eprintln!("VSPOD_COMPOSITOR_READY socket=wayland-1 scale={scale}");
    event_loop.run(None, &mut state, |state| {
        let _ = state.dh.flush_clients();
    })?;
    Ok(())
}

/// Connects the host's `docker exec -i` stdio to the compositor's host socket.
fn bridge() -> io::Result<()> {
    // Plain read/write loops: std::io::copy specialises socket<->pipe copies to splice(2), and splicing from
    // an AF_UNIX stream waits for more data instead of forwarding what is already queued, stalling frames.
    fn pump(mut from: impl Read, mut to: impl Write) -> io::Result<()> {
        let mut buffer = vec![0; 1 << 20];
        loop {
            let count = match from.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            to.write_all(&buffer[..count])?;
        }
    }
    let stream = UnixStream::connect(HOST_SOCKET)?;
    let writer = stream.try_clone()?;
    thread::spawn(move || {
        let _ = pump(io::stdin().lock(), &writer);
        let _ = writer.shutdown(std::net::Shutdown::Write);
    });
    // SAFETY: fd 1 is this process's stdout and is not otherwise used; unbuffered avoids line flushing.
    let stdout = unsafe { File::from_raw_fd(1) };
    pump(&stream, stdout)
}

/// `xdg-open URL` inside the container: hand the URL to the compositor, which applies the policy.
fn open_url(url: &str) -> io::Result<()> {
    if url.len() > 2048 || url.contains('\n') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid URL"));
    }
    UnixStream::connect(OPEN_SOCKET)?.write_all(format!("{url}\n").as_bytes())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("--bridge") => bridge().map_err(|error| error.into()),
        Some("--open") if args.len() == 3 => open_url(&args[2]).map_err(|error| error.into()),
        _ => run(),
    };
    if let Err(error) = result {
        eprintln!("vspod-compositor failed: {error}");
        std::process::exit(1);
    }
}
