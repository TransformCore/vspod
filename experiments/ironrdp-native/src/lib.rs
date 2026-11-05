use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::Instant,
};

use anyhow::{Context, Result, bail, ensure};
use ironrdp::{
    connector::{self, Config, Credentials, DesktopSize, Sequence},
    core::WriteBuf,
    displaycontrol::client::DisplayControlClient,
    dvc::DrdynvcClient,
    graphics::{image_processing::PixelFormat, pointer::DecodedPointer},
    pdu::{
        gcc::KeyboardType,
        geometry::InclusiveRectangle,
        input::{
            MousePdu,
            fast_path::{FastPathInputEvent, KeyboardFlags},
            mouse::PointerFlags,
        },
        rdp::{
            capability_sets::MajorPlatformType,
            client_info::{PerformanceFlags, TimezoneInfo},
        },
    },
    session::{ActiveStageBuilder, ActiveStageOutput, image::DecodedImage},
};
use ironrdp_tokio::{FramedWrite, NetworkClient, TokioFramed};
use sha2::{Digest, Sha256};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot},
};

type Notify = extern "C" fn(*mut c_void, u32, *const c_char);
type Frame = extern "C" fn(*mut c_void, *const u8, u32, u32, u32, u32, u32, u32, u64, f64);
type Cursor = extern "C" fn(*mut c_void, u32, *const u8, u32, u32, u32, u32);

enum CursorState {
    Default,
    Hidden,
    Bitmap(Arc<DecodedPointer>),
}

impl CursorState {
    fn bitmap(pointer: Arc<DecodedPointer>) -> Result<Self> {
        let width = usize::from(pointer.width);
        let height = usize::from(pointer.height);
        if width == 0 && height == 0 && pointer.bitmap_data.is_empty() {
            return Ok(Self::Hidden);
        }
        ensure!(
            (1..=384).contains(&width)
                && (1..=384).contains(&height)
                && usize::from(pointer.hotspot_x) < width
                && usize::from(pointer.hotspot_y) < height
                && pointer.bitmap_data.len() == width * height * 4,
            "Invalid cursor bitmap"
        );
        Ok(Self::Bitmap(pointer))
    }

