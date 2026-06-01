import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const hasNonAsciiWorkspacePath = /[^\u0000-\u007f]/.test(process.cwd());
const windowsTempDir = process.env.TEMP || process.env.TMP;
const outDir = hasNonAsciiWorkspacePath && windowsTempDir
    ? path.join(windowsTempDir, 'vlos-v2x-dashboard-dist')
    : 'dist';
export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: 5173
    },
    build: {
        outDir,
        emptyOutDir: true
    }
});
