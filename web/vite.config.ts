import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` matches the gh-pages project path. Override locally with `VITE_BASE=/`
// for `npm run dev` if you want assets at the root.
const base = process.env.VITE_BASE ?? "/instcombine-instrumentor/";

// Fallback manifest URL used when the same-origin `wasm/manifest.json` is
// missing (e.g. `npm run dev` without running the manifest builder, or a
// Pages deploy whose manifest fetch failed). Points at the live wasm-pkgs
// branch in this repo. Override via env to point at a fork or branch.
const remoteManifestUrl =
  process.env.VITE_REMOTE_MANIFEST_URL ??
  "https://raw.githubusercontent.com/xuhongxu96/instcombine-instrumentor/wasm-pkgs/manifest.json";

export default defineConfig({
  base,
  plugins: [react()],
  worker: {
    format: "es",
  },
  // The emscripten loader expects to be served as a sibling of its .wasm.
  // public/wasm/ contains both; Vite copies it through verbatim.
  publicDir: "public",
  build: {
    target: "es2022",
    sourcemap: false,
  },
  server: {
    fs: {
      // allow worker to reach /public/wasm from the dev server
      strict: false,
    },
  },
  define: {
    "import.meta.env.VITE_REMOTE_MANIFEST_URL": JSON.stringify(remoteManifestUrl),
  },
});
