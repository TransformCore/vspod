FROM vspod-app-runner:dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-gi gir1.2-gtk-3.0 \
    && rm -rf /var/lib/apt/lists/*
COPY tests/notes.py /opt/notes.py
USER 1000:1000
