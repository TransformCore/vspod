FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xrdp xorgxrdp xserver-xorg-core openbox x11-utils \
    x11-xserver-utils wmctrl xdotool xclip scrot dbus-x11 openssl socat \
    libasound2t64 libatk-bridge2.0-0t64 libdrm2 libgbm1 libgtk-3-0t64 libnss3 \
    libxshmfence1 libxss1 fonts-dejavu-core procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home desktop \
    && mkdir -p /run/xrdp /var/log/xrdp \
    && chown 1000:1000 /run/xrdp /var/log/xrdp
COPY server.sh /opt/spike/server.sh
USER 1000:1000
ENV HOME=/tmp/home DISPLAY=:10
WORKDIR /tmp
ENTRYPOINT ["/bin/bash", "/opt/spike/server.sh"]
