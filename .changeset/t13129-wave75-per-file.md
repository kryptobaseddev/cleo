---
id: t13129-wave75-per-file
tasks: [T13129]
kind: fix
summary: Core's utils-consuming dist files are emitted per file again, so a process holds one copy of each core module
---

Build Wave 7.5 re-emits the four core files that import the private `@cleocode/utils` leaf, so the
published dist carries no bare `@cleocode/utils` import. It reused the core esbuild options, whose
`bundle: true` also inlined every relative import and all of `@cleocode/contracts`. Three of the files
came out as self-contained bundles: `docs/export-document.js` (2.3 MB), `llm/plugin-facade.js`
(3.6 MB) and `selfimprove/fix-gen.js` (3.6 MB, 508 inlined modules). A process that loaded one ran a
second copy of that part of core. `export-document.js`, for example, carried its own
`store/data-accessor` registry beside the canonical one, plus duplicate zod schemas.

Wave 7.5 now inlines `@cleocode/utils` and nothing else; every other import stays a real import of
the canonical dist file, as tsc emits it. The files are 2.8–11 KB. The build fails if esbuild's
metafile shows any other module inlined, and a test checks the built files' imports and that
loading `export-document.js` loads the canonical `store/data-accessor`, `paths` and `blob-ops`.

Loading `@cleocode/core/internal` keeps 163 -> 133 MB of heap after GC and peaks 462 -> 422 MB;
read commands (`show`, `find`, `current`) peak about 400 -> 368 MB. Output is unchanged.
