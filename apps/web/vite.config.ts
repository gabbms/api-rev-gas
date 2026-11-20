import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = "http://localhost:3333";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target, ws: true },
      "/conversations": target,
      "/health": target,
    },
  },
});