    fn deliver(&self, callback: Cursor, context: *mut c_void) {
        match self {
            Self::Default => callback(context, 0, std::ptr::null(), 0, 0, 0, 0),
            Self::Hidden => callback(context, 1, std::ptr::null(), 0, 0, 0, 0),
            Self::Bitmap(pointer) => callback(
                context,
                2,
                pointer.bitmap_data.as_ptr(),
                pointer.width.into(),
                pointer.height.into(),
                pointer.hotspot_x.into(),
                pointer.hotspot_y.into(),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

impl Rect {
    fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Self {
            x,
            y,
            width: (self.x + self.width).max(other.x + other.width) - x,
            height: (self.y + self.height).max(other.y + other.height) - y,
        }
    }
}

#[derive(Default)]
struct Mailbox {
    pixels: Vec<u8>,
    width: usize,
    height: usize,
    dirty: Option<Rect>,
    generation: u64,
    updated: Option<Instant>,
}

impl Mailbox {
    fn update(&mut self, data: &[u8], width: usize, height: usize, rect: Rect) -> Result<()> {
        ensure!(
            width > 0 && height > 0 && width <= 4096 && height <= 4096,
            "Invalid framebuffer size"
        );
        ensure!(
            data.len() == width * height * 4,
            "Invalid framebuffer bytes"
        );
        ensure!(
            rect.width > 0
                && rect.height > 0
                && rect.x + rect.width <= width
                && rect.y + rect.height <= height,
            "Invalid dirty rectangle"
        );
        let rect = if self.width != width || self.height != height {
            self.pixels.resize(data.len(), 0);
            self.width = width;
            self.height = height;
            self.dirty = None;
            Rect {
                x: 0,
                y: 0,
                width,
                height,
            }
        } else {
            rect
        };
        for y in rect.y..rect.y + rect.height {
            let start = (y * width + rect.x) * 4;
            let end = start + rect.width * 4;
            self.pixels[start..end].copy_from_slice(&data[start..end]);
        }
        self.dirty = Some(self.dirty.map_or(rect, |old| old.union(rect)));
        self.generation += 1;
        self.updated = Some(Instant::now());
        Ok(())
    }
}

#[derive(Clone)]
struct Shared {
    mailbox: Arc<Mutex<Mailbox>>,
    cursor: Arc<Mutex<Option<CursorState>>>,
    notify: Notify,
    context: usize,
}

impl Shared {
    fn cursor(&self, cursor: CursorState) {
        *self.cursor.lock().expect("cursor mutex poisoned") = Some(cursor);
        self.notify(3, "");
    }

    fn notify(&self, kind: u32, message: &str) {
        let text = CString::new(message.replace('\0', "?")).expect("NUL removed");
        (self.notify)(self.context as *mut c_void, kind, text.as_ptr());
    }

    fn publish(&self, image: &DecodedImage, rect: InclusiveRectangle) -> Result<()> {
        ensure!(
            rect.right >= rect.left && rect.bottom >= rect.top,
            "Reversed dirty rectangle"
        );
        let rectangle = Rect {
            x: rect.left.into(),
            y: rect.top.into(),
            width: usize::from(rect.right - rect.left) + 1,
            height: usize::from(rect.bottom - rect.top) + 1,
        };
        self.mailbox.lock().expect("frame mutex poisoned").update(
            image.data(),
            image.width().into(),
            image.height().into(),
            rectangle,
        )?;
        self.notify(0, "");
        Ok(())
    }
}

struct Handle {
    shared: Shared,
    input: mpsc::Sender<(u32, u32, u32, u32)>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

fn config() -> Config {
    Config {
        credentials: Credentials::UsernamePassword {
            username: "spike".into(),
            password: "unused".into(),
        },
        domain: None,
        enable_tls: true,
        enable_credssp: false,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0x409,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: 1100,
            height: 750,
        },
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: false,
            color_depth: 32,
            codecs: ironrdp::pdu::rdp::capability_sets::BitmapCodecs(Vec::new()),
        }),
        client_build: 0,
        client_name: "vspod-ironrdp-native".into(),
        client_dir: String::new(),
        platform: MajorPlatformType::MACINTOSH,
        enable_server_pointer: true,
        request_data: None,
        autologon: true,
        enable_audio_playback: false,
        compression_type: None,
        pointer_software_rendering: false,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 100,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

struct NoNetwork;
impl NetworkClient for NoNetwork {
    async fn send(
        &mut self,
        _: &connector::sspi::generator::NetworkRequest,
    ) -> connector::ConnectorResult<Vec<u8>> {
        Err(connector::general_err!(
            "External authentication networking is disabled"
        ))
    }
}

type Wire = TokioFramed<tokio_native_tls::TlsStream<TcpStream>>;

async fn run(
    endpoint: String,
    fingerprint: String,
    shared: Shared,
    mut input: mpsc::Receiver<(u32, u32, u32, u32)>,
) -> Result<()> {
    let tcp = TcpStream::connect(&endpoint).await.context("TCP connect")?;
    tcp.set_nodelay(true)?;
    let mut connector = connector::ClientConnector::new(config(), tcp.local_addr()?);
    connector.attach_static_channel(
        DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new()))),
    );
    let mut plain = TokioFramed::new(tcp);
    let upgrade = ironrdp_tokio::connect_begin(&mut plain, &mut connector).await?;
    // The disposable self-signed certificate is authenticated by its out-of-band
    // SHA-256 pin below, before any RDP session data is sent over TLS.
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
        .build()?;
    let tls = tokio_native_tls::TlsConnector::from(tls)
        .connect("localhost", plain.into_inner_no_leftover())
        .await?;
    let certificate = tls
        .get_ref()
        .peer_certificate()?
        .context("Missing TLS certificate")?
        .to_der()?;
    verify_pin(&certificate, &fingerprint)?;
    let upgraded = ironrdp_tokio::mark_as_upgraded(upgrade, &mut connector);
    let mut wire = TokioFramed::new(tls);
    let result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut wire,
        &mut NoNetwork,
        "localhost".into(),
        Vec::new(),
        None,
    )
    .await?;
    let activation = result.activation_factory;
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        result.desktop_size.width,
        result.desktop_size.height,
    );
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: true,
        pointer_software_rendering: false,
    }
    .build();
    shared.notify(1, "IRON_CONNECTED");
    let mut pending_resize = None;
    loop {
        let outputs = tokio::select! {
            incoming = wire.read_pdu() => {
                let (action, bytes) = incoming.context("RDP read")?;
                stage.process(&mut image, action, &bytes)?
            }
            command = input.recv() => {
                let Some((kind, a, b, c)) = command else { return Ok(()) };
                if kind == 2 { pending_resize = Some((a,b)); Vec::new() }
                else {
                    let event = input_event(kind, a, b, c)?;
                    stage.process_fastpath_input(&mut image, &[event])?
                }
            }
        };
        if process_outputs(outputs, &mut wire, &shared, &image).await? {
            let mut sequence = activation.create();
            let mut buffer = WriteBuf::new();
            while !sequence.state().is_terminal() {
                ironrdp_tokio::single_sequence_step(&mut wire, &mut sequence, &mut buffer).await?;
            }
            use connector::connection_activation::ConnectionActivationState;
            if let ConnectionActivationState::Finalized {
                desktop_size,
                share_id,
                ..
            } = sequence.connection_activation_state()
            {
                ensure!(
                    (200..=4096).contains(&desktop_size.width)
                        && (200..=4096).contains(&desktop_size.height),
                    "Invalid resize"
                );
                stage.set_share_id(share_id);
                image =
                    DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                shared.notify(
                    1,
                    &format!(
                        "IRON_RESIZED={}x{}",
                        desktop_size.width, desktop_size.height
                    ),
                );
            } else {
                bail!("Activation did not finalize");
            }
        }
        if let Some((width, height)) = pending_resize
            && let Some(encoded) = stage.encode_resize(width, height, Some(100), Some((300, 200)))
        {
            wire.write_all(&encoded?).await?;
            pending_resize = None;
        }
    }
}

