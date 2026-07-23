# stadiumcast — sanjuuni encoder sidecar for the Pokémon-stadium jumbotron.
# Builds MCJack123/sanjuuni (video → ComputerCraft frames) and idles; the host
# starts encode/serve jobs with `docker exec` (test clips now, the live GarvisCam
# capture chain later). CC computers reach it at ws://stadiumcast:<port> over the
# internal compose network — same pattern as garvtunnel/prometheus.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config git ca-certificates \
    zlib1g-dev libpoco-dev \
    libavcodec-dev libavformat-dev libavfilter-dev libavdevice-dev \
    libswscale-dev libswresample-dev \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Pin after first good build if upstream churns.
ARG SANJUUNI_REF=master
RUN git clone --depth 1 --branch "$SANJUUNI_REF" https://github.com/MCJack123/sanjuuni /opt/sanjuuni \
 && cd /opt/sanjuuni && ./configure && make -j"$(nproc)" \
 && cp sanjuuni /usr/local/bin/sanjuuni

WORKDIR /media
COPY entrypoint.sh /opt/entrypoint.sh
COPY source.sh /opt/source.sh
RUN chmod +x /opt/entrypoint.sh /opt/source.sh
# CAST_AUTOSTART=1 (compose) runs the live sanjuuni loop; docker exec still
# works for ad-hoc jobs (test clips etc.).
ENTRYPOINT ["/opt/entrypoint.sh"]
