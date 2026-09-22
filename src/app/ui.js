/**
 * DOM helpers and hand-rolled SVG charts.
 *
 * No charting library: an extension cannot pull scripts from a CDN under MV3's
 * CSP, and bundling one would mean adding a build step to a tool whose whole
 * value is being small. Bars and sparklines are a few lines of SVG anyway.
 */

/** Create an element. Children may be nodes or strings; text is never parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.textContent = '';
  return node;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/* ------------------------------------------------------------ formatting -- */

export function money(amount, currency = 'USD', { compact = false } = {}) {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: compact && Math.abs(value) >= 10000 ? 'compact' : 'standard',
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function num(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(value);
}

export function pct(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** Coarse duration for lifecycle stats: '4d 6h', '3h', '—'. */
export function coarseDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem ? `${days}d ${rem}h` : `${days}d`;
}

/* ---------------------------------------------------------------- pieces -- */

/** A headline number with a caption, and an optional sub-line. */
export function statTile(label, value, { sub = null, tone = null, title = null } = {}) {
  return el('div', { class: 'stat', title },
    el('div', { class: `stat-value${tone ? ` tone-${tone}` : ''}` }, value),
    el('div', { class: 'stat-label' }, label),
    sub ? el('div', { class: 'stat-sub' }, sub) : null);
}

export function sectionCard(title, body, actions = null) {
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h3', {}, title),
      actions ? el('div', { class: 'panel-actions' }, actions) : null),
    body);
}

/**
 * Horizontal bar list — the workhorse for every breakdown
 * (time by activity, time by program, findings by type...).
 */
export function barList(rows, { format = (v) => v, colorOf = null, emptyText = 'No data yet' } = {}) {
  if (!rows.length) return el('div', { class: 'empty' }, emptyText);
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return el('div', { class: 'bars' },
    rows.map((row) => el('div', { class: 'bar-row' },
      el('div', { class: 'bar-label truncate', title: row.label }, row.label),
      el('div', { class: 'bar-track' },
        el('div', {
          class: 'bar-fill',
          style: {
            width: `${Math.max(row.value > 0 ? 2 : 0, (row.value / max) * 100)}%`,
            background: (colorOf?.(row) ?? row.color ?? 'var(--accent)'),
          },
        })),
      el('div', { class: 'bar-value mono' }, format(row.value, row)),
      row.note ? el('div', { class: 'bar-note dim mono' }, row.note) : null)));
}

/**
 * Vertical bar chart for a time series. Values are drawn as plain rects with a
 * <title> for hover — enough for "which day did I actually work?".
 */
export function columnChart(points, {
  height = 132, format = (v) => String(v), color = 'var(--accent)', emptyText = 'No data in this period',
} = {}) {
  if (!points.length) return el('div', { class: 'empty' }, emptyText);
  const max = Math.max(...points.map((p) => p.value), 0);
  if (max <= 0) return el('div', { class: 'empty' }, emptyText);

  const n = points.length;
  const width = 1000;
  const gap = n > 120 ? 0.5 : n > 60 ? 1 : 2;
  const slot = width / n;
  const barW = Math.max(1, slot - gap);
  const plotH = height - 18;

  const bars = points.map((p, i) => {
    const h = p.value > 0 ? Math.max(2, (p.value / max) * plotH) : 0;
    return svgEl('g', {},
      svgEl('rect', {
        x: (i * slot + gap / 2).toFixed(2),
        y: (plotH - h).toFixed(2),
        width: barW.toFixed(2),
        height: h.toFixed(2),
        rx: Math.min(2, barW / 2).toFixed(2),
        fill: p.value > 0 ? color : 'transparent',
        opacity: p.highlight ? 1 : 0.85,
      }, svgEl('title', {}, `${p.label} — ${format(p.value, p)}`)),
      // Invisible full-height hit area so hovering a thin/zero bar still works.
      svgEl('rect', {
        x: (i * slot).toFixed(2), y: 0, width: slot.toFixed(2), height: plotH,
        fill: 'transparent',
      }, svgEl('title', {}, `${p.label} — ${format(p.value, p)}`)));
  });

  return el('div', { class: 'chart' },
    svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      class: 'chart-svg',
      role: 'img',
      'aria-label': `Chart with ${n} points, maximum ${format(max)}`,
    },
      svgEl('line', { x1: 0, y1: plotH, x2: width, y2: plotH, stroke: 'var(--line)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
      bars),
    el('div', { class: 'chart-axis dim' },
      el('span', {}, points[0].label),
      el('span', {}, `peak ${format(max)}`),
      el('span', {}, points[n - 1].label)));
}

export function table(headers, rows, { emptyText = 'Nothing here yet' } = {}) {
  if (!rows.length) return el('div', { class: 'empty' }, emptyText);
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {
        class: h.align === 'right' ? 'right' : null,
      }, h.label ?? h)))),
      el('tbody', {}, rows.map((cells) => el('tr', {},
        cells.map((c, i) => el('td', {
          class: headers[i]?.align === 'right' ? 'right' : null,
        }, c)))))));
}

export function pill(label, color) {
  return el('span', { class: 'pill', style: { color } },
    el('span', { class: 'dot' }), label);
}

/* ----------------------------------------------------------------- toast -- */

let toastTimer = null;
export function toast(message, kind = 'ok') {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast' });
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'err' ? 5000 : 2400);
}

export function reportError(err, context) {
  console.error(`[bug-hunt-tracker] ${context}`, err);
  toast(err?.message ? err.message : `Something went wrong (${context})`, 'err');
}

/** Render an error state into a container instead of leaving it blank. */
export function errorPanel(context, err) {
  return el('div', { class: 'empty' },
    el('div', {}, `Could not load ${context}.`),
    el('div', { class: 'dim', style: { marginTop: '6px', fontSize: '11.5px' } }, err?.message ?? ''));
}
