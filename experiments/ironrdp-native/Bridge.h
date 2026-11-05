#include <stdbool.h>
#include <stdint.h>

typedef void (*IronNotify)(void *context, uint32_t kind, const char *message);
typedef void (*IronFrame)(void *context, const uint8_t *pixels, uint32_t width,
                         uint32_t height, uint32_t x, uint32_t y,
                         uint32_t dirty_width, uint32_t dirty_height,
                         uint64_t generation, double age_ms);
// kind: 0 = default, 1 = hidden, 2 = top-down straight-alpha RGBA bitmap.
// The bitmap is valid only during the callback.
typedef void (*IronCursor)(void *context, uint32_t kind, const uint8_t *pixels,
                          uint32_t width, uint32_t height,
                          uint32_t hotspot_x, uint32_t hotspot_y);

void *iron_start(const char *endpoint, const char *fingerprint, IronNotify notify, void *context);
bool iron_input(void *handle, uint32_t kind, uint32_t a, uint32_t b, uint32_t c);
bool iron_frame(void *handle, IronFrame callback, void *context);
bool iron_cursor(void *handle, IronCursor callback, void *context);
void iron_stop(void *handle);
