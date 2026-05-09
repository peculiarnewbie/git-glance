import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "Git Glance",
    identifier: "com.gitglance.app",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/index.tsx",
        external: ["solid-js"],
      },
    },
    copy: {
      "index.html": "views/mainview/index.html",
      "views/mainview/index.css": "views/mainview/index.css",
    },
    linux: {
      bundleCEF: true,
    },
  },
  scripts: {
    postBuild: "./scripts/post-build.ts",
  },
  release: {
    baseUrl: "https://releases.gitglance.dev/",
  },
} satisfies ElectrobunConfig
