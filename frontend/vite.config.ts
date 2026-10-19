/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

declare const process: { env: Record<string, string | undefined> }; // Node global; avoids pulling @types/node into the browser project

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://localhost:4000' } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
});
