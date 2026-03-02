import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type FeatureStatus = 'shipped' | 'in-progress' | 'planned' | 'deprecated';

interface Feature {
  id: string;
  name: string;
  status: FeatureStatus;
  details: string;
  taskIds?: string[];
}

interface Category {
  id: string;
  name: string;
  status: FeatureStatus;
  features: Feature[];
}

interface FeatureInventory {
  _meta: {
    version: string;
    generatedAt: string;
    source: string;
    description: string;
  };
  categories: Category[];
}

const FEATURES_JSON = resolve('docs/FEATURES.json');
const FEATURES_MD = resolve('docs/FEATURES.md');

function readInventory(): FeatureInventory {
  const raw = readFileSync(FEATURES_JSON, 'utf8');
  return JSON.parse(raw) as FeatureInventory;
}

function summarize(categories: Category[]): Record<FeatureStatus, number> {
  const counts: Record<FeatureStatus, number> = {
    shipped: 0,
    'in-progress': 0,
    planned: 0,
    deprecated: 0,
  };

  for (const category of categories) {
    for (const feature of category.features) {
      counts[feature.status] += 1;
    }
  }

  return counts;
}

function renderMarkdown(inventory: FeatureInventory): string {
  const now = new Date().toISOString();
  const counts = summarize(inventory.categories);
  const totalFeatures = Object.values(counts).reduce((acc, n) => acc + n, 0);

  const lines: string[] = [];

  lines.push('# CLEO Features');
  lines.push('');
  lines.push('> Auto-generated from `docs/FEATURES.json`. Run `npm run features:generate`.');
  lines.push('');
  lines.push(`- Inventory Version: \`${inventory._meta.version}\``);
  lines.push(`- Inventory Updated: \`${inventory._meta.generatedAt}\``);
  lines.push(`- Generated At: \`${now}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|---|---:|');
  lines.push(`| Categories | ${inventory.categories.length} |`);
  lines.push(`| Features | ${totalFeatures} |`);
  lines.push(`| Shipped | ${counts.shipped} |`);
  lines.push(`| In Progress | ${counts['in-progress']} |`);
  lines.push(`| Planned | ${counts.planned} |`);
  lines.push(`| Deprecated | ${counts.deprecated} |`);
  lines.push('');

  for (const category of inventory.categories) {
    lines.push(`## ${category.name}`);
    lines.push('');
    lines.push(`- Category Status: \`${category.status}\``);
    lines.push('');
    lines.push('| Feature | Status | Task IDs | Details |');
    lines.push('|---|---|---|---|');

    for (const feature of category.features) {
      const taskIds = feature.taskIds && feature.taskIds.length > 0
        ? feature.taskIds.join(', ')
        : '-';
      lines.push(`| ${feature.name} | \`${feature.status}\` | ${taskIds} | ${feature.details} |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function main(): void {
  const inventory = readInventory();
  const markdown = renderMarkdown(inventory);
  writeFileSync(FEATURES_MD, markdown, 'utf8');
  process.stdout.write(`Generated ${FEATURES_MD} from ${FEATURES_JSON}\n`);
}

main();
