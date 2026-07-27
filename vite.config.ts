import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const DATA_DIR = resolve(__dirname, 'data');
const SAMPLE_EXTENSIONS = new Set(['.ply', '.stl', '.obj', '.dcm', '.dicom']);

/**
 * Serves the local ./data folder during development so the bundled example
 * models are one click away. Not registered for production builds.
 */
function sampleFiles(): Plugin {
  return {
    name: 'sample-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__samples', (_req, res) => {
        if (!existsSync(DATA_DIR)) {
          res.setHeader('Content-Type', 'application/json');
          res.end('[]');
          return;
        }
        const files = readdirSync(DATA_DIR)
          .filter((name) => SAMPLE_EXTENSIONS.has(extname(name).toLowerCase()))
          .map((name) => ({
            name,
            size: statSync(join(DATA_DIR, name)).size,
            url: `/__sample/${encodeURIComponent(name)}`,
          }));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(files));
      });

      server.middlewares.use('/__sample', (req, res) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0]);
        // Refuse anything that tries to escape the data directory.
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          res.statusCode = 400;
          res.end('Bad request');
          return;
        }
        const filePath = join(DATA_DIR, name);
        if (!existsSync(filePath) || !SAMPLE_EXTENSIONS.has(extname(name).toLowerCase())) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(filePath).size));
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sampleFiles()],
  server: { port: 5173 },
  worker: { format: 'es' },
});
