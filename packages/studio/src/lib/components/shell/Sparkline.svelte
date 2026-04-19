<!--
  Sparkline — zero-dep SVG sparkline. Given a `points` array of numbers,
  renders a smooth polyline with optional area fill, a final-point marker,
  and a min/max band.

  Design intent: tiny NASA-panel waveform — sits inline with a stat,
  never steals focus. Scales the y-axis to the [min, max] of the data,
  so a dead-flat series still renders as a centred line.

  @task T990
  @wave 1E
-->
<script lang="ts">
  /**
   * Props for {@link Sparkline}.
   */
  interface Props {
    /** Data points (oldest to newest). Min 2 points to render. */
    points: readonly number[];
    /** Stroke width in px. Defaults to 1.5. */
    strokeWidth?: number;
    /** Total width in px. Defaults to 120. */
    width?: number;
    /** Total height in px. Defaults to 32. */
    height?: number;
    /**
     * Stroke colour CSS variable name (without `--`). Defaults to
     * `accent`. Pass `'success'`, `'warning'`, `'danger'`, `'info'`,
     * `'text-dim'` to retint.
     */
    tone?: 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'text-dim';
    /** When true, fills the area under the line with a soft gradient. */
    fill?: boolean;
    /** Accessible summary for screen readers. */
    ariaLabel?: string;
  }

  let {
    points,
    strokeWidth = 1.5,
    width = 120,
    height = 32,
    tone = 'accent',
    fill = true,
    ariaLabel = 'Activity trend',
  }: Props = $props();

  /** Safe copy without reactive proxy gotchas. */
  const safePoints = $derived<readonly number[]>(
    Array.isArray(points) ? points : [],
  );

  interface SparkGeometry {
    pathD: string;
    areaD: string;
    lastX: number;
    lastY: number;
    min: number;
    max: number;
  }

  const geometry = $derived<SparkGeometry>(buildGeometry(safePoints, width, height, strokeWidth));

  function buildGeometry(
    data: readonly number[],
    w: number,
    h: number,
    sw: number,
  ): SparkGeometry {
    if (data.length < 2) {
      return {
        pathD: '',
        areaD: '',
        lastX: 0,
        lastY: h / 2,
        min: 0,
        max: 0,
      };
    }

    const pad = sw;
    const usableW = Math.max(1, w - pad * 2);
    const usableH = Math.max(1, h - pad * 2);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;

    const step = usableW / (data.length - 1);

    const pts = data.map((v, i) => {
      const x = pad + step * i;
      const y = pad + usableH - ((v - min) / span) * usableH;
      return { x, y };
    });

    const pathD = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ');

    const areaD = `${pathD} L${pts[pts.length - 1]!.x.toFixed(2)},${(h - pad).toFixed(2)} L${pts[0]!.x.toFixed(2)},${(h - pad).toFixed(2)} Z`;

    const last = pts[pts.length - 1]!;

    return {
      pathD,
      areaD,
      lastX: last.x,
      lastY: last.y,
      min,
      max,
    };
  }

  const gradId = `spark-grad-${Math.random().toString(36).slice(2, 8)}`;
  const stroke = $derived(`var(--${tone})`);
  const fillColor = $derived(`var(--${tone}-soft, var(--${tone}))`);
</script>

{#if safePoints.length < 2}
  <svg
    class="sparkline is-empty"
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    aria-label={ariaLabel}
    role="img"
  >
    <line
      x1="0"
      y1={height / 2}
      x2={width}
      y2={height / 2}
      stroke="var(--border)"
      stroke-dasharray="2 3"
      stroke-width="1"
    />
  </svg>
{:else}
  <svg
    class="sparkline"
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    aria-label={ariaLabel}
    role="img"
  >
    {#if fill}
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={fillColor} stop-opacity="0.5" />
          <stop offset="100%" stop-color={fillColor} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={geometry.areaD} fill={`url(#${gradId})`} />
    {/if}
    <path
      d={geometry.pathD}
      fill="none"
      stroke={stroke}
      stroke-width={strokeWidth}
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <circle
      cx={geometry.lastX}
      cy={geometry.lastY}
      r={strokeWidth + 0.5}
      fill={stroke}
    />
  </svg>
{/if}

<style>
  .sparkline {
    display: block;
    overflow: visible;
  }

  .sparkline.is-empty {
    opacity: 0.6;
  }
</style>
