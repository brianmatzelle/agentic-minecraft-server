# garviscam — headless Minecraft client sidecar: the stadium "camera operator".
# Runs the actual modded client (NeoForge + the starting.cc pack) under Xvfb with
# Mesa/llvmpipe software GL, joins the server over the compose network as the
# whitelisted GarvisCam account, and ffmpeg-captures its view for stadiumcast
# (sanjuuni) to encode for the in-game jumbotron.
# Idles by default; install/login/launch steps are driven via `docker exec`
# (see scripts/ in this directory).
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jre \
    xvfb x11-utils \
    libgl1 libgl1-mesa-dri libglx-mesa0 libegl-mesa0 \
    libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxinerama1 \
    libxxf86vm1 libxrender1 libxtst6 libopenal1 \
    xdotool \
    ffmpeg \
    python3 python3-venv \
    curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/pmc && /opt/pmc/bin/pip install --no-cache-dir portablemc \
 && ln -s /opt/pmc/bin/portablemc /usr/local/bin/portablemc

# /data — persistent named volume: portablemc main dir (game files) + work dir
# (the .minecraft: mods, config, auth credentials). /pack — the client modpack
# (apps/client) mounted read-only.
ENV PMC_MAIN=/data/main PMC_WORK=/data/work DISPLAY=:99
WORKDIR /data
COPY scripts/ /opt/garviscam/
RUN chmod +x /opt/garviscam/*.sh

ENTRYPOINT ["/opt/garviscam/entrypoint.sh"]
