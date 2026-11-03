import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the browser talks only to Vite, which forwards /api to the
// dashboard API. Same origin as far as the browser is concerned, so no CORS, and
// Basic auth (if the API has a password) works without any extra setup.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8082" },
    },
  },
});
