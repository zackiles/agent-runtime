import { defineConfig } from "vite";
import type { Plugin } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { mockApi } from "./dev/mock";
import { singleton } from "./dev/singleton";
import process from "node:process";

function spaFallback(): Plugin {
  return {
    name: "ar-spa-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || "";
        if (
          url.startsWith("/web/") &&
          !url.startsWith("/web/static/") &&
          !url.includes(".")
        ) {
          req.url = "/web/static/index.html";
        }
        next();
      });
    },
  };
}

export default defineConfig(() => ({
  plugins: [
    spaFallback(),
    singleton(),
    preact(),
    tailwindcss(),
    ...(process.env.VITE_MOCK === "true" ? [mockApi()] : []),
  ],
  base: "/web/static/",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "index.html",
      output: {
        entryFileNames: "entry.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  server: {
    open: "/web/registry",
    proxy: process.env.VITE_MOCK === "true" ? undefined : {
      "/system": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/agents": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/audit": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/copy": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/api": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/tools": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/skills": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/rules": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/runtime": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/secrets": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/telemetry": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/configs": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/demos": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/access": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/storage": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
      "/webhook": {
        target: process.env.AR_CP_URL || "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
}));
