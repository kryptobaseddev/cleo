// CLEO Docs Viewer SPA — minimal, zero-dep client for /api/docs + /api/docs/:slug.
// Renders markdown via a tiny inline renderer (sufficient for headings, code,
// lists, links, blockquotes, inline-code, bold, italic, tables, hr). For
// anything richer we recommend wiring a real markdown lib later.

const $list = document.getElementById('doc-list');
const $render = document.getElementById('doc-render');
const $filter = document.getElementById('filter');
const $search = document.getElementById('search');
const $searchResults = document.getElementById('search-results');

const state = {
  docs: [],
  activeSlug: null,
  searchSeq: 0,
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tiny markdown -> HTML renderer. Not CommonMark-complete; covers the basics.
function renderMarkdown(md) {
  if (typeof md !== 'string') return '';
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let listType = null;
  let listBuf = [];
  let paraBuf = [];
  let inTable = false;
  let tableBuf = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    out.push('<p>' + inlineMd(paraBuf.join(' ')) + '</p>');
    paraBuf = [];
  };
  const flushList = () => {
    if (listType === null || listBuf.length === 0) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    out.push(`<${tag}>` + listBuf.map((i) => `<li>${inlineMd(i)}</li>`).join('') + `</${tag}>`);
    listBuf = [];
    listType = null;
  };
  const flushTable = () => {
    if (!inTable || tableBuf.length === 0) return;
    const rows = tableBuf.map((r) =>
      r
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    );
    const head = rows[0];
    const body = rows.slice(2);
    let html = '<table><thead><tr>';
    for (const c of head) html += `<th>${inlineMd(c)}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of body) {
      html += '<tr>';
      for (const c of row) html += `<td>${inlineMd(c)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    out.push(html);
    tableBuf = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      flushTable();
      if (inCode) {
        out.push(
          `<pre><code class="lang-${escapeHtml(codeLang)}">` +
            escapeHtml(codeBuf.join('\n')) +
            '</code></pre>',
        );
        codeBuf = [];
        codeLang = '';
        inCode = false;
      } else {
        inCode = true;
        codeLang = fence[1] || '';
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // Blank line → flush block buffers
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      flushTable();
      continue;
    }

    // Tables (very basic — | a | b | with separator row)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!inTable) {
        flushPara();
        flushList();
        inTable = true;
      }
      tableBuf.push(line.trim());
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      continue;
    }

    // HR
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr/>');
      continue;
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`);
      continue;
    }

    // Ordered / unordered list items
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') flushList();
      listType = 'ol';
      listBuf.push(ol[2]);
      continue;
    }
    if (ul) {
      flushPara();
      if (listType !== 'ul') flushList();
      listType = 'ul';
      listBuf.push(ul[1]);
      continue;
    }

    // Default — accumulate paragraph
    flushList();
    paraBuf.push(line);
  }

  if (inCode) {
    out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  }
  flushPara();
  flushList();
  flushTable();

  return out.join('\n');
}

// Inline markdown — code spans, bold, italic, links.
function inlineMd(s) {
  let str = escapeHtml(s);
  // Inline code
  str = str.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold + italic combined
  str = str.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  str = str.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  str = str.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Links [text](href)
  str = str.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
    const safe = String(href).replace(/"/g, '%22');
    return `<a href="${safe}" target="_blank" rel="noopener">${text}</a>`;
  });
  return str;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const code = body?.error?.code ?? 'E_HTTP';
    const msg = body?.error?.message ?? res.statusText;
    throw new Error(`${code}: ${msg}`);
  }
  if (body && body.success === false) {
    throw new Error(`${body.error?.code ?? 'E_UNKNOWN'}: ${body.error?.message ?? 'unknown'}`);
  }
  return body.data;
}

function renderDocList(docs) {
  if (docs.length === 0) {
    $list.innerHTML = '<p class="hint">No published docs in this project. Run <code>cleo docs publish</code> first.</p>';
    return;
  }
  const html = docs
    .map((d) => {
      const slug = escapeHtml(d.slug || d.id);
      const title = escapeHtml(d.title || d.slug || d.id);
      const type = d.type ? `<small>${escapeHtml(d.type)}</small>` : '';
      const isActive = d.slug === state.activeSlug ? ' class="active"' : '';
      return `<a href="/docs/${slug}" data-slug="${slug}"${isActive}>${title}${type}</a>`;
    })
    .join('');
  $list.innerHTML = html;
  $list.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const slug = a.getAttribute('data-slug');
      navigate(slug);
    });
  });
}

function applyFilter(q) {
  const lower = q.toLowerCase().trim();
  if (!lower) return renderDocList(state.docs);
  const filtered = state.docs.filter((d) => {
    return (
      (d.slug || '').toLowerCase().includes(lower) ||
      (d.title || '').toLowerCase().includes(lower) ||
      (d.type || '').toLowerCase().includes(lower)
    );
  });
  renderDocList(filtered);
}

async function loadDoc(slug) {
  if (!slug) {
    $render.innerHTML = '<p class="hint">Select a document from the sidebar.</p>';
    return;
  }
  state.activeSlug = slug;
  $render.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const data = await fetchJson(`/api/docs/${encodeURIComponent(slug)}`);
    const md = data.content ?? '';
    $render.innerHTML = renderMarkdown(md);
    document.title = `${data.title || slug} — CLEO Docs`;
    // Highlight active in sidebar
    $list.querySelectorAll('a').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('data-slug') === slug);
    });
  } catch (err) {
    $render.innerHTML = `<p class="error">${escapeHtml(String(err.message || err))}</p>`;
  }
}

function navigate(slug) {
  history.pushState({ slug }, '', `/docs/${slug}`);
  loadDoc(slug);
}

window.addEventListener('popstate', (e) => {
  const slug = e.state?.slug || slugFromPath(location.pathname);
  if (slug) loadDoc(slug);
});

function slugFromPath(pathname) {
  const m = pathname.match(/^\/docs\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

$filter.addEventListener('input', (e) => applyFilter(e.target.value));

// ── Search (T9647) — debounced /api/search with ranked results ──────────────

function debounce(fn, ms) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

function highlightMatches(snippet, query) {
  if (!query) return escapeHtml(snippet);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return escapeHtml(snippet);
  // Build a regex that matches any term, case-insensitive. Escape regex metachars.
  const pattern = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(${pattern})`, 'gi');
  const escaped = escapeHtml(snippet);
  return escaped.replace(re, '<mark>$1</mark>');
}

