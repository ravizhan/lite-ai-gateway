import { versions } from 'node:process'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['server/node.ts'],
  platform: 'node',
  format: ['esm'],
  outDir: 'dist-bundle/server',
  deps: { alwaysBundle: [/.*/] },
  outputOptions: { codeSplitting: false },
  dts: false,
  sourcemap: false,
  minify: true,
  exe: {
    fileName: 'lite-ai-gateway',
    outDir: 'dist-bundle/server',
    // SEA blobs must use the same Node version as their target executable.
    targets: [
      { platform: 'linux', arch: 'x64', nodeVersion: versions.node },
      { platform: 'win', arch: 'x64', nodeVersion: versions.node },
      { platform: 'darwin', arch: 'arm64', nodeVersion: versions.node },
    ],
  },
})
