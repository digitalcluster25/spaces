import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

const revision = process.env.SPACES_GIT_REVISION || execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();

export default defineConfig({
  plugins: [react()],
  define: { __APP_REVISION__: JSON.stringify(revision) },
  preview: {
    proxy: {
      "/api/data": {
        target: "http://127.0.0.1:4300",
        rewrite: (path) => path.replace(/^\/api\/data/, ""),
      },
    },
  },
});
