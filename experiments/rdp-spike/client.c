#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/disp.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/channels/channels.h>
#include <freerdp/addin.h>
#include <freerdp/input.h>
#include <winpr/synch.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static DispClientContext* display_channel;
static const char* output;
static unsigned long frames;
static BYTE clipboard_data[8 * 1024 * 1024];
static size_t clipboard_size;
static BOOL clipboard_received;
static UINT32 clipboard_format = 13;
static BOOL interactive;
static BOOL quit_requested;
static unsigned pending_width, pending_height;

static BOOL input_command(rdpContext* context, const char* line)
{
    unsigned a, b, c;
    char extra;
    if (strcmp(line, "Q") == 0) { quit_requested = TRUE; return TRUE; }
    if (sscanf(line, "M %u %u %u %c", &a, &b, &c, &extra) == 3 &&
        a <= 65535 && b < 4096 && c < 4096)
        return freerdp_input_send_mouse_event(context->input, a, b, c);
    if (sscanf(line, "K %u %u %c", &a, &b, &extra) == 2 && a <= 65535 && b <= 127)
        return freerdp_input_send_keyboard_event(context->input, a, b);
    if (sscanf(line, "R %u %u %c", &a, &b, &extra) == 2 &&
        a >= 200 && a <= 4096 && !(a % 2) && b >= 200 && b <= 4096)
    {
        pending_width = a;
        pending_height = b;
        return TRUE;
    }
    fprintf(stderr, "Invalid native input command: %s\n", line);
    return FALSE;
}

static BOOL read_input(rdpContext* context)
{
    static char line[128];
    static size_t length;
    char buffer[4096];
    ssize_t count;
    while ((count = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0)
    {
        for (ssize_t i = 0; i < count; i++)
        {
            if (buffer[i] == '\n')
            {
                line[length] = 0;
                if (!input_command(context, line)) return FALSE;
                length = 0;
            }
            else
            {
                if (length >= sizeof(line) - 1) return FALSE;
                line[length++] = buffer[i];
            }
        }
    }
    if (count == 0) quit_requested = TRUE;
    if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK) { perror("Native input"); return FALSE; }
    return TRUE;
}

static UINT clipboard_ready(CliprdrClientContext* context, const CLIPRDR_MONITOR_READY* event)
{
    (void)event;
    CLIPRDR_GENERAL_CAPABILITY_SET general = {CB_CAPSTYPE_GENERAL, CB_CAPSTYPE_GENERAL_LEN,
                                            CB_CAPS_VERSION_2, CB_USE_LONG_FORMAT_NAMES};
    CLIPRDR_CAPABILITIES capabilities = {0};
    capabilities.cCapabilitiesSets = 1;
    capabilities.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
    UINT error = context->ClientCapabilities(context, &capabilities);
    if (error) return error;
    CLIPRDR_FORMAT format = {clipboard_format, NULL};
    CLIPRDR_FORMAT_LIST list = {0};
    list.numFormats = 1;
    list.formats = &format;
    fprintf(stderr, "RDP_CLIPBOARD_READY\n");
    return context->ClientFormatList(context, &list);
}

static UINT clipboard_request(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_REQUEST* request)
{
    fprintf(stderr, "RDP_CLIPBOARD_REQUEST=%u bytes=%zu\n", request->requestedFormatId, clipboard_size);
    CLIPRDR_FORMAT_DATA_RESPONSE response = {0};
    response.common.msgFlags = request->requestedFormatId == clipboard_format ? CB_RESPONSE_OK : CB_RESPONSE_FAIL;
    if (response.common.msgFlags == CB_RESPONSE_OK)
    {
        response.common.dataLen = (UINT32)clipboard_size;
        response.requestedFormatData = clipboard_data;
    }
    return context->ClientFormatDataResponse(context, &response);
}

static UINT clipboard_formats(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST* list)
{
    CLIPRDR_FORMAT_LIST_RESPONSE response = {0};
    response.common.msgFlags = CB_RESPONSE_OK;
    UINT error = context->ClientFormatListResponse(context, &response);
    if (error) return error;
    for (UINT32 i = 0; i < list->numFormats; i++)
    {
        if (list->formats[i].formatId != clipboard_format) continue;
        CLIPRDR_FORMAT_DATA_REQUEST request = {0};
        request.requestedFormatId = clipboard_format;
        return context->ClientFormatDataRequest(context, &request);
    }
    return 0;
}

