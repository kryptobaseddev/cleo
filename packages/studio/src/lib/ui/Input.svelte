<!--
  Input — accessible text field with optional leading / trailing icon
  slots and a live-region error message.

  Validation UX pattern:
    - `invalid` prop flips the visible border to `--danger`.
    - `error` message is rendered inside a `role="alert"` + `aria-live`
      region so assistive tech announces it immediately.
    - `description` is a neutral hint (smaller, `--text-dim`) linked via
      `aria-describedby`.

  The input is uncontrolled by default — pass a writable `value`
  and use `bind:value`. The component exposes `oninput` passthrough for
  non-binding callers.

  @task T990
  @wave 0
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for {@link Input}.
   */
  interface Props {
    /** Bindable input value. */
    value?: string;
    /** Native input type (text, email, url, number, search, tel, password). */
    type?:
      | 'text'
      | 'email'
      | 'url'
      | 'number'
      | 'search'
      | 'tel'
      | 'password';
    /** Placeholder text. */
    placeholder?: string;
    /** Native `name` attribute. */
    name?: string;
    /** Native `id` — auto-generated when omitted. */
    id?: string;
    /** Visible label. Rendered inside a `<label>` bound to the input. */
    label?: string;
    /** Neutral hint message shown below the input. */
    description?: string;
    /** Error message — non-empty string auto-sets `invalid=true`. */
    error?: string;
    /** Explicit invalid flag. Forced `true` when `error` is non-empty. */
    invalid?: boolean;
    /** Disabled state. */
    disabled?: boolean;
    /** Read-only state. */
    readonly?: boolean;
    /** Required flag. */
    required?: boolean;
    /** Autocomplete hint forwarded to the native input. */
    autocomplete?: HTMLInputElement['autocomplete'];
    /** Extra class names. */
    class?: string;
    /** Icon slot rendered inside the field, before the text. */
    leadingIcon?: Snippet;
    /** Icon slot rendered inside the field, after the text. */
    trailingIcon?: Snippet;
    /** Raw `oninput` passthrough. */
    oninput?: (event: Event) => void;
    /** Raw `onchange` passthrough. */
    onchange?: (event: Event) => void;
    /** Raw `onblur` passthrough. */
    onblur?: (event: FocusEvent) => void;
  }

  let {
    value = $bindable(''),
    type = 'text',
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
    autocomplete,
    class: extraClass = '',
    leadingIcon,
    trailingIcon,
    oninput,
    onchange,
    onblur,
  }: Props = $props();

  // Generated fallback id — stable per mount via Svelte 5 crypto.randomUUID()
  // guard so SSR doesn't crash.
  const uid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const fieldId = $derived(id ?? `cleo-in-${uid}`);
  const descId = $derived(`${fieldId}-desc`);
  const errId = $derived(`${fieldId}-err`);
  const isInvalid = $derived(invalid || (typeof error === 'string' && error.length > 0));

  function handleInput(e: Event): void {
    const next = (e.target as HTMLInputElement).value;
    value = next;
    oninput?.(e);
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
    {#if leadingIcon}
      <span class="icon leading" aria-hidden="true">{@render leadingIcon()}</span>
    {/if}
    <input
      id={fieldId}
      {name}
      {type}
      {placeholder}
      {value}
      {disabled}
      {readonly}
      {required}
      {autocomplete}
      aria-invalid={isInvalid ? 'true' : undefined}
      aria-describedby={description && !isInvalid ? descId : isInvalid ? errId : undefined}
      oninput={handleInput}
      {onchange}
      {onblur}
    />
    {#if trailingIcon}
      <span class="icon trailing" aria-hidden="true">{@render trailingIcon()}</span>
    {/if}
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
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
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

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    flex-shrink: 0;
    font-size: var(--text-md);
    line-height: 1;
  }

  input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: var(--text-sm);
    font-family: inherit;
    line-height: var(--leading-normal);
    padding: var(--space-2) 0;
    min-width: 0;
  }

  input::placeholder {
    color: var(--text-faint);
  }

  input:disabled {
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
