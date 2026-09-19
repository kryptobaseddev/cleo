import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: false,
      // adapter-node bundles devDependencies and leaves dependencies external.
      // Studio is staged inside the CLI package, so its framework and visual
      // imports must be bundled. llmtxt/loro-crdt remain runtime dependencies
      // because their WASM assets must resolve through the installed packages.
    }),
  },
};

export default config;
