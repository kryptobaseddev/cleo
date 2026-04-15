<script lang="ts">
  import { page } from '$app/stores';
  import ProjectSelector from '$lib/components/ProjectSelector.svelte';
  import type { LayoutData } from './$types';

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

    <nav class="studio-nav">
      {#each navItems as item}
        <a
          href={item.href}
          class="nav-link"
          class:active={item.exact
            ? $page.url.pathname === item.href
            : $page.url.pathname.startsWith(item.href)}
          title={item.description}
        >
          {item.label}
        </a>
      {/each}
    </nav>
  </header>

  <main class="studio-main">
    {@render children()}
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: #0f1117;
    color: #e2e8f0;
    min-height: 100vh;
  }

  .studio-shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  .studio-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 1.5rem;
    height: 3rem;
    background: #1a1f2e;
    border-bottom: 1px solid #2d3748;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .studio-logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: #e2e8f0;
    flex-shrink: 0;
  }

  .logo-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    background: #3b82f6;
    border-radius: 4px;
    font-weight: 700;
    font-size: 0.875rem;
    color: white;
  }

  .logo-text {
    font-size: 0.875rem;
    font-weight: 600;
    letter-spacing: 0.025em;
    color: #94a3b8;
  }

  .studio-nav {
    display: flex;
    gap: 0.25rem;
    margin-left: auto;
  }

  .nav-link {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    text-decoration: none;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #94a3b8;
    transition: color 0.15s, background 0.15s;
  }

  .nav-link:hover {
    color: #e2e8f0;
    background: #2d3748;
  }

  .nav-link.active {
    color: #3b82f6;
    background: rgba(59, 130, 246, 0.1);
  }

  .studio-main {
    flex: 1;
    padding: 2rem 1.5rem;
  }
</style>
