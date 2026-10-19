import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: {
    rollupOptions: {
      // reader.html is the PDF reader hosted inside the mobile app's WebView.
      input: { main: "index.html", reader: "reader.html" },
    },
  },
});
