FROM vspod-app-runner:dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 \
    && rm -rf /var/lib/apt/lists/*
COPY server.sh /opt/wayland-capture/server.sh
USER 1000:1000
ENTRYPOINT ["/bin/bash", "/opt/wayland-capture/server.sh"]
