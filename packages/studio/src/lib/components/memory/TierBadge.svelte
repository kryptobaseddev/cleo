<!--
  TierBadge — memory tier indicator.

  Thin wrapper around `$lib/ui/Badge` with a semantic tone mapping:

  | tier    | tone     | intent                              |
  |---------|----------|-------------------------------------|
  | short   | neutral  | session scratch — low durability    |
  | medium  | info     | verified fact — project durability  |
  | long    | success  | bedrock — architectural permanence  |
  | unknown | neutral  | never-tiered                        |

  Consumers: observations, decisions, patterns, learnings, search results.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge } from '$lib/ui';

  /**
   * Props for {@link TierBadge}.
   */
  interface Props {
    /** Memory tier — null / unknown / custom renders neutral. */
    tier: 'short' | 'medium' | 'long' | string | null | undefined;
    /** Size. Defaults to `sm` for dense list rows. */
    size?: 'sm' | 'md';
  }

  let { tier, size = 'sm' }: Props = $props();

  const tone = $derived.by(() => {
    if (tier === 'long') return 'success' as const;
    if (tier === 'medium') return 'info' as const;
    if (tier === 'short') return 'neutral' as const;
    return 'neutral' as const;
  });

  const label = $derived(tier ?? 'unknown');
</script>

<Badge {tone} {size} pill>{label}</Badge>
