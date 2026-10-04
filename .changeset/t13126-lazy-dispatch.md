---
id: t13126-lazy-dispatch
tasks: [T13126]
kind: fix
summary: cleo show, find, list and current dispatch without loading the CORE barrel
---

After the CLI bundle stopped hoisting CORE into startup, every dispatched command still loaded
`@cleocode/core/internal`. Startup maintenance imported it, as did the CLI dispatch adapter, the
middleware, all 29 domain handlers and `@cleocode/runtime/gateway`, whose index re-exports the
engine, HTTP, MCP and RPC layers. The read verbs agents call most paid for all of it.

- The CLI dispatcher registers one lazy proxy per domain (`dispatch/domains/lazy.ts`). A command
  loads its own domain module on first dispatch instead of all 29.
- `@cleocode/runtime/gateway/dispatch` is a new, light runtime entry: the dispatcher, middleware
  composer, operation registry and response metadata, each importing narrow CORE and contracts
  modules. The CLI's dispatch shims import it instead of the full gateway index.
- Startup maintenance, the project encounter, the device heartbeat, shutdown and the dispatch path
  import the CORE modules that declare what they use, never the barrel. CAAMP's skill catalog is
  registered on first need, not on every command.
- `tasks.show`, `tasks.find`, `tasks.list` and `tasks.current` run on those narrow modules. Every
  other operation still loads the barrel before it is dispatched, so it keeps the module-load
  registrations it always had: hook handlers, LLM credential seeders, release invariants.
- The first-run prompt checks for a TTY before reading the credential pool.

`cleo show`/`find`/`list`/`current` load about 1,050 modules instead of about 2,400, and peak about
220 MB instead of about 325 MB. Output is unchanged. Gate 39 now forbids the CORE barrel in `show`
and `find` and lowers their module budgets.
