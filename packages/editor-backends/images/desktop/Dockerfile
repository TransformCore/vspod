FROM node:22.22.3-bookworm-slim AS node
FROM vspod-app-runner:dev
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN apt-get update && apt-get install -y --no-install-recommends curl git libxkbfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && mkdir -p /opt/vscode /opt/vspod /vspod/extensions /vspod/settings /vspod/state /vspod/config \
    && chown -R 1000:1000 /vspod
RUN case "$(uname -m)" in x86_64) platform=linux-x64 ;; aarch64) platform=linux-arm64 ;; *) exit 1 ;; esac \
    && curl --fail --location --silent --show-error --max-time 180 \
       "https://update.code.visualstudio.com/1.106.3/$platform/stable" -o /tmp/code.tar.gz \
    && tar -xzf /tmp/code.tar.gz --strip-components=1 -C /opt/vscode \
    && rm /tmp/code.tar.gz \
    && ln -s /opt/vscode/bin/code /usr/local/bin/code
COPY packages/editor-backends/images/code-server/apply-configuration.mjs /opt/vspod/
COPY packages/editor-backends/images/desktop/*.mjs /opt/vspod/
RUN node /opt/vspod/patch-editor.mjs
USER 1000:1000
ENV HOME=/vspod/state/home
ENV XDG_RUNTIME_DIR=/tmp/runtime WAYLAND_DISPLAY=wayland-1
WORKDIR /workspace
ENTRYPOINT []
