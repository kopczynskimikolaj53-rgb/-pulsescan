import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'node:path';
export default defineConfig({
  plugins:[react(),cloudflare()],
  resolve:{alias:{'@appdeploy/client':path.resolve(process.cwd(),'src/lib/api.ts')}},
  build:{outDir:'dist',sourcemap:false}
});
