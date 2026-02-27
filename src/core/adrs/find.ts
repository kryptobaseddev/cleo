/**
 * ADR Cognitive Search (T4942)
 *
 * In-memory fuzzy search across ADR title, summary, keywords, and topics.
 * Chosen over SQLite FTS5 because the ADR set is small (<50) and in-memory
 * search avoids the complexity of FTS5 virtual table DDL and drizzle integration.
 *
 * Scoring (higher = better match):
 *   40 — keyword tag exact match
 *   30 — topics tag exact match
 *   20 — title contains query term
 *   10 — summary contains query term
 *    5 — id contains query term
 *
 * @task T4942
 * @see ADR-017 §5.4 for cognitive search spec
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAdrFile } from './parse.js';
import type { AdrFindResult } from './types.js';

/** Normalise a string for comparison: lowercase, strip punctuation */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Split a comma-separated tag string into normalised tokens */
function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(t => normalise(t)).filter(Boolean);
}

/** Return true if any query term is found in the target string */
function containsAny(target: string, terms: string[]): boolean {
  const t = normalise(target);
  return terms.some(term => t.includes(term));
}

/** Return matched query terms found in the target */
function matchedTerms(target: string, terms: string[]): string[] {
  const t = normalise(target);
  return terms.filter(term => t.includes(term));
}

export async function findAdrs(
  projectRoot: string,
  query: string,
  opts?: { topics?: string; keywords?: string; status?: string },
): Promise<AdrFindResult> {
  const adrsDir = join(projectRoot, '.cleo', 'adrs');

  if (!existsSync(adrsDir)) {
    return { adrs: [], query, total: 0 };
  }

  const files = readdirSync(adrsDir)
    .filter(f => f.endsWith('.md') && f.startsWith('ADR-'))
    .sort();

  const queryTerms = normalise(query).split(' ').filter(t => t.length > 1);
  const filterTopics = opts?.topics ? parseTags(opts.topics) : null;
  const filterKeywords = opts?.keywords ? parseTags(opts.keywords) : null;

  const results: AdrFindResult['adrs'] = [];

  for (const file of files) {
    const record = parseAdrFile(join(adrsDir, file), projectRoot);
    const fm = record.frontmatter;

    // Status filter
    if (opts?.status && fm.Status !== opts.status) continue;

    // Topics filter (hard filter — must match all specified topics)
    if (filterTopics && filterTopics.length > 0) {
      const adrTopics = parseTags(fm.Topics);
      if (!filterTopics.every(t => adrTopics.includes(t))) continue;
    }

    // Keywords filter (hard filter — must match all specified keywords)
    if (filterKeywords && filterKeywords.length > 0) {
      const adrKeywords = parseTags(fm.Keywords);
      if (!filterKeywords.every(k => adrKeywords.includes(k))) continue;
    }

    // Scoring
    let score = 0;
    const matchedFields: string[] = [];

    if (queryTerms.length > 0) {
      // Keywords exact match (highest signal)
      const adrKeywords = parseTags(fm.Keywords);
      const kwMatches = queryTerms.filter(term => adrKeywords.some(kw => kw.includes(term)));
      if (kwMatches.length > 0) {
        score += 40 * kwMatches.length;
        matchedFields.push('keywords');
      }

      // Topics match
      const adrTopics = parseTags(fm.Topics);
      const topicMatches = queryTerms.filter(term => adrTopics.some(tp => tp.includes(term)));
      if (topicMatches.length > 0) {
        score += 30 * topicMatches.length;
        matchedFields.push('topics');
      }

      // Title contains
      if (containsAny(record.title, queryTerms)) {
        score += 20 * matchedTerms(record.title, queryTerms).length;
        matchedFields.push('title');
      }

      // Summary contains
      if (fm.Summary && containsAny(fm.Summary, queryTerms)) {
        score += 10 * matchedTerms(fm.Summary, queryTerms).length;
        matchedFields.push('summary');
      }

      // ID contains (e.g. "ADR-017")
      if (containsAny(record.id, queryTerms)) {
        score += 5;
        matchedFields.push('id');
      }

      // Skip if no match and a query was provided
      if (score === 0) continue;
    }

    results.push({
      id: record.id,
      title: record.title,
      status: fm.Status,
      date: fm.Date,
      filePath: record.file,
      summary: fm.Summary,
      keywords: fm.Keywords,
      topics: fm.Topics,
      score,
      matchedFields: [...new Set(matchedFields)],
    });
  }

  // Sort by score descending, then by ADR ID ascending for ties
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return { adrs: results, query, total: results.length };
}