static UINT clipboard_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_RESPONSE* response)
{
    (void)context;
    if (!(response->common.msgFlags & CB_RESPONSE_OK) ||
        response->common.dataLen > sizeof(clipboard_data) || response->common.dataLen < 2 ||
        (clipboard_format == 13 && response->common.dataLen % 2)) return 1;
    char path[4096];
    if (snprintf(path, sizeof(path), "%s.clipboard-out", output) >= sizeof(path)) return 1;
    FILE* file = fopen(path, "wb");
    if (!file) return 1;
    BOOL ok = fwrite(response->requestedFormatData, 1, response->common.dataLen, file) == response->common.dataLen;
    if (fclose(file)) ok = FALSE;
    clipboard_received = ok;
    fprintf(stderr, "RDP_CLIPBOARD_RECEIVED=%u\n", response->common.dataLen);
    return ok ? 0 : 1;
}

static BOOL begin_paint(rdpContext* context)
{
    context->gdi->primary->hdc->hwnd->invalid->null = TRUE;
    return TRUE;
}

static BOOL end_paint(rdpContext* context)
{
    rdpGdi* gdi = context->gdi;
    if (gdi->primary->hdc->hwnd->invalid->null) return TRUE;
    frames++;
    char temporary[4096];
    if (snprintf(temporary, sizeof(temporary), "%s.tmp", output) >= sizeof(temporary)) return FALSE;
    FILE* file = fopen(temporary, "wb");
    if (!file) return FALSE;
    BYTE* rgb = malloc(gdi->width * 3);
    if (!rgb) { fclose(file); return FALSE; }
    BOOL ok = fprintf(file, "P6\n%d %d\n255\n", gdi->width, gdi->height) > 0;
    for (UINT32 y = 0; ok && y < gdi->height; y++)
    {
        const BYTE* row = gdi->primary_buffer + y * gdi->stride;
        for (UINT32 x = 0; x < gdi->width; x++)
        {
            rgb[x * 3] = row[x * 4 + 2];
            rgb[x * 3 + 1] = row[x * 4 + 1];
            rgb[x * 3 + 2] = row[x * 4];
        }
        ok = fwrite(rgb, 3, gdi->width, file) == gdi->width;
    }
    free(rgb);
    if (fclose(file) != 0) ok = FALSE;
    if (!ok || rename(temporary, output) != 0) return FALSE;
    return TRUE;
}

static BOOL resize(rdpContext* context)
{
    UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    UINT32 height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    fprintf(stderr, "RDP_FRAMEBUFFER=%ux%u\n", width, height);
    return gdi_resize(context->gdi, width, height);
}

static void connected(void* context, const ChannelConnectedEventArgs* event)
{
    (void)context;
    if (strcmp(event->name, DISP_DVC_CHANNEL_NAME) == 0)
        display_channel = (DispClientContext*)event->pInterface;
    if (strcmp(event->name, CLIPRDR_SVC_CHANNEL_NAME) == 0)
    {
        CliprdrClientContext* clipboard = event->pInterface;
        clipboard->custom = context;
        clipboard->MonitorReady = clipboard_ready;
        clipboard->ServerFormatList = clipboard_formats;
        clipboard->ServerFormatDataRequest = clipboard_request;
        clipboard->ServerFormatDataResponse = clipboard_response;
    }
}

static BOOL pre_connect(freerdp* instance)
{
    fprintf(stderr, "RDP_PRECONNECT\n");
    PubSub_SubscribeChannelConnected(instance->context->pubSub, connected);
    return TRUE;
}

static BOOL post_connect(freerdp* instance)
{
    if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) return FALSE;
    instance->context->update->BeginPaint = begin_paint;
    instance->context->update->EndPaint = end_paint;
    instance->context->update->DesktopResize = resize;
    fprintf(stderr, "RDP_CONNECTED\n");
    return TRUE;
}