function renderSearchResults(query, payload) {
  if (!payload || !payload.hits || payload.hits.length === 0) {
    $searchResults.innerHTML =
      `<p class="hint">No results for <code>${escapeHtml(query)}</code>.</p>`;
    $searchResults.hidden = false;
    $list.hidden = true;
    return;
  }
  const html = payload.hits
    .map((h) => {
      const slug = escapeHtml(h.slug || h.id);
      const name = escapeHtml(h.name || h.slug || h.id);
      const type = h.type ? `<span class="result-type">${escapeHtml(h.type)}</span>` : '';
      const score = typeof h.score === 'number' ? h.score.toFixed(3) : '—';
      const snippet = highlightMatches(h.snippet || '', query);
      return [
        `<a href="/docs/${slug}" data-slug="${slug}" class="result">`,
        `<div class="result-head"><span class="result-name">${name}</span>${type}<span class="result-score">${score}</span></div>`,
        `<div class="result-snippet">${snippet}</div>`,
        `</a>`,
      ].join('');
    })
    .join('');
  $searchResults.innerHTML = html;
  $searchResults.hidden = false;
  $list.hidden = true;
  $searchResults.querySelectorAll('a.result').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const slug = a.getAttribute('data-slug');
      navigate(slug);
    });
  });
}

function clearSearchResults() {
  $searchResults.hidden = true;
  $searchResults.innerHTML = '';
  $list.hidden = false;
}

async function runSearch(query) {
  const q = query.trim();
  if (q.length === 0) {
    clearSearchResults();
    return;
  }
  const seq = ++state.searchSeq;
  try {
    const url = `/api/search?q=${encodeURIComponent(q)}&limit=20`;
    const data = await fetchJson(url);
    // Drop stale responses if a newer query has fired.
    if (seq !== state.searchSeq) return;
    renderSearchResults(q, data);
  } catch (err) {
    if (seq !== state.searchSeq) return;
    $searchResults.innerHTML = `<p class="error">${escapeHtml(String(err.message || err))}</p>`;
    $searchResults.hidden = false;
    $list.hidden = true;
  }
}

const debouncedSearch = debounce(runSearch, 300);
$search.addEventListener('input', (e) => debouncedSearch(e.target.value));

(async function init() {
  try {
    const data = await fetchJson('/api/docs');
    state.docs = data.docs || [];
    renderDocList(state.docs);
    const initialSlug = slugFromPath(location.pathname);
    if (initialSlug) loadDoc(initialSlug);
  } catch (err) {
    $list.innerHTML = `<p class="error">${escapeHtml(String(err.message || err))}</p>`;
  }
})();
