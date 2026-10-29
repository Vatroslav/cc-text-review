'use strict';

// cc-text-review: select text, leave a comment, Claude writes a new version,
// and the page shows the word-level changes and which comment each belongs to.

const API = '/api/documents';
const st = {
  slug: null,
  doc: null,
  rev: null,
  version: null,
  view: 'text',
  parsed: new Map(),
  selection: null,
  changes: null,
  uncommentedIndex: 0,
  handoff: 'off',
};
const el = id => document.getElementById(id);

// ---------- helpers ----------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tag = v => ({ t: 'tag', v });
const RE_TOKEN = /[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu;
const textTokens = s => (s.match(RE_TOKEN) || []).map(v => ({ t: 'txt', v }));
const cmp = (a, b) => a.block - b.block || a.char - b.char;
const shorten = (s, n) => { s = s.replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };
const plural = (n, one, many) => (n === 1 ? one : many);

function safeUrl(url) {
  return /^(https?:|mailto:|#|\/|\.)/i.test(url) ? url : '#';
}

function toast(text) {
  const t = el('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

// ---------- markdown to blocks and tokens ----------

const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;

function startsBlock(l) {
  return /^```/.test(l) || /^#{1,6}\s/.test(l) || RE_ITEM.test(l) || /^>/.test(l) || RE_TABLE_ROW.test(l) || RE_RULE.test(l);
}

function parse(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if (/^```/.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', source: code.join('\n') });
      continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push({ type: 'heading', level: m[1].length, source: m[2].trim() });
      i++;
      continue;
    }
    if (RE_RULE.test(l)) { blocks.push({ type: 'rule', source: '' }); i++; continue; }
    if ((m = l.match(RE_ITEM))) {
      const ordered = /\d/.test(m[2]);
      const parts = [m[3]];
      i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !RE_ITEM.test(lines[i])) parts.push(lines[i++].trim());
      blocks.push({
        type: 'item',
        ordered,
        number: ordered ? parseInt(m[2], 10) : null,
        level: Math.min(Math.floor(m[1].replace(/\t/g, '    ').length / 2), 4),
        source: parts.join('\n'),
      });
      continue;
    }
    if (/^>/.test(l)) {
      const parts = [];
      while (i < lines.length && /^>/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', source: parts.join('\n') });
      continue;
    }
    if (RE_TABLE_ROW.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) rows.push(lines[i++]);
      blocks.push({ type: 'table', source: rows.join('\n') });
      continue;
    }
    const parts = [l];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) parts.push(lines[i++]);
    blocks.push({ type: 'paragraph', source: parts.join('\n') });
  }
  return blocks;
}