async fn process_outputs(
    outputs: Vec<ActiveStageOutput>,
    wire: &mut Wire,
    shared: &Shared,
    image: &DecodedImage,
) -> Result<bool> {
    let mut reactivation = false;
    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(frame) => {
                if !frame.is_empty() {
                    wire.write_all(&frame).await?;
                }
            }
            ActiveStageOutput::GraphicsUpdate(rect) => shared.publish(image, rect)?,
            ActiveStageOutput::PointerDefault => shared.cursor(CursorState::Default),
            ActiveStageOutput::PointerHidden => shared.cursor(CursorState::Hidden),
            ActiveStageOutput::PointerBitmap(pointer) => {
                shared.cursor(CursorState::bitmap(pointer)?);
            }
            // Remote position hints must not warp the user's host pointer.
            ActiveStageOutput::PointerPosition { .. } => {}
            ActiveStageOutput::DeactivateAll => reactivation = true,
            ActiveStageOutput::Terminate(reason) => bail!("RDP session ended: {reason}"),
            ActiveStageOutput::MultitransportRequest(_) => {
                bail!("Unexpected multitransport request")
            }
            _ => {}
        }
    }
    Ok(reactivation)
}

fn parse_pin(text: &str) -> Result<Vec<u8>> {
    let bytes = text
        .split(':')
        .map(|part| {
            ensure!(part.len() == 2, "Invalid TLS pin component");
            Ok(u8::from_str_radix(part, 16)?)
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(bytes.len() == 32, "Invalid TLS pin length");
    Ok(bytes)
}

fn verify_pin(certificate: &[u8], fingerprint: &str) -> Result<()> {
    let expected = parse_pin(fingerprint)?;
    ensure!(
        Sha256::digest(certificate).as_slice() == expected,
        "TLS certificate fingerprint mismatch"
    );
    Ok(())
}

fn input_event(kind: u32, a: u32, b: u32, c: u32) -> Result<FastPathInputEvent> {
    match kind {
        0 => {
            ensure!(a & !0x8100 == 0 && b <= 127, "Invalid scancode input");
            let mut flags = KeyboardFlags::empty();
            if a & 0x8000 != 0 {
                flags |= KeyboardFlags::RELEASE;
            }
            if a & 0x100 != 0 {
                flags |= KeyboardFlags::EXTENDED;
            }
            Ok(FastPathInputEvent::KeyboardEvent(flags, b as u8))
        }
        1 => {
            ensure!(a <= 65535 && b < 4096 && c < 4096, "Invalid pointer input");
            Ok(FastPathInputEvent::MouseEvent(MousePdu {
                flags: PointerFlags::from_bits_retain((a & !0x1ff) as u16),
                number_of_wheel_rotation_units: if a & 0x100 != 0 {
                    ((a & 0x1ff) as i16) - 512
                } else {
                    (a & 0xff) as i16
                },
                x_position: b as u16,
                y_position: c as u16,
            }))
        }
        _ => bail!("Invalid input kind"),
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// Strings must be NUL-terminated. Callback/context must remain valid until
/// `iron_stop` returns; notifications run on the worker thread and must not unwind.
pub unsafe extern "C" fn iron_start(
    endpoint: *const c_char,
    fingerprint: *const c_char,
    notify: Notify,
    context: *mut c_void,
) -> *mut c_void {
    let endpoint = unsafe { CStr::from_ptr(endpoint) }
        .to_string_lossy()
        .into_owned();
    let fingerprint = unsafe { CStr::from_ptr(fingerprint) }
        .to_string_lossy()
        .into_owned();
    let shared = Shared {
        mailbox: Arc::new(Mutex::new(Mailbox::default())),
        cursor: Arc::new(Mutex::new(Some(CursorState::Default))),
        notify,
        context: context as usize,
    };
    let (tx, rx) = mpsc::channel(256);
    let (stop_tx, stop_rx) = oneshot::channel();
    let worker_shared = shared.clone();
    let worker = std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async {
                tokio::select! {
                    result = run(endpoint, fingerprint, worker_shared.clone(), rx) => result,
                    _ = stop_rx => Ok(()),
                }
            })
        })();
        if let Err(error) = result {
            worker_shared.notify(2, &format!("{error:#}"));
        }
    });
    Box::into_raw(Box::new(Handle {
        shared,
        input: tx,
        stop: Some(stop_tx),
        worker: Some(worker),
    }))
    .cast()
}

