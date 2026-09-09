import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One route, no router: the demo surface is a single ledger page (Task 7).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
