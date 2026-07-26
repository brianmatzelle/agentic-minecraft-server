# playclient — the modded client YOU actually play, rendered on the Spark's GPU.
#
# This is garviscam's sibling, with one decisive difference: garviscam renders
# into its own Xvfb on Mesa/llvmpipe (software GL, a few fps — fine for a camera
# feed). This one draws on the HOST's real X session (:1) through the
# proprietary NVIDIA driver, so it gets hardware GL:
#     OpenGL renderer string: NVIDIA GB10/PCIe
#     OpenGL version string:  4.6.0 NVIDIA 580.159.03
#     direct rendering: Yes
# ...verified from inside a container with NVIDIA_DRIVER_CAPABILITIES=all.
# Sunshine then captures :1 and streams it to Moonlight on the phone.
#
# Hence no Xvfb — we attach to a display we don't own.
#
# mesa-utils IS installed, which looks wrong but is not: it pulls in libglvnd's
# libGL.so.1 (the vendor-neutral dispatcher every GL app links against) and
# provides glxinfo, which launch.sh uses to ASSERT we got the GPU. glvnd picks
# the NVIDIA vendor library that the container toolkit injects at runtime in
# preference to Mesa — this is the exact package set the renderer string above
# was verified with, so don't "clean it up" by dropping it.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jre \
    x11-utils mesa-utils \
    libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxinerama1 \
    libxxf86vm1 libxrender1 libxtst6 libopenal1 \
    pulseaudio-utils \
    python3 python3-venv \
    curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/pmc && /opt/pmc/bin/pip install --no-cache-dir portablemc \
 && ln -s /opt/pmc/bin/portablemc /usr/local/bin/portablemc

# /data — persistent named volume: portablemc main dir (game files) + work dir
# (the .minecraft: mods, config, MSA credentials). /pack — the client modpack
# (apps/client) mounted read-only.
ENV PMC_MAIN=/data/main PMC_WORK=/data/work
WORKDIR /data
COPY scripts/ /opt/playclient/
RUN chmod +x /opt/playclient/*.sh

ENTRYPOINT ["/opt/playclient/entrypoint.sh"]