#[unsafe(no_mangle)]
/// # Safety
/// Use a live handle from `iron_start`, on its owning UI thread, before stopping.
pub unsafe extern "C" fn iron_input(
    handle: *mut c_void,
    kind: u32,
    a: u32,
    b: u32,
    c: u32,
) -> bool {
    let handle = unsafe { &*handle.cast::<Handle>() };
    if kind == 2 && !(200..=4096).contains(&a) {
        return false;
    }
    if kind == 2 && (!a.is_multiple_of(2) || !(200..=4096).contains(&b)) {
        return false;
    }
    if kind != 2 && input_event(kind, a, b, c).is_err() {
        return false;
    }
    handle.input.try_send((kind, a, b, c)).is_ok()
}

#[unsafe(no_mangle)]
/// # Safety
/// Handle must be live. The synchronous callback must not reenter this bridge,
/// unwind, or retain the pixel pointer after returning.
pub unsafe extern "C" fn iron_frame(
    handle: *mut c_void,
    callback: Frame,
    context: *mut c_void,
) -> bool {
    let handle = unsafe { &*handle.cast::<Handle>() };
    let mut mailbox = handle.shared.mailbox.lock().expect("frame mutex poisoned");
    let Some(rect) = mailbox.dirty.take() else {
        return false;
    };
    callback(
        context,
        mailbox.pixels.as_ptr(),
        mailbox.width as u32,
        mailbox.height as u32,
        rect.x as u32,
        rect.y as u32,
        rect.width as u32,
        rect.height as u32,
        mailbox.generation,
        mailbox
            .updated
            .expect("dirty frame timestamp")
            .elapsed()
            .as_secs_f64()
            * 1000.,
    );
    true
}

#[unsafe(no_mangle)]
/// # Safety
/// Handle must be live. The synchronous callback must not reenter this bridge,
/// unwind, or retain the bitmap pointer after returning.
pub unsafe extern "C" fn iron_cursor(
    handle: *mut c_void,
    callback: Cursor,
    context: *mut c_void,
) -> bool {
    let handle = unsafe { &*handle.cast::<Handle>() };
    let cursor = handle
        .shared
        .cursor
        .lock()
        .expect("cursor mutex poisoned")
        .take();
    let Some(cursor) = cursor else { return false };
    cursor.deliver(callback, context);
    true
}

