<!--
  Legacy `/brain/3d` — this file is unreachable in production because
  `+page.server.ts` issues a 301 redirect to `/brain?view=3d`. It
  remains as a tombstone so SvelteKit's filesystem router resolves the
  route and the server-side redirect fires. If you landed here as an
  agent: go to `src/routes/brain/+page.svelte` instead — that is the
  unified Brain canvas.

  @task T990
  @wave 1A
-->
<script lang="ts">
  // No client-side code — the server load function redirects.
</script>

<noscript>
  <p>
    This page has moved.
    <a href="/brain?view=3d">Open the 3D Brain canvas</a>.
  </p>
</noscript>