function inline(src) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(...textTokens(buf)); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && /[\\`*_[\]()#+\-.!~|>]/.test(src[i + 1] || '')) { buf += src[i + 1]; i += 2; continue; }
    if (c === '\n') { flush(); out.push(tag('<br>')); i++; continue; }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j > i) { flush(); out.push(tag('<code>'), ...textTokens(src.slice(i + 1, j)), tag('</code>')); i = j + 1; continue; }
    }
    if (src.startsWith('**', i) || src.startsWith('__', i)) {
      const j = src.indexOf(src.slice(i, i + 2), i + 2);
      if (j > i + 2) { flush(); out.push(tag('<strong>'), ...inline(src.slice(i + 2, j)), tag('</strong>')); i = j + 2; continue; }
    }
    if (src.startsWith('~~', i)) {
      const j = src.indexOf('~~', i + 2);
      if (j > i + 2) { flush(); out.push(tag('<s>'), ...inline(src.slice(i + 2, j)), tag('</s>')); i = j + 2; continue; }
    }
    if ((c === '*' || c === '_') && src[i + 1] && src[i + 1] !== c && !/\s/.test(src[i + 1])
        && (c === '*' || !/[\p{L}\p{N}]/u.test(src[i - 1] || ' '))) {
      let j = i + 1;
      while ((j = src.indexOf(c, j)) !== -1) {
        if (src[j + 1] === c) { j += 2; continue; }
        if (!/\s/.test(src[j - 1])) break;
        j++;
      }
      if (j !== -1 && (c === '*' || !/[\p{L}\p{N}]/u.test(src[j + 1] || ' '))) {
        flush();
        out.push(tag('<em>'), ...inline(src.slice(i + 1, j)), tag('</em>'));
        i = j + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = src.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        flush();
        out.push(tag(`<a href="${esc(safeUrl(m[2]))}" target="_blank" rel="noopener">`), ...inline(m[1]), tag('</a>'));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function tableTokens(source) {
  const out = [];
  source.split('\n').filter((_, k) => k !== 1).forEach((row, k) => {
    const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
    const cell = k === 0 ? 'th' : 'td';
    out.push(tag('<tr>'));
    for (const c of cells) out.push(tag(`<${cell}>`), ...inline(c.trim()), tag(`</${cell}>`));
    out.push(tag('</tr>'));
  });
  return out;
}

function blockTokens(b) {
  if (b.type === 'code') return textTokens(b.source);
  if (b.type === 'rule') return [];
  if (b.type === 'table') return tableTokens(b.source);
  return inline(b.source);
}

function prepare(md) {
  return parse(md).map(b => {
    const tokens = blockTokens(b);
    return {
      ...b,
      tokens,
      text: tokens.filter(t => t.t === 'txt').map(t => t.v).join(''),
      key: [b.type, b.level || 0, b.ordered ? 1 : 0, b.number || '', b.source].join('|'),
    };
  });
}

const latestVersion = () => st.doc.versions[st.doc.versions.length - 1].number;
const versionData = n => st.doc.versions.find(v => v.number === n);

function blocksOf(n) {
  if (!st.parsed.has(n)) st.parsed.set(n, prepare(versionData(n).text));
  return st.parsed.get(n);
}

// ---------- HTML ----------

const tokensHtml = tokens => tokens.map(t => (t.t === 'tag' ? t.v : esc(t.v))).join('');

function wrap(b, inner, attrs = '', cls = '') {
  const c = cls ? ` class="${cls}"` : '';
  switch (b.type) {
    case 'heading': return `<h${b.level}${attrs}${c}>${inner}</h${b.level}>`;
    case 'item': {
      const value = b.ordered ? ` value="${b.number}"` : '';
      return `<li${attrs} class="level-${b.level}${cls ? ' ' + cls : ''}"${value}>${inner}</li>`;
    }
    case 'quote': return `<blockquote${attrs}${c}>${inner}</blockquote>`;
    case 'code': return `<pre${attrs}${c}><code>${inner}</code></pre>`;
    case 'rule': return `<hr${attrs}${c}>`;
    case 'table': return `<table${attrs}${c}><tbody>${inner}</tbody></table>`;
    default: return `<p${attrs}${c}>${inner}</p>`;
  }
}

function assemble(parts) {
  let out = '';
  let list = null;
  for (const p of parts) {
    const kind = p.b.type === 'item' ? (p.b.ordered ? 'ol' : 'ul') : null;
    if (kind !== list) {
      if (list) out += `</${list}>`;
      if (kind) out += `<${kind}>`;
      list = kind;
    }
    out += p.html;
  }
  if (list) out += `</${list}>`;
  return out;
}

// ---------- comparing versions ----------

function lcsPairs(a, b, equal) {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = equal(a[i], b[j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (equal(a[i], b[j])) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

function diffTokens(a, b) {
  const pairs = lcsPairs(a, b, (x, y) => x.t === y.t && x.v === y.v);
  const ops = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
    while (i < pi) ops.push({ op: '-', tok: a[i++] });
    while (j < pj) ops.push({ op: '+', tok: b[j++] });
    if (pi < a.length) { ops.push({ op: '=', tok: b[pj] }); i++; j++; }
  }
  return cleanup(ops);
}

// Fold short equal runs between two changes (a space, a comma, one short word
// like "in" or "was") into the change, so it reads "old -> new" instead of chopped words.
function cleanup(ops) {
  const runs = [];
  for (const o of ops) {
    const kind = o.op === '=' ? '=' : 'x';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.ops.push(o);
    else runs.push({ kind, ops: [o] });
  }
  for (let k = 1; k < runs.length - 1; k++) {
    const r = runs[k];
    if (r.kind !== '=' || runs[k - 1].kind !== 'x' || runs[k + 1].kind !== 'x') continue;
    if (r.ops.some(o => o.tok.t === 'tag')) continue;
    const text = r.ops.map(o => o.tok.v).join('');
    const words = r.ops.filter(o => /[\p{L}\p{N}]/u.test(o.tok.v)).length;
    if (/^[\s\p{P}]*$/u.test(text) || (words <= 1 && text.trim().length <= 4)) {
      r.kind = 'x';
      r.ops = [...r.ops.map(o => ({ op: '-', tok: o.tok })), ...r.ops.map(o => ({ op: '+', tok: o.tok }))];
    }
  }
  const out = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    out.push(...group.filter(o => o.op === '-'), ...group.filter(o => o.op === '+'));
    group = null;
  };
  for (const r of runs) {
    if (r.kind === 'x') { group = (group || []).concat(r.ops); continue; }
    flush();
    out.push(...r.ops);
  }
  flush();
  return out;
}

function similarity(a, b) {
  const words = x => new Set(x.tokens.filter(t => t.t === 'txt' && /[\p{L}\p{N}]/u.test(t.v)).map(t => t.v.toLowerCase()));
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return 1;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size);
}

function pairGaps(oldBlocks, newBlocks, oldGap, newGap) {
  const out = [];
  let jn = 0;
  for (const si of oldGap) {
    let found = -1;
    for (let k = jn; k < newGap.length; k++) {
      if (oldBlocks[si].type === newBlocks[newGap[k]].type && similarity(oldBlocks[si], newBlocks[newGap[k]]) >= 0.3) { found = k; break; }
    }
    if (found === -1) { out.push({ kind: '-', s: si }); continue; }
    for (let k = jn; k < found; k++) out.push({ kind: '+', n: newGap[k] });
    out.push({ kind: '~', s: si, n: newGap[found] });
    jn = found + 1;
  }
  for (let k = jn; k < newGap.length; k++) out.push({ kind: '+', n: newGap[k] });
  return out;
}

function diffDocument(oldBlocks, newBlocks) {
  const pairs = lcsPairs(oldBlocks, newBlocks, (x, y) => x.key === y.key);
  const out = [];
  let i = 0, j = 0;
  const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);
  for (const [pi, pj] of [...pairs, [oldBlocks.length, newBlocks.length]]) {
    out.push(...pairGaps(oldBlocks, newBlocks, range(i, pi), range(j, pj)));
    if (pi < oldBlocks.length) out.push({ kind: '=', s: pi, n: pj });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

// A change inside a block: deleted and inserted words. Markup (bold, links) always
// comes from the new version, so the HTML is always correctly nested.
function changeHtml(ops, oldBlock, newChange) {
  let out = '', char = 0, h = null, kind = null, buf = '';
  const close = () => {
    if (kind) out += `<${kind} data-h="${h.id}">${buf}</${kind}>`;
    kind = null;
    buf = '';
  };
  for (const o of ops) {
    if (o.op === '=') {
      close();
      if (h) { h.end = { block: oldBlock, char }; h = null; }
      out += o.tok.t === 'tag' ? o.tok.v : esc(o.tok.v);
      if (o.tok.t === 'txt') char += o.tok.v.length;
      continue;
    }
    if (!h) h = newChange({ block: oldBlock, char }, { block: oldBlock, char });
    if (o.tok.t === 'tag') {
      close();
      if (o.op === '+') out += o.tok.v;
      continue;
    }
    const wanted = o.op === '-' ? 'del' : 'ins';
    if (kind !== wanted) { close(); kind = wanted; }
    buf += esc(o.tok.v);
    if (o.op === '-') char += o.tok.v.length;
  }
  close();
  if (h) h.end = { block: oldBlock, char };
  return out;
}

function computeChanges(v) {
  const oldBlocks = blocksOf(v - 1), newBlocks = blocksOf(v);
  const changes = [];
  const newChange = (start, end) => {
    const h = { id: `h${changes.length + 1}`, start, end };
    changes.push(h);
    return h;
  };
  const parts = [];
  let lastOld = -1;
  for (const p of diffDocument(oldBlocks, newBlocks)) {
    if (p.kind === '=') {
      lastOld = p.s;
      parts.push({ b: newBlocks[p.n], html: wrap(newBlocks[p.n], tokensHtml(newBlocks[p.n].tokens), ` data-block="${p.n}"`) });
    } else if (p.kind === '-') {
      const b = oldBlocks[p.s];
      lastOld = p.s;
      const h = newChange({ block: p.s, char: 0 }, { block: p.s, char: b.text.length });
      parts.push({ b, html: wrap(b, tokensHtml(b.tokens), ` data-h="${h.id}"`, 'block-deleted') });
    } else if (p.kind === '+') {
      const b = newBlocks[p.n];
      const pos = lastOld >= 0 ? { block: lastOld, char: oldBlocks[lastOld].text.length } : { block: 0, char: 0 };
      const h = newChange(pos, { ...pos });
      parts.push({ b, html: wrap(b, tokensHtml(b.tokens), ` data-h="${h.id}" data-block="${p.n}"`, 'block-added') });
    } else {
      lastOld = p.s;
      const ops = diffTokens(oldBlocks[p.s].tokens, newBlocks[p.n].tokens);
      parts.push({ b: newBlocks[p.n], html: wrap(newBlocks[p.n], changeHtml(ops, p.s, newChange), ` data-block="${p.n}"`) });
    }
  }
  return { html: assemble(parts), changes };
}

// ---------- comments on the text ----------

// Where a comment sits in the version it was left on: exact positions from a mouse
// selection, or, for Claude's comments, the quote (and its nth occurrence).
function commentRange(c, blocks) {
  if (c.start && c.end) {
    if (c.end.block >= blocks.length) return null;
    return { start: c.start, end: c.end };
  }
  if (!c.quote) return null;
  const nth = c.nth || 1;
  let count = 0;
  for (let i = 0; i < blocks.length; i++) {
    let from = 0, idx;
    while ((idx = blocks[i].text.indexOf(c.quote, from)) !== -1) {
      if (++count === nth) return { start: { block: i, char: idx }, end: { block: i, char: idx + c.quote.length } };
      from = idx + 1;
    }
  }
  return null;
}

// An insertion right after the commented text often starts with a space; spaces at
// the edges of a comment count as part of it, so such a change links to it.
function widenOverSpaces(r, blocks) {
  if (!r) return null;
  const start = { ...r.start }, end = { ...r.end };
  const a = blocks[start.block].text, b = blocks[end.block].text;
  while (start.char > 0 && /\s/.test(a[start.char - 1])) start.char--;
  while (end.char < b.length && /\s/.test(b[end.char])) end.char++;
  return { start, end };
}

// In the changes view, deleted text (<del>) is not part of the latest version, so it is not counted.
const isDeleted = t => !!t.parentElement.closest('del');

// How many characters of the latest version the block holds up to a selection point.
function lengthTo(blockEl, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(blockEl);
  try { r.setEnd(node, offset); } catch { return null; }
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let n = 0, t;
  while ((t = walker.nextNode())) {
    if (t === node) { if (!isDeleted(t)) n += offset; break; }
    if (!r.intersectsNode(t)) break;
    if (!isDeleted(t)) n += t.nodeValue.length;
  }
  return n;
}

function highlight(blockEl, s, e, cls, id) {
  if (!blockEl || e <= s) return;
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  const parts = [];
  let pos = 0, n;
  while ((n = walker.nextNode())) {
    if (isDeleted(n)) continue;
    const len = n.nodeValue.length;
    const a = Math.max(s, pos), b = Math.min(e, pos + len);
    if (a < b) parts.push([n, a - pos, b - pos]);
    pos += len;
    if (pos >= e) break;
  }
  for (const [node, a, b] of parts) {
    let target = node;
    if (b < target.nodeValue.length) target.splitText(b);
    if (a > 0) target = target.splitText(a);
    const mark = document.createElement('mark');
    mark.className = cls;
    mark.dataset.c = id;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

function highlightRange(r, blocks, cls, id) {
  for (let i = r.start.block; i <= r.end.block; i++) {
    const s = i === r.start.block ? r.start.char : 0;
    const e = i === r.end.block ? r.end.char : blocks[i].text.length;
    highlight(el('document').querySelector(`[data-block="${i}"]`), s, e, cls, id);
  }
}

function rangeText(start, end, blocks) {
  const parts = [];
  for (let i = start.block; i <= end.block; i++) {
    parts.push(blocks[i].text.slice(i === start.block ? start.char : 0, i === end.block ? end.char : undefined));
  }
  return parts.join('\n');
}

const waitsForClaude = c => {
  if (c.status !== 'open') return false;
  const r = c.replies || [];
  return (r.length ? r[r.length - 1].author : c.author) === 'user';
};

// ---------- views ----------

function showText() {
  const blocks = blocksOf(st.version);
  const html = assemble(blocks.map((b, i) => ({ b, html: wrap(b, tokensHtml(b.tokens), ` data-block="${i}"`) })));
  el('document').innerHTML = `<div class="paper">${html}</div>`;
  for (const c of st.doc.comments.filter(x => x.version === st.version)) {
    const r = commentRange(c, blocks);
    if (r) highlightRange(r, blocks, `c ${c.status}`, c.id);
  }
}

function showChanges() {
  const v = st.version;
  const { html, changes } = computeChanges(v);
  el('document').innerHTML = `<div class="paper">${html}</div>`;
  const relevant = st.doc.comments.filter(c => c.version === v - 1 || c.resolved_in === v);
  const oldBlocks = blocksOf(v - 1);
  const links = new Map();
  const covered = new Set();
  for (const c of relevant) {
    if (c.version !== v - 1) continue;
    const r = widenOverSpaces(commentRange(c, oldBlocks), oldBlocks);
    const ids = [];
    if (r) {
      for (const h of changes) {
        if (cmp(h.start, r.end) <= 0 && cmp(h.end, r.start) >= 0) { ids.push(h.id); covered.add(h.id); }
      }
    }
    links.set(c.id, ids);
  }
  const uncommented = changes.map(h => h.id).filter(id => !covered.has(id) && el('document').querySelector(`[data-h="${id}"]`));
  for (const id of uncommented) el('document').querySelectorAll(`[data-h="${id}"]`).forEach(e => e.classList.add('uncommented'));
  const newBlocks = blocksOf(v);
  for (const c of st.doc.comments.filter(x => x.version === v)) {
    const r = commentRange(c, newBlocks);
    if (r) highlightRange(r, newBlocks, `c ${c.status}`, c.id);
  }
  st.changes = { changes, links, uncommented, relevant };
  st.uncommentedIndex = 0;
}

function card(c, { subtitle = '', warning = '', changes = null } = {}) {
  const name = a => (a === 'claude' ? 'Claude' : 'You');
  const messages = [{ author: c.author, text: c.text }, ...(c.replies || [])]
    .map(m => `<div class="message ${m.author}"><b>${name(m.author)}:</b> ${esc(m.text)}</div>`).join('');
  const status = { open: 'open', resolved: `resolved${c.resolved_in ? ' in v' + c.resolved_in : ''}`, rejected: 'rejected' }[c.status] || c.status;
  const changeCount = changes && changes.length ? ` · ${changes.length} ${plural(changes.length, 'change', 'changes')}` : '';
  let buttons = '';
  if (c.status === 'open') buttons += '<button data-action="reply">Reply</button>';
  if (c.status === 'open' && c.author === 'user' && !(c.replies || []).length) buttons += '<button data-action="delete">Delete</button>';
  if (c.status !== 'open') buttons += '<button data-action="reopen">Reopen</button>';
  return `<div class="card ${c.status}" data-c="${c.id}"${changes ? ` data-changes="${changes.join(',')}"` : ''}>
    ${subtitle ? `<div class="status">${esc(subtitle)}</div>` : ''}
    <div class="quote">“${esc(shorten(c.quote || '', 140))}”</div>
    ${messages}
    ${warning ? `<div class="warning">${esc(warning)}</div>` : ''}
    <div class="footer"><span class="status">${c.id} · ${status}${changeCount}</span>${buttons}</div>
  </div>`;
}

function sidebarText() {
  const v = st.version, latest = latestVersion();
  const onVersion = st.doc.comments.filter(c => c.version === v);
  const open = onVersion.filter(c => c.status === 'open');
  const closed = onVersion.filter(c => c.status !== 'open');
  const fromEarlier = v === latest ? st.doc.comments.filter(c => c.version < v && c.status === 'open') : [];
  let h = `<h3>Open comments (${open.length + fromEarlier.length})</h3>`;
  if (!open.length && !fromEarlier.length) {
    h += `<p class="empty">${v === latest ? 'Select text with the mouse and click Comment.' : `This is an older version. Comments go on the latest, v${latest}.`}</p>`;
  }
  h += open.map(c => card(c)).join('');
  h += fromEarlier.map(c => card(c, { subtitle: `from v${c.version}, not marked in this version` })).join('');
  if (closed.length) {
    h += `<details><summary>Resolved and rejected (${closed.length})</summary>${closed.map(c => card(c)).join('')}</details>`;
  }
  el('sidebar').innerHTML = h;
}

function sidebarChanges() {
  const v = st.version;
  const { links, uncommented, relevant } = st.changes;
  const note = versionData(v).note;
  const latest = v === latestVersion();
  const onVersion = st.doc.comments.filter(c => c.version === v);
  const openHere = onVersion.filter(c => c.status === 'open');
  const closedHere = onVersion.filter(c => c.status !== 'open');
  let h = '';
  if (openHere.length) {
    h += `<h3>Open comments on v${v} (${openHere.length})</h3>${openHere.map(c => card(c)).join('')}`;
  } else if (latest) {
    h += '<p class="empty">To add a comment, select text with the mouse, here or in the Text view.</p>';
  }
  if (note) h += `<div class="version-note"><b>Claude on v${v}</b>${esc(note)}</div>`;
  h += `<h3>Comments from v${v - 1} (${relevant.length})</h3>`;
  if (!relevant.length) h += '<p class="empty">The previous version had no comments.</p>';
  for (const c of relevant) {
    const changes = links.get(c.id) || null;
    let warning = '';
    if (c.status === 'open') warning = 'Still open: not resolved in this version.';
    else if (c.status === 'resolved' && changes && !changes.length) warning = 'No change at that spot.';
    h += card(c, { warning, changes });
  }
  if (uncommented.length) {
    h += `<div class="card uncommented-card" data-uncommented="1"><b>Changes without your comment: ${uncommented.length}</b>
      <div class="message">Claude changed these in places you did not comment on. Dashed orange in the text; click for the next one.</div></div>`;
  }
  if (closedHere.length) {
    h += `<details><summary>Resolved comments on v${v} (${closedHere.length})</summary>${closedHere.map(c => card(c)).join('')}</details>`;
  }
  el('sidebar').innerHTML = h;
}

function header() {
  const d = st.doc;
  const versions = d.versions.map(v => `<button data-version="${v.number}" class="${v.number === st.version ? 'active' : ''}">v${v.number}</button>`).join('');
  const changesLabel = st.version > 1 ? `Changes v${st.version - 1} → v${st.version}` : 'Changes';
  el('header').innerHTML = `
    <div class="title"><a href="#/">Text review</a> / ${esc(d.title)}${d.source ? ` <span class="source">· ${esc(d.source)}</span>` : ''}</div>
    <div class="group">${versions}</div>
    <div class="group">
      <button data-view="text" class="${st.view === 'text' ? 'active' : ''}">Text</button>
      <button data-view="changes" class="${st.view === 'changes' ? 'active' : ''}"${st.version === 1 ? ' disabled' : ''}>${changesLabel}</button>
    </div>
    <div class="group" id="handoff">${handoffHtml()}</div>`;
}

// Send to Claude: the button wakes the Claude session that runs `review.py wait`.
function handoffHtml() {
  const n = st.doc.comments.filter(waitsForClaude).length;
  if (st.handoff === 'listening') {
    return n
      ? `<button data-action="send" class="primary">Send to Claude (${n})</button>`
      : '<button disabled title="No comments waiting for Claude">Send to Claude</button>';
  }
  if (st.handoff === 'sent') return '<span class="handoff-state">Sent…</span>';
  if (st.handoff === 'working') return '<span class="handoff-state">Claude is working on it…</span>';
  return n ? '<span class="handoff-state">Claude isn\'t listening: tell Claude in chat to check the comments.</span>' : '';
}

function updateHandoff() {
  if (el('handoff')) el('handoff').innerHTML = handoffHtml();
}

async function sendToClaude() {
  if (isWriting()) return toast('Save or cancel your comment first.');
  if (await send('POST', '/submit', {})) {
    st.handoff = 'sent';
    updateHandoff();
    toast('Sent to Claude');
  }
}

function render() {
  const y = window.scrollY, ySidebar = el('sidebar').scrollTop;
  hideButton();
  el('sidebar').hidden = false;
  header();
  if (st.view === 'changes' && st.version > 1) {
    showChanges();
    sidebarChanges();
  } else {
    st.view = 'text';
    showText();
    sidebarText();
  }
  window.scrollTo(0, y);
  el('sidebar').scrollTop = ySidebar;
  const hash = `#/${st.slug}/v${st.version}/${st.view}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

async function showList() {
  st.slug = null;
  st.doc = null;
  const items = await (await fetch(API)).json();
  el('header').innerHTML = '<div class="title">Text review</div>';
  el('sidebar').hidden = true;
  el('document').innerHTML = `<div class="doc-list">${items.length
    ? items.map(d => `<a href="#/${d.slug}"><b>${esc(d.title)}</b><br><small>${d.versions} ${plural(d.versions, 'version', 'versions')} · ${d.open} open ${plural(d.open, 'comment', 'comments')}</small></a>`).join('')
    : '<p class="empty">No documents yet.</p>'}</div>`;
}

// ---------- data ----------

async function load() {
  const r = await fetch(`${API}/${st.slug}`);
  if (!r.ok) {
    el('header').innerHTML = '<div class="title"><a href="#/">Text review</a></div>';
    el('document').innerHTML = '<p class="empty">No such document.</p>';
    el('sidebar').hidden = true;
    return;
  }
  const previousLatest = st.doc && st.doc.slug === st.slug ? latestVersion() : null;
  st.doc = await r.json();
  st.rev = st.doc.rev;
  st.handoff = st.doc.handoff;
  st.parsed.clear();
  const latest = latestVersion();
  if (previousLatest && latest > previousLatest && st.version === previousLatest) {
    st.version = latest;
    st.view = 'changes';
    toast(`New version v${latest}`);
  }
  if (!st.version || st.version > latest) st.version = latest;
  render();
}

const isWriting = () => !el('composer').hidden || [...el('sidebar').querySelectorAll('textarea')].some(t => t.value.trim() || t === document.activeElement);

async function poll() {
  if (!st.slug || !st.doc) return;
  try {
    const { rev, handoff } = await (await fetch(`${API}/${st.slug}/rev`)).json();
    if (handoff !== st.handoff) {
      st.handoff = handoff;
      updateHandoff();
    }
    if (rev !== st.rev && !isWriting()) await load();
  } catch { /* server stopped; try again */ }
}

async function send(method, path, body) {
  const r = await fetch(`${API}/${st.slug}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let message = 'Error';
    try { message = (await r.json()).error || message; } catch { /* not JSON */ }
    toast(message);
    return false;
  }
  return true;
}

// ---------- selecting text and writing a comment ----------

function point(node, offset) {
  const e = (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-block]');
  if (e) {
    const char = lengthTo(e, node, offset);
    return char === null ? null : { block: +e.dataset.block, char };
  }
  if (node.nodeType !== 1) return null;
  const child = node.childNodes[offset];
  const next = child && child.nodeType === 1 && (child.matches('[data-block]') ? child : child.querySelector('[data-block]'));
  if (next) return { block: +next.dataset.block, char: 0 };
  const all = node.querySelectorAll('[data-block]');
  const last = all[all.length - 1];
  if (last && offset >= node.childNodes.length) return { block: +last.dataset.block, char: lengthTo(last, last, last.childNodes.length) };
  return null;
}

function hideButton() { el('comment-btn').hidden = true; }

function handleSelection() {
  hideButton();
  if (!st.doc || !el('composer').hidden) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const paper = el('document').querySelector('.paper');
  if (!paper || !paper.contains(r.commonAncestorContainer)) return;
  if (st.version !== latestVersion()) {
    toast(`This is an older version. Comments go on the latest, v${latestVersion()}.`);
    return;
  }
  const a = point(r.startContainer, r.startOffset);
  let b = point(r.endContainer, r.endOffset);
  if (!a || !b) return;
  const blocks = blocksOf(st.version);
  if (b.char === 0 && b.block > a.block) b = { block: b.block - 1, char: blocks[b.block - 1].text.length };
  const start = { ...a }, end = { ...b };
  while (cmp(start, end) < 0 && start.char < blocks[start.block].text.length && /\s/.test(blocks[start.block].text[start.char])) start.char++;
  while (cmp(start, end) < 0 && end.char > 0 && /\s/.test(blocks[end.block].text[end.char - 1])) end.char--;
  if (cmp(start, end) >= 0) return;
  const quote = rangeText(start, end, blocks);
  if (!quote.trim()) return;
  st.selection = {
    start,
    end,
    quote,
    before: blocks[start.block].text.slice(Math.max(0, start.char - 80), start.char),
    after: blocks[end.block].text.slice(end.char, end.char + 80),
  };
  const rect = r.getBoundingClientRect();
  const btn = el('comment-btn');
  btn.hidden = false;
  btn.style.top = `${window.scrollY + rect.bottom + 6}px`;
  btn.style.left = `${window.scrollX + Math.max(8, Math.min(rect.left, window.innerWidth - 130))}px`;
}

function openComposer() {
  if (!st.selection) return;
  const btn = el('comment-btn'), c = el('composer');
  c.querySelector('.composer-quote').textContent = `“${shorten(st.selection.quote, 200)}”`;
  c.querySelector('textarea').value = '';
  c.querySelector('textarea').style.height = '';
  c.style.top = btn.style.top;
  c.style.left = `${Math.max(8, Math.min(parseFloat(btn.style.left), window.scrollX + window.innerWidth - 356))}px`;
  c.hidden = false;
  hideButton();
  // temporary highlight so the commented text stays visible once the selection is gone
  highlightRange({ start: st.selection.start, end: st.selection.end }, blocksOf(st.version), 'c highlighted pending', 'new');
  window.getSelection().removeAllRanges();
  c.querySelector('textarea').focus();
}

function closeComposer() {
  el('composer').hidden = true;
  st.selection = null;
  el('document').querySelectorAll('mark.pending').forEach(m => m.replaceWith(...m.childNodes));
  el('document').normalize();
}

async function saveComment() {
  const text = el('composer').querySelector('textarea').value.trim();
  if (!text || !st.selection) return;
  if (await send('POST', '/comments', { version: st.version, text, ...st.selection })) {
    closeComposer();
    await load();
    toast('Comment saved');
  }
}

// ---------- highlighting ----------

function emphasize(cid, changeIds = null) {
  document.querySelectorAll('.highlighted:not(.pending)').forEach(e => e.classList.remove('highlighted'));
  document.querySelectorAll('.highlighted-change').forEach(e => e.classList.remove('highlighted-change'));
  if (cid) {
    document.querySelectorAll(`mark.c[data-c="${cid}"]`).forEach(e => e.classList.add('highlighted'));
    const c = el('sidebar').querySelector(`.card[data-c="${cid}"]`);
    if (c) {
      c.classList.add('highlighted');
      if (c.dataset.changes) changeIds = c.dataset.changes.split(',');
    }
  }
  for (const h of changeIds || []) document.querySelectorAll(`[data-h="${h}"]`).forEach(e => e.classList.add('highlighted-change'));
}

function firstTarget(cid, changeIds) {
  if (cid) {
    const m = el('document').querySelector(`mark.c[data-c="${cid}"]`);
    if (m) return m;
  }
  for (const h of changeIds || []) {
    const e = el('document').querySelector(`[data-h="${h}"]`);
    if (e) return e;
  }
  return null;
}

// ---------- events ----------

document.addEventListener('mouseup', e => {
  if (e.target.closest('#composer, #comment-btn, #sidebar, #header')) return;
  setTimeout(handleSelection, 0);
});

document.addEventListener('keyup', e => {
  if (e.shiftKey && e.key.startsWith('Arrow')) handleSelection();
});

el('comment-btn').addEventListener('mousedown', e => e.preventDefault());
el('comment-btn').addEventListener('click', openComposer);
el('composer').querySelector('.save').addEventListener('click', saveComment);
el('composer').querySelector('.cancel').addEventListener('click', closeComposer);
// Enter submits a comment or reply; Shift+Enter inserts a new line.
const isSubmit = e => e.key === 'Enter' && !e.shiftKey && !e.isComposing;
const autoGrow = t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + t.offsetHeight - t.clientHeight + 'px'; };
document.addEventListener('input', e => {
  if (e.target.matches('#composer textarea, #sidebar textarea')) autoGrow(e.target);
});

el('composer').querySelector('textarea').addEventListener('keydown', e => {
  if (isSubmit(e)) { e.preventDefault(); saveComment(); }
  if (e.key === 'Escape') closeComposer();
});

el('header').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.action === 'send') return sendToClaude();
  if (b.dataset.version) {
    st.version = +b.dataset.version;
    if (st.version === 1) st.view = 'text';
  }
  if (b.dataset.view) st.view = b.dataset.view;
  render();
});

el('document').addEventListener('click', e => {
  const m = e.target.closest('mark.c:not(.pending)');
  const h = e.target.closest('[data-h]');
  if (!m && !h) return;
  if (!window.getSelection().isCollapsed) return;
  let c = null;
  if (m) c = el('sidebar').querySelector(`.card[data-c="${m.dataset.c}"]`);
  else {
    c = [...el('sidebar').querySelectorAll('.card[data-changes]')].find(x => x.dataset.changes.split(',').includes(h.dataset.h))
      || el('sidebar').querySelector('.card[data-uncommented]');
  }
  if (c && c.dataset.c) emphasize(c.dataset.c);
  else if (h) { emphasize(null, [h.dataset.h]); c?.classList.add('highlighted'); }
  if (c) {
    c.closest('details')?.setAttribute('open', '');
    c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

el('sidebar').addEventListener('mouseover', e => {
  const c = e.target.closest('.card[data-c]');
  if (c && !c.classList.contains('highlighted')) emphasize(c.dataset.c);
});

el('sidebar').addEventListener('click', async e => {
  const c = e.target.closest('.card');
  if (!c) return;
  const button = e.target.closest('button');
  const cid = c.dataset.c;
  if (button) {
    const action = button.dataset.action;
    if (action === 'reply') {
      if (!c.querySelector('textarea')) {
        c.insertAdjacentHTML('beforeend', `<textarea rows="1" placeholder="Reply · Shift+Enter new line"></textarea>
          <div class="footer"><span class="status"></span><button data-action="cancel-reply">Cancel</button><button data-action="send-reply" class="primary">Send</button></div>`);
      }
      c.querySelector('textarea').focus();
    } else if (action === 'cancel-reply') {
      c.querySelector('textarea').value = '';
      await load();
    } else if (action === 'send-reply') {
      await sendReply(c);
    } else if (action === 'delete') {
      if (await send('DELETE', `/comments/${cid}`)) { await load(); toast('Comment deleted'); }
    } else if (action === 'reopen') {
      if (await send('POST', `/comments/${cid}/reopen`, {})) { await load(); toast('Comment reopened'); }
    }
    return;
  }
  if (e.target.closest('textarea')) return;
  if (c.dataset.uncommented) {
    const ids = st.changes?.uncommented || [];
    if (!ids.length) return;
    const h = ids[st.uncommentedIndex % ids.length];
    st.uncommentedIndex++;
    emphasize(null, [h]);
    c.classList.add('highlighted');
    el('document').querySelector(`[data-h="${h}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  emphasize(cid);
  firstTarget(cid, c.dataset.changes?.split(','))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

el('sidebar').addEventListener('keydown', async e => {
  if (e.target.tagName !== 'TEXTAREA') return;
  if (isSubmit(e)) { e.preventDefault(); await sendReply(e.target.closest('.card')); }
});

async function sendReply(c) {
  const t = c.querySelector('textarea');
  const text = t.value.trim();
  if (!text) return;
  if (await send('POST', `/comments/${c.dataset.c}/replies`, { text })) {
    t.value = '';
    t.blur();
    await load();
    toast('Reply saved');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !el('composer').hidden) closeComposer();
});

// ---------- routing ----------

async function route() {
  const m = location.hash.match(/^#\/([a-z0-9-]+)(?:\/v(\d+))?(?:\/(text|changes))?/);
  closeComposer();
  if (!m) return showList();
  const otherDoc = m[1] !== st.slug;
  st.slug = m[1];
  st.version = m[2] ? +m[2] : (otherDoc ? null : st.version);
  st.view = m[3] || (otherDoc ? 'text' : st.view);
  if (otherDoc || !st.doc) await load();
  else render();
}

window.addEventListener('hashchange', route);
setInterval(poll, 2000);
route();
