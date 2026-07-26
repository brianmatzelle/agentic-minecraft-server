# Sunshine (game-stream host) — patched upstream arm64 image.
#
# WHY THIS FILE EXISTS: ghcr.io/lizardbyte/sunshine:latest is BROKEN on arm64.
# /usr/bin/sunshine is linked against libva.so.2, libva-drm.so.2 and
# libwayland-client.so.0, and the published image ships none of them, so the
# entrypoint dies instantly with:
#     error while loading shared libraries: libva.so.2: cannot open shared
#     object file
# (Upstream does warn that "the Docker images are not recommended for most
# users".) This adds just the missing runtime libs — nothing else.
#
# Some are hard-linked (the loader refuses to start without them), others are
# dlopen'd at runtime — libgbm/libXrandr only surfaced AFTER the first batch was
# fixed ("Couldn't init x11 libraries"). So rather than discover them one crash
# at a time, this installs the full runtime dependency set of the official
# Sunshine .deb for Ubuntu 22.04.
#
# libva/libvdpau are only here to satisfy the linker: we encode with NVENC. Same
# for libwayland-client — we capture X11. libcuda + the NVENC bits are injected
# at runtime by the NVIDIA container toolkit, not installed here.
FROM ghcr.io/lizardbyte/sunshine:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    libva2 libva-drm2 libvdpau1 \
    libwayland-client0 \
    libgbm1 libdrm2 \
    libx11-6 libxcb1 libxcb-shm0 libxfixes3 libxrandr2 libxtst6 \
    libevdev2 libpulse0 libopus0 libcap2 libnuma1 libcurl4 \
    libavahi-client3 libminiupnpc17 libnotify4 \
 && rm -rf /var/lib/apt/lists/*
