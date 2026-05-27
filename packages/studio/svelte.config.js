import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: false,
      // T1693: Tell the adapter-node Rollup bundler not to inline these packages.
      // loro-crdt contains a .wasm binary that Rollup cannot parse ("Unexpected
      // character '\0'"). llmtxt transitively imports loro-crdt. They are kept as
      // runtime dependencies (installed alongside the build output) rather than
      // being inlined into build/index.js.
      external: ['llmtxt', 'loro-crdt'],
    }),
  },
};

export default config;
