FROM vspod-experiment:rdp
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb python3-xlib \
    && rm -rf /var/lib/apt/lists/*
COPY server.sh agent.py /opt/window-capture/
USER 1000:1000
ENV HOME=/tmp/home DISPLAY=:11
ENTRYPOINT ["/bin/bash", "/opt/window-capture/server.sh"]
