import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.LEANSEAL_API ?? "http://127.0.0.1:4321";

export default defineConfig({
  output: "static",
  integrations: [react()],
  devToolbar: { enabled: false },
  vite: { plugins: [tailwindcss()], server: { proxy: { "/api": api, "/events": api } } }
});
