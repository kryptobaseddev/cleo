<!--
  PromotionCountdown — days-until-tier-promotion indicator.

  Renders a token-tinted chip showing the remaining window. Zero
  (or near-zero) days renders as "ready now" in the success tone;
  hours render with the info tone; days render in neutral.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge } from '$lib/ui';

  /**
   * Props for {@link PromotionCountdown}.
   */
  interface Props {
    /** Remaining days until eligibility (0 = now). */
    daysUntil: number;
  }

  let { daysUntil }: Props = $props();

  const tone = $derived.by(() => {
    if (daysUntil < 0.1) return 'success' as const;
    if (daysUntil < 1) return 'info' as const;
    return 'neutral' as const;
  });

  const label = $derived.by(() => {
    if (daysUntil < 0.1) return 'ready now';
    if (daysUntil < 1) return `${Math.round(daysUntil * 24)}h`;
    return `${daysUntil.toFixed(1)}d`;
  });
</script>

<Badge {tone} size="sm" pill>{label}</Badge>
