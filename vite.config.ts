import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT) || 8787

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // Your Tailscale address (`npm run remote`). Vite refuses requests for
    // host names it does not know, which is what stops DNS rebinding; names
    // under .ts.net only resolve inside your own tailnet.
    allowedHosts: ['.ts.net'],
    // Opened from another device, the page cannot reach the bridge at
    // localhost — that would be the other device — so it comes through here,
    // on the page's own address. On this machine the page still talks to the
    // bridge directly and none of this is used.
    proxy: {
      '/bridge': {
        target: `http://127.0.0.1:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
        xfwd: true,
        rewrite: (path) => path.replace(/^\/bridge/, '') || '/',
      },
    },
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
