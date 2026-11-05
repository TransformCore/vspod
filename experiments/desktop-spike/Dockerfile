FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils xvfb openbox x11-utils dbus-x11 \
    libasound2 libatk-bridge2.0-0 libdrm2 libgbm1 libgtk-3-0 libnss3 \
    libxshmfence1 libxss1 fonts-dejavu-core util-linux procps \
    tigervnc-standalone-server tigervnc-tools novnc websockify nginx-light \
    wmctrl x11-xserver-utils xclip xdotool python3-xlib \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home desktop
COPY probe.sh /opt/spike/probe.sh
COPY display.sh /opt/spike/display.sh
COPY clipboard-agent.py /opt/spike/clipboard-agent.py
COPY xdnd.py /opt/spike/xdnd.py
USER 1000:1000
ENV HOME=/tmp/home DISPLAY=:99
WORKDIR /tmp
ENTRYPOINT ["/bin/bash", "/opt/spike/probe.sh"]
