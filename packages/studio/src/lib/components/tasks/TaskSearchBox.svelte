<!--
  TaskSearchBox — search input with `/` keyboard shortcut and debounced
  onChange.

  Consumed by the shared Task Explorer toolbar. The input itself does NOT
  perform any navigation or API calls — it fires a debounced `onChange`
  that the parent can wire into a fetch, a URL-sync helper or whatever.

  Keyboard:
    `/`  — focus the input from anywhere on the page (unless another
           input is focused).
    `Esc` — clear the input and blur.

  Matches the viz reference search box at `/tmp/task-viz/index.html:130-163`
  and the legacy Studio dashboard search at `/tasks/+page.svelte:229-248`.

  @task T950
  @epic T949
-->
<script lang="ts">
  import { onMount } from 'svelte';

  /**
   * Props for {@link TaskSearchBox}.
   */
  interface Props {
    /**
     * Current raw input value. Kept bindable so the parent can clear it
     * programmatically (e.g. on tab switch).
     */
    value: string;
    /**
     * Debounced change handler fired after `debounceMs` of idle input.
     * Fires with the trimmed raw string — normalisation (id vs title) is
     * left to the parent.
     */
    onChange: (q: string) => void;
    /**
     * Placeholder text. Defaults to the legacy Studio wording.
     */
    placeholder?: string;
    /**
     * Debounce window in milliseconds. Defaults to 250ms to match the
     * existing dashboard search.
     */
    debounceMs?: number;
    /**
     * When true, register the global `/` shortcut listener on mount.
     * Default `true`. Set to `false` if multiple search boxes exist on
     * the same page.
     */
    registerSlashShortcut?: boolean;
  }

  let {
    value = $bindable(''),
    onChange,
    placeholder = 'Search by ID (T663, t663, 663) or title...',
    debounceMs = 250,
    registerSlashShortcut = true,
  }: Props = $props();

  let inputEl: HTMLInputElement | null = $state(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit(raw: string): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      onChange(raw.trim());
    }, debounceMs);
  }

  function onInput(e: Event): void {
    const next = (e.target as HTMLInputElement).value;
    value = next;
    emit(next);
  }

  function clear(): void {
    value = '';
    if (timer !== null) clearTimeout(timer);
    onChange('');
    inputEl?.focus();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (value.length > 0) {
        e.preventDefault();
        clear();
      } else {
        inputEl?.blur();
      }
    }
  }

  onMount(() => {
    if (!registerSlashShortcut) return;

    const handler = (e: KeyboardEvent): void => {
      if (e.key !== '/') return;
      const active = document.activeElement;
      // Don't steal focus if the user is already typing in an input,
      // textarea, or contentEditable element.
      if (active instanceof HTMLElement) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
      }
      e.preventDefault();
      inputEl?.focus();
      inputEl?.select();
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      if (timer !== null) clearTimeout(timer);
    };
  });
</script>

<div class="search-box" role="search">
  <span class="search-icon" aria-hidden="true">⌕</span>
  <input
    bind:this={inputEl}
    class="search-input"
    type="search"
    {placeholder}
    {value}
    oninput={onInput}
    onkeydown={onKeydown}
    autocomplete="off"
    spellcheck="false"
    aria-label={placeholder}
  />
  <kbd class="shortcut-hint" aria-hidden="true">/</kbd>
  {#if value.length > 0}
    <button
      type="button"
      class="search-clear"
      onclick={clear}
      aria-label="Clear search"
    >
      ✕
    </button>
  {/if}
</div>

<style>
  .search-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 0.5rem 0.875rem;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .search-box:focus-within {
    border-color: rgba(168, 85, 247, 0.5);
    box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.1);
  }

  .search-icon {
    color: #475569;
    font-size: 1.125rem;
    line-height: 1;
    flex-shrink: 0;
    user-select: none;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #f1f5f9;
    font-size: 0.875rem;
    min-width: 0;
    font-family: inherit;
  }

  .search-input::placeholder {
    color: #475569;
  }

  /* Hide the native clear button on type=search */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  .shortcut-hint {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #64748b;
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 3px;
    padding: 1px 5px;
    line-height: 1.2;
    flex-shrink: 0;
  }

  .search-box:focus-within .shortcut-hint {
    opacity: 0.4;
  }

  .search-clear {
    background: none;
    border: none;
    color: #475569;
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.125rem 0.25rem;
    border-radius: 3px;
    transition: color 0.15s;
    flex-shrink: 0;
    font-family: inherit;
  }

  .search-clear:hover {
    color: #94a3b8;
  }
</style>
