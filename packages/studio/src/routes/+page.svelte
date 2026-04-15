<script lang="ts">
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const portals = [
    {
      href: '/brain',
      title: 'Brain',
      subtitle: '5-Substrate Living Canvas',
      description:
        'Unified living canvas across all 5 substrates: brain, nexus, tasks, conduit, and signaldock. Explore the knowledge graph, decisions, observations, quality scores, and code intelligence in one view.',
      color: '#22c55e',
      stats: data.brainStats,
    },
    {
      href: '/code',
      title: 'Code',
      subtitle: 'Code Intelligence',
      description:
        'Interactive visualization of the codebase symbol graph. Explore function calls, module dependencies, community clusters, and execution flows.',
      color: '#3b82f6',
      stats: data.nexusStats,
    },
    {
      href: '/brain/overview',
      title: 'Memory',
      subtitle: 'BRAIN Dashboard',
      description:
        'Decisions timeline, observations, quality distribution, memory tiers, and recent activity. The overview dashboard for the 5-substrate BRAIN.',
      color: '#f59e0b',
      stats: data.brainStats,
    },
    {
      href: '/tasks',
      title: 'Tasks',
      subtitle: 'Task Management',
      description:
        'RCASD-IVTR+C pipeline board, epic hierarchy, session history, and task detail views. Read-only — all mutations remain CLI-only.',
      color: '#a855f7',
      stats: data.tasksStats,
    },
  ];
</script>

<svelte:head>
  <title>CLEO Studio</title>
</svelte:head>

<div class="home">
  <div class="home-hero">
    <h1 class="hero-title">CLEO Studio</h1>
    <p class="hero-subtitle">
      Unified observability portal for the CLEO agent platform. Read-only views over live project
      data.
    </p>
  </div>

  <div class="portal-grid">
    {#each portals as portal}
      <a href={portal.href} class="portal-card" style="--accent: {portal.color}">
        <div class="card-header">
          <div class="card-icon" style="background: {portal.color}20; color: {portal.color}">
            {portal.title[0]}
          </div>
          <div class="card-titles">
            <h2 class="card-title">{portal.title}</h2>
            <span class="card-subtitle">{portal.subtitle}</span>
          </div>
        </div>
        <p class="card-description">{portal.description}</p>
        {#if portal.stats}
          <div class="card-stats">
            {#each portal.stats as stat}
              <div class="stat">
                <span class="stat-value">{stat.value}</span>
                <span class="stat-label">{stat.label}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="card-unavailable">Database not found</div>
        {/if}
        <div class="card-arrow">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M3 8a.5.5 0 0 1 .5-.5h7.793L8.146 4.354a.5.5 0 1 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L11.293 8.5H3.5A.5.5 0 0 1 3 8z"
            />
          </svg>
        </div>
      </a>
    {/each}
  </div>
</div>

<style>
  .home {
    max-width: 900px;
    margin: 0 auto;
  }

  .home-hero {
    margin-bottom: 3rem;
    text-align: center;
  }

  .hero-title {
    font-size: 2.25rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: #f1f5f9;
    margin-bottom: 0.75rem;
  }

  .hero-subtitle {
    font-size: 1rem;
    color: #64748b;
    max-width: 480px;
    margin: 0 auto;
    line-height: 1.6;
  }

  .portal-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
  }

  .portal-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.25rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s, background 0.15s;
    position: relative;
  }

  .portal-card:hover {
    border-color: var(--accent);
    background: #1e2438;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .card-icon {
    width: 2.25rem;
    height: 2.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    font-weight: 700;
    font-size: 1rem;
    flex-shrink: 0;
  }

  .card-titles {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .card-title {
    font-size: 1rem;
    font-weight: 600;
    color: #f1f5f9;
  }

  .card-subtitle {
    font-size: 0.75rem;
    color: #64748b;
  }

  .card-description {
    font-size: 0.8125rem;
    color: #94a3b8;
    line-height: 1.6;
  }

  .card-stats {
    display: flex;
    gap: 1rem;
    padding-top: 0.5rem;
    border-top: 1px solid #2d3748;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .stat-value {
    font-size: 1rem;
    font-weight: 600;
    color: #f1f5f9;
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .card-unavailable {
    font-size: 0.75rem;
    color: #ef4444;
    padding-top: 0.5rem;
    border-top: 1px solid #2d3748;
  }

  .card-arrow {
    position: absolute;
    top: 1.25rem;
    right: 1.25rem;
    color: #64748b;
    transition: color 0.15s, transform 0.15s;
  }

  .portal-card:hover .card-arrow {
    color: var(--accent);
    transform: translateX(2px);
  }
</style>
