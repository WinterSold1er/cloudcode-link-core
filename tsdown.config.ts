import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  dts: true,
  clean: true,
  fixedExtension: false,
  sourcemap: true,
  deps: {
    neverBundle: ['qrcode', 'undici', /^node:/],
  },
})
