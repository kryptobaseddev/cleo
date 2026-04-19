<script lang="ts">
  import { page } from '$app/stores';
  import ProjectSelector from '$lib/components/ProjectSelector.svelte';
  import type { LayoutData } from './$types';

  // Font faces — loaded once, globally. Fontsource emits CSS that
  // registers @font-face rules for Inter Variable and JetBrains Mono
  // Variable. Together they weigh ~32kb gzipped with font-display: swap.
  import '@fontsource-variable/inter';
  import '@fontsource-variable/jetbrains-mono';

  // Design-system globals — tokens (CSS custom properties) + base
  // reset. MUST be imported before any component-scoped style block
  // so var(--...) resolves everywhere.
  import '$lib/styles/tokens.css';
  import '$lib/styles/base.css';

  interface Props {
    data: LayoutData;
    children: import('svelte').Snippet;
  }
  let { data, children }: Props = $props();

  const navItems = [
    { href: '/brain', label: 'Brain', description: '5-substrate living canvas', exact: true },
    { href: '/brain/overview', label: 'Memory', description: 'BRAIN dashboard (decisions, observations, quality)', exact: false },
    { href: '/code', label: 'Code', description: 'Code intelligence', exact: false },
    { href: '/tasks', label: 'Tasks', description: 'Task management', exact: false },
    { href: '/projects', label: 'Admin', description: 'Project registry — scan, index, and manage projects', exact: false },
  ];
</script>

<a class="skip-link" href="#main">Skip to content</a>

<div class="studio-shell">
  <header class="studio-header">
    <a href="/" class="studio-logo">
      <span class="logo-mark">C</span>
      <span class="logo-text">CLEO Studio</span>
    </a>

    <ProjectSelector
      projects={data.projects}
      activeProjectId={data.activeProjectId}
    />

    <nav class="studio-nav" aria-label="Primary">
      {#each navItems as item}
        <a
          href={item.href}
          class="nav-link"
          class:active={item.exact
            ? $page.url.pathname === item.href
            : $page.url.pathname.startsWith(item.href)}
          title={item.description}
          aria-current={item.exact
            ? $page.url.pathname === item.href ? 'page' : undefined
            : $page.url.pathname.startsWith(item.href) ? 'page' : undefined}
        >
          {item.label}
        </a>
      {/each}
    </nav>
  </header>

  <main id="main" class="studio-main" tabindex="-1">
    {@render children()}
  </main>
</div>

<style>
  /* Global focus ring — applied to every focusable element that lands
   * focus via the keyboard (NOT via mouse). Tokens resolve to 0ms
   * under reduced-motion so the ring still appears instantly for
   * accessibility. */
  :global(*:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    box-shadow: var(--shadow-focus);
  }

  .studio-shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  .studio-header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: 0 var(--space-6);
    height: 3rem;
    background: var(--bg-elev-1);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
  }

  .studio-logo {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    text-decoration: none;
    color: var(--text);
    flex-shrink: 0;
  }

  .studio-logo:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
    border-radius: var(--radius-sm);
  }

  .logo-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    background: var(--accent);
    border-radius: var(--radius-sm);
    font-weight: 700;
    font-size: var(--text-sm);
    color: var(--bg);
    font-family: var(--font-mono);
  }

  .logo-text {
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.025em;
    color: var(--text-dim);
  }

  .studio-nav {
    display: flex;
    gap: var(--space-1);
    margin-left: auto;
  }

  .nav-link {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    text-decoration: none;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-dim);
    transition: color var(--ease), background var(--ease);
  }

  .nav-link:hover {
    color: var(--text);
    background: var(--bg-elev-2);
  }

  .nav-link.active {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .nav-link:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .studio-main {
    flex: 1;
    padding: var(--space-8) var(--space-6);
  }

  .studio-main:focus {
    outline: none;
  }
</style>
