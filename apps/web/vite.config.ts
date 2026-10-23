import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Ports are overridable so the end-to-end stack can run next to a normal dev stack.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = process.env.API_PORT ?? "3001";
const collabPort = process.env.COLLAB_PORT ?? "3002";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "codesh",
        short_name: "codesh",
        description: "Real-time code sharing on your intranet",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0a0c11",
        theme_color: "#0a0c11",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // App shell, every route chunk and every lazily loaded language pack. Fonts are cached on
        // first use instead: the Hangul subsets alone are several hundred small files.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/collab/, /^\/healthz/, /^\/metrics/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith(".woff2"),
            handler: "CacheFirst",
            options: {
              cacheName: "codesh-fonts",
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      "/collab": { target: `ws://localhost:${collabPort}`, ws: true },
    },
  },
  preview: { port: webPort, strictPort: true },
  build: { target: "es2023" },
});
