<!--
  Textarea — multi-line text input with optional auto-resize.

  Shares the same validation / description / error UX as {@link Input}.
  When `autoResize` is `true` the element's height is recomputed on
  every `input` event by setting `height` to `scrollHeight` — no
  external observer, no layout thrashing.

  @task T990
  @wave 0
-->
<script lang="ts">
  /**
   * Props for {@link Textarea}.
   */
  interface Props {
    /** Bindable text value. */
    value?: string;
    /** Placeholder text. */
    placeholder?: string;
    /** Native name. */
    name?: string;
    /** Native id — auto-generated when omitted. */
    id?: string;
    /** Visible label. */
    label?: string;
    /** Neutral hint below the field. */
    description?: string;
    /** Error string. Non-empty flips `invalid=true`. */
    error?: string;
    /** Explicit invalid flag. */
    invalid?: boolean;
    /** Disabled state. */
    disabled?: boolean;
    /** Read-only state. */
    readonly?: boolean;
    /** Required flag. */
    required?: boolean;
    /** Minimum row count (native attribute). Defaults to 3. */
    rows?: number;
    /** Maximum character count. */
    maxlength?: number;
    /**
     * When true, the element grows with its content (and shrinks on
     * deletion). Defaults to `false`.
     */
    autoResize?: boolean;
    /** Extra class names. */
    class?: string;
    /** Raw `oninput` passthrough. */
    oninput?: (event: Event) => void;
    /** Raw `onchange` passthrough. */
    onchange?: (event: Event) => void;
    /** Raw `onblur` passthrough. */
    onblur?: (event: FocusEvent) => void;
  }

  let {
    value = $bindable(''),
    placeholder,
    name,
    id,
    label,
    description,
    error,
    invalid = false,
    disabled = false,
    readonly = false,
    required = false,
    rows = 3,
    maxlength,
    autoResize = false,
    class: extraClass = '',
    oninput,
    onchange,
    onblur,
  }: Props = $props();

  const uid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const fieldId = $derived(id ?? `cleo-ta-${uid}`);
  const descId = $derived(`${fieldId}-desc`);
  const errId = $derived(`${fieldId}-err`);
  const isInvalid = $derived(invalid || (typeof error === 'string' && error.length > 0));

  let taEl: HTMLTextAreaElement | null = $state(null);

  function resize(): void {
    if (!autoResize || !taEl) return;
    taEl.style.height = 'auto';
    taEl.style.height = `${taEl.scrollHeight}px`;
  }

  function handleInput(e: Event): void {
    const next = (e.target as HTMLTextAreaElement).value;
    value = next;
    resize();
    oninput?.(e);
  }

  $effect(() => {
    // Re-measure when the bound value changes programmatically.
    if (autoResize) {
      void value;
      resize();
    }
  });
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
    <textarea
      bind:this={taEl}
      id={fieldId}
      {name}
      {placeholder}
      {value}
      {rows}
      {maxlength}
      {disabled}
      {readonly}
      {required}
      aria-invalid={isInvalid ? 'true' : undefined}
      aria-describedby={description && !isInvalid ? descId : isInvalid ? errId : undefined}
      oninput={handleInput}
      {onchange}
      {onblur}
    ></textarea>
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

  textarea {
    width: 100%;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: var(--text-sm);
    font-family: inherit;
    line-height: var(--leading-normal);
    padding: var(--space-2) var(--space-3);
    resize: vertical;
    min-height: calc(var(--space-8) + var(--space-1));
  }

  textarea::placeholder {
    color: var(--text-faint);
  }

  textarea:disabled {
    cursor: not-allowed;
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
