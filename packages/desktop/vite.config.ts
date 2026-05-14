import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [solid(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 8912,
    proxy: {
      "/ws": { target: "ws://localhost:3456", ws: true },
    },
  },
});
