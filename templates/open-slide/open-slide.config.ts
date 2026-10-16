import type { OpenSlideConfig } from '@open-slide/core';

const openSlideConfig: OpenSlideConfig = {
  // The three content directories live on the volume; the workspace itself, its node_modules and
  // the pinned runtime stay in the image, where an image pull replaces them wholesale. Absolute
  // paths are resolved as given, and Vite's fs guard is told about each one.
  // A deck's bare imports resolve by walking up from the FILE, so entrypoint.sh links
  // /data/node_modules at the workspace's own tree. Without it every deck fails to transform.
  slidesDir: '/data/slides',
  themesDir: '/data/themes',
  assetsDir: '/data/assets',

  // The sign-in gate owns the routed port and reaches this over loopback.
  port: 5173,

  // The dev server sees the deployment's public hostname in `Host`, which Vite's own
  // DNS-rebinding guard refuses by default. Nothing but the gate can reach this port, and the gate
  // requires a sign-in first, so the guard has nothing left to protect.
  allowedHosts: true,
};

export default openSlideConfig;
