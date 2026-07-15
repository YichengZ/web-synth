import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "docs",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        prism: resolve(import.meta.dirname, "CrystalPrism.html"),
        kawaii: resolve(import.meta.dirname, "KawaiiSynth.html"),
        titan: resolve(import.meta.dirname, "TITAN_SUB.html"),
        convergence: resolve(import.meta.dirname, "Convergence.html"),
      },
    },
  },
});
