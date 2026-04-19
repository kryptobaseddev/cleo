<!--
  Select — styled native `<select>` wrapper.

  Uses the native element for reliability (keyboard, mobile pickers,
  form semantics) and overlays a token-consistent chevron via CSS
  background-image. Renders `<option>` from a supplied array or from
  the default slot when callers want full control.

  @task T990
  @wave 0
-->
<script lang="ts" module>
  /**
   * A single option in a {@link Select}.
   */
  export interface SelectOption<V extends string | number = string> {
    /** Opaque value written back to `bind:value`. */
    value: V;
    /** Human-readable option text. */
    label: string;
    /** When true, the option is unselectable. */
    disabled?: boolean;
  }
</script>

<script lang="ts" generics="T extends string | number">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link Select}.
   */
  interface Props {
    /** Bindable value. */
    value?: T;
    /** Options array. If omitted, pass `<option>` via the default slot. */
    options?: SelectOption<T>[];
    /** Visible label. */
    label?: string;
    /** Placeholder — rendered as a disabled first option when set. */
    placeholder?: string;
    /** Native name. */
    name?: string;
    /** Native id — auto-generated when omitted. */
    id?: string;
    /** Neutral hint under the field. */
    description?: string;
    /** Error message. Non-empty flips `invalid=true`. */
    error?: string;
    /** Explicit invalid flag. */
    invalid?: boolean;
    /** Disabled state. */
    disabled?: boolean;
    /** Required flag. */
    required?: boolean;
    /** Extra class names. */
    class?: string;
    /** Default slot — raw `<option>` children when not using `options`. */
    children?: Snippet;
    /** Raw onchange passthrough. */
    onchange?: (event: Event) => void;
  }

  let {
    value = $bindable<T>(undefined as unknown as T),
    options,
    label,
    placeholder,
    name,
    id,
    description,
    error,
    invalid = false,
    disabled = false,
    required = false,
    class: extraClass = '',
    children,
    onchange,
  }: Props = $props();

  const uid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const fieldId = $derived(id ?? `cleo-sel-${uid}`);
  const descId = $derived(`${fieldId}-desc`);
  const errId = $derived(`${fieldId}-err`);
  const isInvalid = $derived(invalid || (typeof error === 'string' && error.length > 0));

  function handleChange(e: Event): void {
    const el = e.target as HTMLSelectElement;
    // Coerce to the generic value type; numeric options round-trip
    // through strings via the native select.
    value = el.value as T;
    onchange?.(e);
  }
</script>

<div class="field {extraClass}">
  {#if label}
    <label class="label" for={fieldId}>
      {label}
      {#if required}
        <span class="req" aria-hidden="true">*</span>
      {/if}
    </label>
  {/if}

  <div class="shell" class:invalid={isInvalid} class:is-disabled={disabled}>
    <select
      id={fieldId}
      {name}
      {disabled}
      {required}
      {value}
      aria-invalid={isInvalid ? 'true' : undefined}
      aria-describedby={description && !isInvalid ? descId : isInvalid ? errId : undefined}
      onchange={handleChange}
    >
      {#if placeholder}
        <option value="" disabled selected={value === undefined || value === ''}>
          {placeholder}
        </option>
      {/if}
      {#if options}
        {#each options as opt (opt.value)}
          <option value={opt.value} disabled={opt.disabled}>{opt.label}</option>
        {/each}
      {:else if children}
        {@render children()}
      {/if}
    </select>
    <span class="chevron" aria-hidden="true">▾</span>
  </div>

  {#if description && !isInvalid}
    <p id={descId} class="description">{description}</p>
  {/if}
  {#if isInvalid && error}
    <p id={errId} class="error" role="alert" aria-live="polite">{error}</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
  }

  .label {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }

  .req {
    color: var(--danger);
    margin-left: 2px;
  }

  .shell {
    position: relative;
    display: flex;
    align-items: center;
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color var(--ease), box-shadow var(--ease),
      background var(--ease);
  }

  .shell:hover:not(.is-disabled) {
    border-color: var(--border-strong);
  }

  .shell:focus-within {
    border-color: var(--accent);
    box-shadow: var(--shadow-focus);
    background: var(--bg-elev-2);
  }

  .shell.invalid {
    border-color: var(--danger);
  }

  .shell.invalid:focus-within {
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  .shell.is-disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  select {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: var(--text-sm);
    font-family: inherit;
    line-height: var(--leading-normal);
    padding: var(--space-2) var(--space-8) var(--space-2) var(--space-3);
    flex: 1;
    cursor: pointer;
    min-width: 0;
  }

  select:disabled {
    cursor: not-allowed;
  }

  .chevron {
    position: absolute;
    right: var(--space-3);
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--text-xs);
    color: var(--text-faint);
    pointer-events: none;
    transition: color var(--ease), transform var(--ease);
  }

  .shell:focus-within .chevron {
    color: var(--accent);
  }

  .description {
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin-top: var(--space-1);
  }

  .error {
    font-size: var(--text-xs);
    color: var(--danger);
    margin-top: var(--space-1);
    font-weight: 500;
  }
</style>
