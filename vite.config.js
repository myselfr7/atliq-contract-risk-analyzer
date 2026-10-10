import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local dev: `vercel dev` serves the api/ functions. Plain `vite` does not.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
