import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: { host: "0.0.0.0", port: 5199, strictPort: true },
  preview: { host: "0.0.0.0", port: 5199, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
