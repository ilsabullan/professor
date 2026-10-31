import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // cloudflared 임시 터널(*.trycloudflare.com)로 공유할 때 접속을 허용한다
  server: { host: true, allowedHosts: [".trycloudflare.com"] },
});
