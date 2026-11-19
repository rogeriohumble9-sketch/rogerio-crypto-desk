import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

export default defineConfig({
  root: path.resolve("web"),
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss({ config: path.resolve("tailwind.config.js") }), autoprefixer()],
    },
  },
  build: {
    outDir: path.resolve("dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [path.resolve(".")] },
  },
});
