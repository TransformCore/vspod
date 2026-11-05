FROM vspod-experiment:rdp AS driver
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential autoconf automake libtool pkg-config nasm xserver-xorg-dev \
    libepoxy-dev libegl-dev libgbm-dev xutils-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --silent --show-error --max-time 120 \
      https://codeload.github.com/neutrinolabs/xorgxrdp/tar.gz/refs/tags/v0.10.2 -o driver.tar.gz \
    && echo '5ffe2d71190a7246e1f0940e3c1558ff92a0b4c385c9f1c68ac3f9e23b75314b  driver.tar.gz' | sha256sum -c - \
    && curl --fail --location --silent --show-error --max-time 120 \
      https://codeload.github.com/neutrinolabs/xrdp/tar.gz/refs/tags/v0.10.1 -o xrdp.tar.gz \
    && echo 'dd04ac7151316916799e6a527e8bbef3752f79dd7c252ccc84490ad1d70bd178  xrdp.tar.gz' | sha256sum -c - \
    && tar -xzf driver.tar.gz && tar -xzf xrdp.tar.gz
WORKDIR /build/xorgxrdp-0.10.2
# This release otherwise hard-caps capture at 25 FPS, regardless of client speed.
RUN test "$(grep -c '^#define MIN_MS_BETWEEN_FRAMES 40$' module/rdpClientCon.c)" = 1 \
    && sed -i 's/^#define MIN_MS_BETWEEN_FRAMES 40$/#define MIN_MS_BETWEEN_FRAMES 8/' module/rdpClientCon.c \
    && test "$(grep -c 'int scaled_delta;' xrdpmouse/rdpMouse.c)" = 1 \
    && test "$(grep -c 'scaled_delta = delta / SCALE_FACTOR == 0 ? delta > 0 ? 1 : -1 : delta / SCALE_FACTOR;' xrdpmouse/rdpMouse.c)" = 1 \
    && test "$(grep -c 'SetScrollValuator(device, [23], SCROLL_TYPE_.*, 10, 0);' xrdpmouse/rdpMouse.c)" = 2 \
    && sed -i 's/int scaled_delta;/double scaled_delta;/; s/scaled_delta = delta \/ SCALE_FACTOR == 0 ? delta > 0 ? 1 : -1 : delta \/ SCALE_FACTOR;/scaled_delta = (double) delta \/ SCALE_FACTOR;/; s/SCROLL_TYPE_VERTICAL, 10, 0/SCROLL_TYPE_VERTICAL, 12, 0/; s/SCROLL_TYPE_HORIZONTAL, 10, 0/SCROLL_TYPE_HORIZONTAL, 12, 0/' xrdpmouse/rdpMouse.c \
    && ./bootstrap \
    && ./configure --prefix=/usr --libdir=/usr/lib --enable-strict-locations \
         XRDP_CFLAGS=-I/build/xrdp-0.10.1/common \
    && make -j2 \
    && make install DESTDIR=/stage

FROM vspod-experiment:rdp
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-xlib \
    && rm -rf /var/lib/apt/lists/*
COPY --from=driver /stage/usr/lib/xorg/modules/ /usr/lib/xorg/modules/
ENV VSPOD_CAPTURE_INTERVAL_MS=8
ENV VSPOD_TERMINAL_SMOOTH_SCROLLING=1
USER 1000:1000
