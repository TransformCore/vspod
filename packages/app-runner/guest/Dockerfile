FROM rust:1-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends libxkbcommon-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY guest/compositor/Cargo.toml guest/compositor/Cargo.lock ./
COPY guest/compositor/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/vspod-compositor /vspod-compositor

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates dbus-x11 libxkbcommon0 xkb-data \
    libwayland-client0 libwayland-cursor0 libwayland-egl1 \
    libasound2t64 libatk-bridge2.0-0t64 libdrm2 libgbm1 libgtk-3-0t64 libnss3 \
    libxshmfence1 libxss1 fonts-dejavu-core procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home desktop
COPY --from=build /vspod-compositor /opt/app-runner/vspod-compositor
COPY guest/entrypoint.sh /opt/app-runner/entrypoint.sh
RUN printf '#!/bin/sh\nexec /opt/app-runner/vspod-compositor --open "$1"\n' > /usr/local/bin/xdg-open \
    && chmod 755 /usr/local/bin/xdg-open /opt/app-runner/entrypoint.sh
USER 1000:1000
ENV HOME=/tmp/home
WORKDIR /tmp
ENTRYPOINT ["/bin/bash", "/opt/app-runner/entrypoint.sh"]
