import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/core/index.ts',
    'sqlite/index': 'src/sqlite/index.ts',
    'react/index': 'src/react/index.ts',
    'react-native/index': 'src/react-native/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['react'],
});
