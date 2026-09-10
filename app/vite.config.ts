import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One route, no router: the demo surface is a single ledger page (Task 7).
// BASE_PATH is set only for the GitHub Pages build (project pages serve under
// /<repo>/); local dev and any root-domain host keep "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  server: { port: 5173 },
});
