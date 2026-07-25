// FFmpeg-server origin. In production the SPA is served by the server itself,
// so same-origin keeps LAN/VPN access working; the explicit localhost fallback
// exists only for the Vite dev server (:5173), which is a different origin.
export const API_BASE = import.meta.env.DEV
  ? 'http://localhost:3333'
  : window.location.origin;