int main(int argc, char** argv)
{
    setbuf(stdout, NULL);
    if (argc != 5) { fprintf(stderr, "Usage: client host:port fingerprint output.ppm seconds\n"); return 2; }
    output = argv[3];
    interactive = getenv("VSPOD_RDP_INTERACTIVE") != NULL;
    const char* mode = getenv("VSPOD_RDP_CLIPBOARD");
    if (mode && strcmp(mode, "dib") == 0) clipboard_format = 8;
    char clipboard_path[4096];
    if (snprintf(clipboard_path, sizeof(clipboard_path), "%s.clipboard-in", output) >= sizeof(clipboard_path)) return 2;
    if (!interactive)
    {
        FILE* clipboard = fopen(clipboard_path, "rb");
        if (!clipboard) { perror("Clipboard fixture"); return 2; }
        clipboard_size = fread(clipboard_data, 1, sizeof(clipboard_data), clipboard);
        BOOL valid_clipboard = !ferror(clipboard) && feof(clipboard) && clipboard_size >= 2 &&
                              (clipboard_format != 13 || clipboard_size % 2 == 0);
        fclose(clipboard);
        if (!valid_clipboard) { fprintf(stderr, "Invalid clipboard fixture\n"); return 2; }
    }
    freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0);
    freerdp* instance = freerdp_new();
    if (!instance) return 3;
    instance->ContextSize = sizeof(rdpContext);
    instance->PreConnect = pre_connect;
    instance->PostConnect = post_connect;
    instance->LoadChannels = freerdp_client_load_channels;
    if (!freerdp_context_new(instance)) return 4;
    char server[256], certificate[256];
    snprintf(server, sizeof(server), "/v:%s", argv[1]);
    snprintf(certificate, sizeof(certificate), "/cert:fingerprint:sha256:%s", argv[2]);
    const char* values[] = {"rdp-spike", server, certificate, "/u:spike", "/sec:tls",
                         "/size:1100x750", "/dynamic-resolution", "/log-level:WARN"};
    char* arguments[8];
    for (unsigned i = 0; i < 8; i++) arguments[i] = strdup(values[i]);
    int status = freerdp_client_settings_parse_command_line(instance->context->settings, 8, arguments, FALSE);
    for (unsigned i = 0; i < 8; i++) free(arguments[i]);
    freerdp_settings_set_string(instance->context->settings, FreeRDP_Password, "unused");
    freerdp_settings_set_bool(instance->context->settings, FreeRDP_SupportDisplayControl, TRUE);
    freerdp_settings_set_bool(instance->context->settings, FreeRDP_SupportDynamicChannels, TRUE);
    freerdp_settings_set_bool(instance->context->settings, FreeRDP_RedirectClipboard, !interactive);
    freerdp_settings_set_bool(instance->context->settings, FreeRDP_SupportGraphicsPipeline, FALSE);
    if (interactive) freerdp_settings_set_uint32(instance->context->settings, FreeRDP_KeyboardLayout, 0x409);
    if (status != 0) { fprintf(stderr, "RDP configuration rejected: %d\n", status); return 5; }
    fprintf(stderr, "RDP_CONNECTING\n");
    if (!freerdp_connect(instance)) { fprintf(stderr, "RDP connection failed\n"); return 6; }
    if (interactive && fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) < 0) { perror("Native input"); return 7; }
    time_t start = time(NULL);
    unsigned stage = 0;
    BOOL ok = TRUE;
    while (ok && !quit_requested && (interactive || time(NULL) - start < atoi(argv[4])) &&
           !freerdp_shall_disconnect_context(instance->context))
    {
        HANDLE events[64];
        DWORD count = freerdp_get_event_handles(instance->context, events, 64);
        if (!count || WaitForMultipleObjects(count, events, FALSE, interactive ? 4 : 100) == WAIT_FAILED) { ok = FALSE; break; }
        ok = freerdp_check_event_handles(instance->context);
        if (interactive && ok && freerdp_is_active_state(instance->context)) ok = read_input(instance->context);
        if (interactive && display_channel && pending_width && freerdp_is_active_state(instance->context))
        {
            DISPLAY_CONTROL_MONITOR_LAYOUT layout = {0};
            layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
            layout.Width = pending_width;
            layout.Height = pending_height;
            layout.PhysicalWidth = 300;
            layout.PhysicalHeight = 200;
            layout.DesktopScaleFactor = 100;
            layout.DeviceScaleFactor = 100;
            UINT error = display_channel->SendMonitorLayout(display_channel, 1, &layout);
            fprintf(stderr, "RDP_LIVE_RESIZE=%ux%u status=%u\n", pending_width, pending_height, error);
            pending_width = 0;
            if (error) ok = FALSE;
        }
        time_t elapsed = time(NULL) - start;
        if (!interactive && display_channel && ((stage == 0 && elapsed >= 8) || (stage == 1 && elapsed >= 16)))
        {
            DISPLAY_CONTROL_MONITOR_LAYOUT layout = {0};
            layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
            layout.Width = stage == 0 ? 900 : 1200;
            layout.Height = stage == 0 ? 600 : 800;
            layout.PhysicalWidth = 300;
            layout.PhysicalHeight = 200;
            layout.DesktopScaleFactor = 100;
            layout.DeviceScaleFactor = 100;
            UINT error = display_channel->SendMonitorLayout(display_channel, 1, &layout);
            fprintf(stderr, "RDP_RESIZE_REQUEST=%ux%u status=%u\n", layout.Width, layout.Height, error);
            if (error) ok = FALSE;
            stage++;
        }
    }
    fprintf(stderr, "RDP_FRAMES=%lu RESIZE_REQUESTS=%u\n", frames, stage);
    freerdp_disconnect(instance);
    gdi_free(instance);
    freerdp_context_free(instance);
    freerdp_free(instance);
    return ok && frames > 0 && (interactive ? quit_requested : stage == 2 && clipboard_received) ? 0 : 7;
}
