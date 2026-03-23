import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import electron from 'vite-plugin-electron/simple';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    // Dynamically set the base path: 
    // Use '/manuscriptAI/' for GitHub Pages (production) and '/' for local development.
    // IMPORTANT: If your exact GitHub repository name is different, change 'manuscriptAI' below!
    base: process.env.NODE_ENV === 'production' ? '/manuscriptAI/' : '/',
    
    plugins: [
      react(), 
      tailwindcss(),
      electron({
        main: {
          entry: 'electron/main.ts',
        },
        preload: {
          input: path.join(__dirname, 'electron/preload.mjs'),
        },
        renderer: process.env.NODE_ENV === 'test' ? undefined : {},
      }),
      {
        name: 'cors-bypass',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.method === 'OPTIONS' && req.url?.startsWith('/api/proxy')) {
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target-url');
              res.statusCode = 200;
              res.end();
              return;
            }
            next();
          });
        }
      }
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api/proxy': {
          target: 'http://localhost', // Fallback URL, handled by router
          changeOrigin: true,
          secure: false,
          router: (req: any) => {
            try {
              const url = new URL(req.url, 'http://localhost');
              const target = url.searchParams.get('target');
              if (target) {
                return new URL(target).origin;
              }
            } catch (e) {}
            return 'http://localhost';
          },
          rewrite: (path: string) => {
            try {
              const url = new URL(path, 'http://localhost');
              const target = url.searchParams.get('target');
              if (target) {
                return new URL(target).pathname + new URL(target).search;
              }
            } catch (e) {}
            return path.replace(/^\/api\/proxy/, '');
          }
        }
      }
    },
  };
});
