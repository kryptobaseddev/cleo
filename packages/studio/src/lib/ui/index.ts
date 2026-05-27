/**
 * CLEO Studio — UI primitives barrel export.
 *
 * Consumers import via `$lib/ui` rather than reaching into individual
 * files. Keeps the public surface stable even as internal filenames
 * evolve.
 *
 * @task T990
 * @wave 0
 */

export { default as Badge } from './Badge.svelte';
export type { BreadcrumbItem } from './Breadcrumb.svelte';
export { default as Breadcrumb } from './Breadcrumb.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as Chip } from './Chip.svelte';
export { default as ChipGroup } from './ChipGroup.svelte';
export { default as Drawer } from './Drawer.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as Input } from './Input.svelte';
export { default as Modal } from './Modal.svelte';
export type { SelectOption } from './Select.svelte';
export { default as Select } from './Select.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as TabPanel } from './TabPanel.svelte';
export type { TabItem } from './Tabs.svelte';
export { default as Tabs } from './Tabs.svelte';
export { default as Textarea } from './Textarea.svelte';
export { default as Tooltip } from './Tooltip.svelte';

export type {
  CardDensity,
  Placement,
  Size,
  Tone,
  Variant,
} from './types.js';
