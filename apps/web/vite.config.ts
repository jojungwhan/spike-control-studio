import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH lets the same build be served from a subpath behind the reverse
// proxy (e.g. /spike) without rebuilding the app's routing assumptions.
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5190, strictPort: true, host: "127.0.0.1" },
  preview: { port: 4190, strictPort: true, host: "127.0.0.1" },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
});
