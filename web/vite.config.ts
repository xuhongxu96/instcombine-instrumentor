import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` matches the gh-pages project path. Override locally with `VITE_BASE=/`
// for `npm run dev` if you want assets at the root.
const base = process.env.VITE_BASE ?? "/instcombine-instrumentor/";

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
});
