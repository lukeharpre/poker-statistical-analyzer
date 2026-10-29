import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { headToHead } from './server/h2h';

export default defineConfig({
  plugins: [react(), headToHead()],
  // Engine tests play whole hands and tournaments with the bots' full maths.
  test: { testTimeout: 60_000 },
});
