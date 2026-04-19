<!--
  ConfidenceBadge — decision / learning confidence indicator.

  Tone mapping follows Wave 1D spec:

  | confidence  | tone     |
  |-------------|----------|
  | high        | success  |
  | medium      | warning  |
  | low         | danger   |
  | unknown/any | neutral  |

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge } from '$lib/ui';

  /**
   * Props for {@link ConfidenceBadge}.
   */
  interface Props {
    /** Confidence level — string-keyed so adapter payloads flow in unchanged. */
    confidence: string | null | undefined;
    /** Optional numeric confidence [0..1] — rendered after the label when present. */
    value?: number | null;
    /** Size. Defaults to `sm`. */
    size?: 'sm' | 'md';
  }

  let { confidence, value, size = 'sm' }: Props = $props();

  const normalized = $derived((confidence ?? 'unknown').toString().toLowerCase());

  const tone = $derived.by(() => {
    if (normalized === 'high') return 'success' as const;
    if (normalized === 'medium') return 'warning' as const;
    if (normalized === 'low') return 'danger' as const;
    return 'neutral' as const;
  });

  const shown = $derived(
    typeof value === 'number' && Number.isFinite(value)
      ? `${normalized} · ${value.toFixed(2)}`
      : normalized,
  );
</script>

<Badge {tone} {size}>{shown}</Badge>
