FROM node:22.22.3-bookworm-slim AS node
FROM ghcr.io/coder/code-server:4.106.3

USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && mkdir -p /vspod/extensions /vspod/settings /vspod/state /vspod/config /opt/vspod \
    && chown -R 1000:1000 /vspod \
    && rm -f /etc/sudoers.d/nopasswd \
    && chmod u-s /usr/local/bin/fixuid \
    && node --version && npm --version && git --version
COPY --chown=1000:1000 bootstrap.mjs configure.mjs apply-configuration.mjs patch-editor.mjs extensions.yml /opt/vspod/
RUN node /opt/vspod/patch-editor.mjs
USER 1000:1000
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/opt/vspod/bootstrap.mjs"]