#[unsafe(no_mangle)]
/// # Safety
/// Stop a live handle exactly once, on its owning thread, outside any callback.
pub unsafe extern "C" fn iron_stop(handle: *mut c_void) {
    let mut handle = unsafe { Box::from_raw(handle.cast::<Handle>()) };
    if let Some(stop) = handle.stop.take() {
        let _ = stop.send(());
    }
    if let Some(worker) = handle.worker.take() {
        worker.join().expect("IronRDP worker panicked");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_dimensions_hotspots_and_bytes_are_validated() {
        let pointer = |width, height, hotspot_x, hotspot_y, bytes| {
            Arc::new(DecodedPointer {
                width,
                height,
                hotspot_x,
                hotspot_y,
                bitmap_data: vec![255; bytes],
            })
        };
        assert!(matches!(
            CursorState::bitmap(pointer(2, 3, 1, 2, 24)).unwrap(),
            CursorState::Bitmap(_)
        ));
        assert!(matches!(
            CursorState::bitmap(pointer(0, 0, 0, 0, 0)).unwrap(),
            CursorState::Hidden
        ));
        assert!(CursorState::bitmap(pointer(385, 1, 0, 0, 1540)).is_err());
        assert!(CursorState::bitmap(pointer(2, 3, 2, 0, 24)).is_err());
        assert!(CursorState::bitmap(pointer(2, 3, 0, 3, 24)).is_err());
        assert!(CursorState::bitmap(pointer(2, 3, 0, 0, 23)).is_err());
        assert!(CursorState::bitmap(pointer(0, 3, 0, 0, 0)).is_err());
    }

    #[test]
    fn latest_frame_keeps_all_unpresented_dirty_regions() {
        let mut mailbox = Mailbox::default();
        let mut data = vec![0; 8 * 8 * 4];
        mailbox
            .update(
                &data,
                8,
                8,
                Rect {
                    x: 0,
                    y: 0,
                    width: 8,
                    height: 8,
                },
            )
            .unwrap();
        mailbox.dirty.take();
        data[4..8].fill(42);
        mailbox
            .update(
                &data,
                8,
                8,
                Rect {
                    x: 1,
                    y: 0,
                    width: 1,
                    height: 1,
                },
            )
            .unwrap();
        data[7 * 8 * 4..7 * 8 * 4 + 4].fill(99);
        mailbox
            .update(
                &data,
                8,
                8,
                Rect {
                    x: 0,
                    y: 7,
                    width: 1,
                    height: 1,
                },
            )
            .unwrap();
        assert_eq!(
            mailbox.dirty,
            Some(Rect {
                x: 0,
                y: 0,
                width: 2,
                height: 8
            })
        );
        assert_eq!(mailbox.pixels, data);
        assert_eq!(mailbox.generation, 3);
    }

    #[test]
    fn resizing_replaces_pixels_and_invalid_rectangles_fail() {
        let mut mailbox = Mailbox::default();
        mailbox
            .update(
                &vec![1; 64],
                4,
                4,
                Rect {
                    x: 0,
                    y: 0,
                    width: 4,
                    height: 4,
                },
            )
            .unwrap();
        mailbox
            .update(
                &vec![2; 16],
                2,
                2,
                Rect {
                    x: 1,
                    y: 1,
                    width: 1,
                    height: 1,
                },
            )
            .unwrap();
        assert_eq!(mailbox.pixels, vec![2; 16]);
        assert_eq!(
            mailbox.dirty,
            Some(Rect {
                x: 0,
                y: 0,
                width: 2,
                height: 2
            })
        );
        assert!(
            mailbox
                .update(
                    &[0; 16],
                    2,
                    2,
                    Rect {
                        x: 2,
                        y: 0,
                        width: 1,
                        height: 1
                    }
                )
                .is_err()
        );
        assert!(input_event(0, 0, 128, 0).is_err());
        assert!(input_event(1, 0, 4096, 0).is_err());
        assert!(parse_pin("AA:BB").is_err());
    }

    #[test]
    fn server_pin_mismatch_and_invalid_keyboard_flags_fail() {
        let certificate = b"disposable test certificate";
        let pin = Sha256::digest(certificate)
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        verify_pin(certificate, &pin).unwrap();
        assert!(verify_pin(b"different server", &pin).is_err());
        assert!(input_event(0, 0x200, 1, 0).is_err());
        match input_event(1, 0x0200 | (512 - 120), 0, 0).unwrap() {
            FastPathInputEvent::MouseEvent(event) => {
                assert_eq!(event.number_of_wheel_rotation_units, -120);
                assert_eq!(event.flags.bits(), 0x0200);
            }
            _ => panic!("Expected mouse wheel"),
        }
    }
}
