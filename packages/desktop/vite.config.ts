import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [solid(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 8912,
    allowedHosts: ["cachy"],
    proxy: {
      "/health": "http://localhost:3456",
      "/repos": "http://localhost:3456",
      "/scan": "http://localhost:3456",
      "/pull": "http://localhost:3456",
      "/push": "http://localhost:3456",
      "/config": "http://localhost:3456",
      "/commit-push": "http://localhost:3456",
      "/cancel-commit": "http://localhost:3456",
      "/cancel-scan": "http://localhost:3456",
      "/cancel-fetch": "http://localhost:3456",
      "/fetch": "http://localhost:3456",
      "/settings": "http://localhost:3456",
    },
  },
});
