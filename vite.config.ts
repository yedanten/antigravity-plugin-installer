import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, 'ui'),
  plugins: [viteSingleFile()],
  build: {
    outDir: path.resolve(__dirname, 'assets'),
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: path.resolve(__dirname, 'ui/app.html'),
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
