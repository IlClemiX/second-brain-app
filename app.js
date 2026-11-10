'use strict';
/*
 * Second Brain: inserimento e lettura delle note di un vault su GitHub.
 * Nessuna libreria esterna. La pagina parla solo con api.github.com.
 * La chiave d'accesso resta nel localStorage di questo dispositivo.
 */

const API = 'https://api.github.com';
const BRANCH = 'main';
const INBOX = '00 Inbox';
const ATTACH_DIR = '_allegati';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2000;
const LS = { token: 'sb.token', repo: 'sb.repo', draft: 'sb.draft', last: 'sb.last' };

const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* spazio pieno o bloccato */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* niente */ } },
};

const cfg = { token: store.get(LS.token) || '', repo: store.get(LS.repo) || '' };
let tree = null;                 // [{path, sha, size}]
const textCache = new Map();     // sha -> testo
let allTextLoaded = false;
let pending = [];                // allegati in attesa: [{name, bytes}]
let busy = false;

/* ---------- utilita' ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function nowHM() { const d = new Date(); return pad(d.getHours()) + pad(d.getMinutes()); }
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function baseName(p) { return p.slice(p.lastIndexOf('/') + 1); }
function extOf(p) { const b = baseName(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }
function stripExt(n) { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; }
function isMd(p) { return extOf(p) === 'md'; }

function safeName(s, max) {
  let t = String(s).replace(/[\\/:*?"<>|#^\[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[. ]+$/, '');
  if (t.length > (max || 80)) t = t.slice(0, max || 80).trim();
  return t;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function mimeOf(p) { return MIME[extOf(p)] || 'application/octet-stream'; }
function isImagePath(p) { return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extOf(p)); }

function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function textToB64(t) { return bytesToB64(new TextEncoder().encode(t)); }
function b64ToText(b64) { return new TextDecoder().decode(b64ToBytes(b64)); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function setMsg(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

/* ---------- GitHub ---------- */

function repoPath() { return '/repos/' + cfg.repo; }

async function gh(path, opts) {
  const o = opts || {};
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + (o.token || cfg.token),
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (o.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method: o.method || 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok) {
    const err = new Error('GitHub ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function explain(e) {
  if (e instanceof TypeError) return 'Nessuna connessione a GitHub. Controlla la rete e riprova.';
  switch (e.status) {
    case 401: return 'La chiave non è valida o è scaduta. Aggiornala nelle impostazioni.';
    case 403: return 'La chiave non ha il permesso necessario (serve "Contents: Read and write").';
    case 404: return 'Repository non trovato, oppure la chiave non vi ha accesso.';
    case 409:
    case 422: return 'Il vault è cambiato nel frattempo. Riprova tra qualche secondo.';
    default: return e.status ? 'Errore di GitHub (' + e.status + '). Riprova.' : (e.message || 'Errore imprevisto.');
  }
}

async function ensureTree(force) {
  if (tree && !force) return tree;
  const data = await gh(repoPath() + '/git/trees/' + BRANCH + '?recursive=1');
  tree = data.tree.filter((t) => t.type === 'blob').map((t) => ({ path: t.path, sha: t.sha, size: t.size }));
  allTextLoaded = false;
  return tree;
}

async function blobB64(sha) {
  const data = await gh(repoPath() + '/git/blobs/' + sha);
  return data.content;
}
async function textOf(entry) {
  if (textCache.has(entry.sha)) return textCache.get(entry.sha);
  const t = b64ToText(await blobB64(entry.sha));
  textCache.set(entry.sha, t);
  return t;
}

function findEntry(name) {
  if (!tree) return null;
  const n = String(name).trim().replace(/^\.?\//, '').toLowerCase();
  if (!n) return null;
  let hit = tree.find((t) => t.path.toLowerCase() === n) || tree.find((t) => t.path.toLowerCase() === n + '.md');
  if (hit) return hit;
  const b = baseName(n);
  return tree.find((t) => baseName(t.path).toLowerCase() === b + '.md') || tree.find((t) => baseName(t.path).toLowerCase() === b) || null;
}

/* Un solo commit con tutti i file (nota + allegati). */
async function commitFiles(files, message) {
  const R = repoPath();
  for (const f of files) {
    if (!f.sha) {
      const blob = await gh(R + '/git/blobs', { method: 'POST', body: { content: f.b64, encoding: 'base64' } });
      f.sha = blob.sha;
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(R + '/git/ref/heads/' + BRANCH);
    const parent = ref.object.sha;
    const parentCommit = await gh(R + '/git/commits/' + parent);
    const newTree = await gh(R + '/git/trees', {
      method: 'POST',
      body: { base_tree: parentCommit.tree.sha, tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha })) },
    });
    const commit = await gh(R + '/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [parent] } });
    try {
      await gh(R + '/git/refs/heads/' + BRANCH, { method: 'PATCH', body: { sha: commit.sha } });
      return commit;
    } catch (e) {
      // qualcun altro (PC o Claude) ha caricato nel frattempo: si riparte dall'ultima versione
      if ((e.status === 422 || e.status === 409) && attempt < 2) continue;
      throw e;
    }
  }
  throw new Error('Non sono riuscito a salvare. Riprova.');
}

/* ---------- Markdown ---------- */

function inline(raw) {
  return raw.split(/(`[^`]+`)/g).map((p) => {
    if (p.length > 2 && p[0] === '`' && p[p.length - 1] === '`') return '<code>' + esc(p.slice(1, -1)) + '</code>';
    let s = esc(p);
    s = s.replace(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (m, t) => '<span class="embed" data-name="' + t.trim() + '">' + t.trim() + '</span>');
    s = s.replace(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, t, a) => '<a class="wl" data-name="' + t.trim() + '">' + (a || t).trim() + '</a>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return s;
  }).join('');
}

const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_TABLE = /^\s*\|.*\|\s*$/;

function renderList(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
    const tag = it.ordered ? 'ol' : 'ul';
    // stesso livello ma tipo diverso (numerato / puntato): e' un elenco nuovo
    if (stack.length && it.indent === stack[stack.length - 1].indent && tag !== stack[stack.length - 1].tag) {
      html += '</li></' + stack.pop().tag + '>';
    }
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      html += '<' + tag + '>';
      stack.push({ indent: it.indent, tag });
    } else {
      html += '</li>';
    }
    let text = it.text;
    const box = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (box) text = (box[1] === ' ' ? '☐ ' : '☑ ') + box[2];
    html += '<li>' + inline(text);
  }
  while (stack.length) html += '</li></' + stack.pop().tag + '>';
  return html;
}

function renderTable(rows) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  let html = '<div class="tablewrap"><table>';
  let body = rows;
  if (rows.length > 1 && /^[\s:|-]+$/.test(rows[1])) {
    html += '<thead><tr>' + cells(rows[0]).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>';
    body = rows.slice(2);
  }
  html += '<tbody>' + body.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
  return html + '</table></div>';
}

function renderMd(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      const chips = [];
      for (let k = 1; k < end; k++) {
        const m = /^([\w-]+):\s*(.*)$/.exec(lines[k]);
        if (m && m[2]) chips.push('<span class="chip">' + esc(m[1]) + ': ' + esc(m[2].replace(/^\[|\]$/g, '')) + '</span>');
      }
      if (chips.length) out.push('<div class="meta">' + chips.join('') + '</div>');
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { i++; continue; }

    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    let m = RE_HEAD.exec(l);
    if (m) {
      const n = Math.min(m[1].length, 3);
      out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>');
      i++;
      continue;
    }
    if (RE_HR.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(inline(lines[i++].replace(/^>\s?/, '')));
      out.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
      continue;
    }
    if (RE_TABLE.test(l)) {
      const rows = [];
      while (i < lines.length && RE_TABLE.test(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }
    if (RE_LIST.test(l)) {
      const items = [];
      while (i < lines.length) {
        const lm = RE_LIST.exec(lines[i]);
        if (lm) {
          items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), text: lm[3] });
          i++;
        } else if (/^\s+\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        } else {
          break;
        }
      }
      out.push(renderList(items));
      continue;
    }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !RE_HEAD.test(lines[i])
      && !RE_HR.test(lines[i]) && !/^>/.test(lines[i]) && !RE_LIST.test(lines[i]) && !RE_TABLE.test(lines[i])) {
      buf.push(inline(lines[i++]));
    }
    out.push('<p>' + buf.join('<br>') + '</p>');
  }
  return out.join('\n');
}

/* Dopo il disegno: collega i [[link]] e carica gli allegati incorporati. */
function hydrate(container) {
  container.querySelectorAll('a.wl').forEach((a) => {
    const entry = findEntry(a.dataset.name);
    if (!entry) { a.classList.add('missing'); a.title = 'Nota non trovata'; return; }
    if (isMd(entry.path)) {
      a.href = '#n/' + encodeURIComponent(entry.path);
    } else {
      a.href = '#';
      a.classList.add('embed-doc');
      a.dataset.attach = entry.path;
    }
  });
  container.querySelectorAll('span.embed').forEach((sp) => {
    const entry = findEntry(sp.dataset.name);
    if (!entry) { sp.textContent = '(allegato non trovato: ' + sp.dataset.name + ')'; return; }
    if (isImagePath(entry.path)) {
      sp.textContent = 'Carico immagine...';
      blobB64(entry.sha).then((b64) => {
        const img = document.createElement('img');
        img.alt = baseName(entry.path);
        img.src = 'data:' + mimeOf(entry.path) + ';base64,' + b64.replace(/\s/g, '');
        sp.replaceWith(img);
      }).catch(() => { sp.textContent = '(immagine non caricata)'; });
    } else if (isMd(entry.path)) {
      const a = document.createElement('a');
      a.href = '#n/' + encodeURIComponent(entry.path);
      a.textContent = stripExt(baseName(entry.path));
      sp.replaceWith(a);
    } else {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'embed-doc';
      a.dataset.attach = entry.path;
      a.textContent = '📎 ' + baseName(entry.path);
      sp.replaceWith(a);
    }
  });
}

async function openAttachment(path) {
  const entry = findEntry(path);
  if (!entry) { toast('Allegato non trovato'); return; }
  toast('Apro ' + baseName(entry.path) + '...');
  try {
    const bytes = b64ToBytes(await blobB64(entry.sha));
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(entry.path) }));
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName(entry.path);
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(explain(e));
  }
}

/* ---------- viste ---------- */

const VIEWS = ['settings', 'hot', 'new', 'notes', 'note'];
function show(view, tab) {
  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== view; });
  const configured = Boolean(cfg.token && cfg.repo);
  $('tabs').hidden = !configured;
  $('btn-refresh').hidden = !configured || view === 'settings' || view === 'new';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  window.scrollTo(0, 0);
}

function renderSettings() {
  const configured = Boolean(cfg.token && cfg.repo);
  show('settings', null);
  $('settings-title').textContent = configured ? 'Impostazioni' : 'Collega il tuo vault';
  $('in-repo').value = cfg.repo;
  $('in-token').value = '';
  $('in-token').placeholder = configured ? 'Già salvata. Scrivi qui solo per cambiarla' : 'github_pat_...';
  $('btn-connect').textContent = configured ? 'Aggiorna collegamento' : 'Collega';
  $('btn-disconnect').hidden = !configured;
  setMsg('settings-msg', '');
}

async function connect() {
  const repo = $('in-repo').value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const token = $('in-token').value.trim() || cfg.token;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { setMsg('settings-msg', 'Scrivi il repository come utente/nome.', 'err'); return; }
  if (!token) { setMsg('settings-msg', 'Incolla la chiave d\'accesso.', 'err'); return; }
  setMsg('settings-msg', 'Controllo il collegamento...');
  $('btn-connect').disabled = true;
  try {
    const info = await gh('/repos/' + repo, { token });
    if (info.private === false) {
      setMsg('settings-msg', 'Questo repository è pubblico: le note sarebbero visibili a tutti. Usa il repository privato del vault.', 'err');
      return;
    }
    cfg.repo = repo;
    cfg.token = token;
    store.set(LS.repo, repo);
    store.set(LS.token, token);
    tree = null;
    textCache.clear();
    $('in-token').value = '';
    toast('Collegato');
    location.hash = '#hot';
  } catch (e) {
    setMsg('settings-msg', explain(e), 'err');
  } finally {
    $('btn-connect').disabled = false;
  }
}

function disconnect() {
  store.del(LS.token);
  store.del(LS.repo);
  store.del(LS.last);
  cfg.token = '';
  cfg.repo = '';
  tree = null;
  textCache.clear();
  renderSettings();
  toast('Dispositivo scollegato');
}

function statusRow(kind, html) {
  return '<div class="row"><span class="dot ' + kind + '"></span><span>' + html + '</span></div>';
}

async function renderHot() {
  show('hot', 'hot');
  const card = $('status-card');
  const body = $('hot-body');
  card.innerHTML = statusRow('none', 'Carico...');
  body.innerHTML = '';
  try {
    await ensureTree(false);
    const rows = [];
    try {
      const commits = await gh(repoPath() + '/commits?per_page=1&sha=' + BRANCH);
      const c = commits[0];
      rows.push(statusRow('', 'Vault aggiornato il <b>' + esc(fmtDate(c.commit.committer.date)) + '</b>: ' + esc(c.commit.message.split('\n')[0])));
    } catch (e) { /* lo stato e' un di piu' */ }
    let last = null;
    try { last = JSON.parse(store.get(LS.last) || 'null'); } catch (e) { last = null; }
    if (last) {
      rows.push(last.ok
        ? statusRow('', 'Ultimo salvataggio da qui: <b>' + esc(fmtDate(last.when)) + '</b>, ' + esc(last.title))
        : statusRow('err', 'Ultimo salvataggio da qui <b>non riuscito</b> (' + esc(fmtDate(last.when)) + '): ' + esc(last.error || '')));
    } else {
      rows.push(statusRow('none', 'Nessuna nota salvata da questo dispositivo.'));
    }
    card.innerHTML = rows.join('');
    const hot = findEntry('hot.md');
    if (hot) {
      body.innerHTML = renderMd(await textOf(hot));
      hydrate(body);
    } else {
      body.innerHTML = '<p class="muted">Nel vault non c\'è il file hot.md.</p>';
    }
  } catch (e) {
    card.innerHTML = statusRow('err', esc(explain(e)));
  }
}

function folderLabel(path) {
  const i = path.indexOf('/');
  return i < 0 ? 'Radice' : path.slice(0, i);
}

function itemLink(entry, snippet) {
  return '<a class="item" href="#n/' + encodeURIComponent(entry.path) + '">' + esc(stripExt(baseName(entry.path)))
    + (snippet ? '<span class="snip">' + snippet + '</span>' : '') + '</a>';
}

function renderFolders() {
  const notes = tree.filter((t) => isMd(t.path) && !t.path.startsWith('.'));
  const groups = new Map();
  notes.forEach((n) => {
    const g = folderLabel(n.path);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  });
  const names = Array.from(groups.keys()).sort((a, b) => (a === 'Radice') - (b === 'Radice') || a.localeCompare(b, 'it'));
  let html = '';
  names.forEach((g) => {
    const list = groups.get(g).sort((a, b) => a.path.localeCompare(b.path, 'it'));
    html += '<details class="folder"' + (g === INBOX ? ' open' : '') + '><summary>' + esc(g) + '<span class="count">' + list.length + '</span></summary>';
    let lastSub = '';
    list.forEach((n) => {
      const parts = n.path.split('/');
      const sub = parts.length > 2 ? parts.slice(1, -1).join(' / ') : '';
      if (sub !== lastSub) { if (sub) html += '<div class="sub">' + esc(sub) + '</div>'; lastSub = sub; }
      html += itemLink(n);
    });
    html += '</details>';
  });
  $('notes-list').innerHTML = html || '<p class="muted">Nessuna nota.</p>';
  $('search-info').textContent = '';
}

async function loadAllText() {
  if (allTextLoaded) return;
  const todo = tree.filter((t) => isMd(t.path) && !textCache.has(t.sha));
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const entry = todo[idx++];
      try { await textOf(entry); } catch (e) { /* una nota in meno nella ricerca */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  allTextLoaded = true;
}

function snippetFor(text, q) {
  const low = text.toLowerCase();
  const at = low.indexOf(q);
  if (at < 0) return '';
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + q.length + 60);
  const cut = text.slice(start, end).replace(/\s+/g, ' ');
  return (start > 0 ? '...' : '') + esc(cut) + (end < text.length ? '...' : '');
}

function renderSearch(q) {
  const notes = tree.filter((t) => isMd(t.path) && !t.path.startsWith('.'));
  const byName = notes.filter((n) => baseName(n.path).toLowerCase().includes(q));
  const seen = new Set(byName.map((n) => n.path));
  let html = byName.map((n) => itemLink(n, esc(folderLabel(n.path)))).join('');
  let inText = 0;
  notes.forEach((n) => {
    if (seen.has(n.path) || !textCache.has(n.sha)) return;
    const snip = snippetFor(textCache.get(n.sha), q);
    if (snip) { html += itemLink(n, snip); inText++; }
  });
  $('notes-list').innerHTML = html ? '<div class="results">' + html + '</div>' : '';
  const total = byName.length + inText;
  $('search-info').textContent = allTextLoaded
    ? (total ? total + (total === 1 ? ' nota trovata' : ' note trovate') : 'Nessuna nota trovata.')
    : 'Cerco anche nel testo delle note...';
}

let searchTimer = null;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (!tree) return;
    const q = $('in-search').value.trim().toLowerCase();
    if (q.length < 2) { renderFolders(); return; }
    renderSearch(q);
    if (!allTextLoaded) {
      await loadAllText();
      if ($('in-search').value.trim().toLowerCase() === q && !$('view-notes').hidden) renderSearch(q);
    }
  }, 250);
}

async function renderNotes() {
  show('notes', 'notes');
  if (!tree) $('notes-list').innerHTML = '<p class="muted">Carico...</p>';
  try {
    await ensureTree(false);
    const q = $('in-search').value.trim().toLowerCase();
    if (q.length >= 2) onSearch(); else renderFolders();
  } catch (e) {
    $('notes-list').innerHTML = '<p class="msg err">' + esc(explain(e)) + '</p>';
  }
}

async function renderNote(path) {
  show('note', 'notes');
  const body = $('note-body');
  $('note-path').textContent = path;
  body.innerHTML = '<p class="muted">Carico...</p>';
  try {
    await ensureTree(false);
    const entry = findEntry(path);
    if (!entry) { body.innerHTML = '<p class="muted">Nota non trovata. Prova ad aggiornare.</p>'; return; }
    let html = renderMd(await textOf(entry));
    if (!/<h1>/.test(html)) html = '<h1>' + esc(stripExt(baseName(entry.path))) + '</h1>' + html;
    body.innerHTML = html;
    hydrate(body);
  } catch (e) {
    body.innerHTML = '<p class="msg err">' + esc(explain(e)) + '</p>';
  }
}

/* ---------- nuova nota ---------- */

function renderNew() {
  show('new', 'new');
  let draft = null;
  try { draft = JSON.parse(store.get(LS.draft) || 'null'); } catch (e) { draft = null; }
  if (draft && !$('in-title').value && !$('in-text').value) {
    $('in-title').value = draft.title || '';
    $('in-text').value = draft.text || '';
  }
  renderPending();
}

function saveDraft() {
  setMsg('new-msg', '');
  store.set(LS.draft, JSON.stringify({ title: $('in-title').value, text: $('in-text').value }));
}

function renderPending() {
  const ul = $('attach-list');
  ul.innerHTML = '';
  pending.forEach((p, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name + ' (' + Math.max(1, Math.round(p.bytes.length / 1024)) + ' KB)';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Togli';
    rm.addEventListener('click', () => { pending.splice(i, 1); renderPending(); });
    li.appendChild(name);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

/* Le foto vengono ridotte e riscritte come JPEG: file piu' leggeri e senza dati di posizione. */
function shrinkImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const fail = () => { URL.revokeObjectURL(url); resolve(null); };
    img.onerror = fail;
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) { resolve(null); return; }
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(() => resolve(null));
        }, 'image/jpeg', 0.85);
      } catch (e) { fail(); }
    };
    img.src = url;
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) { toast(file.name + ': troppo grande (massimo 15 MB)'); continue; }
    let name = file.name || 'allegato';
    let bytes = null;
    const isPhoto = /^image\//.test(file.type) && !/gif|svg/.test(file.type);
    if (isPhoto) {
      bytes = await shrinkImage(file);
      if (bytes) name = stripExt(name) + '.jpg';
    }
    if (!bytes) bytes = new Uint8Array(await file.arrayBuffer());
    pending.push({ name, bytes });
  }
  renderPending();
}

function uniquePath(dir, name, taken) {
  const ext = extOf(name);
  const stem = safeName(stripExt(name), 60) || 'allegato';
  let candidate = dir + '/' + stem + (ext ? '.' + ext : '');
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = dir + '/' + stem + ' ' + (n++) + (ext ? '.' + ext : '');
  taken.add(candidate.toLowerCase());
  return candidate;
}

function buildNote(title, text, attachPaths) {
  const date = today();
  let md = '---\ntype: inbox\ncreated: ' + date + '\ntags: [da-archiviare]\nsource: app Second Brain\n---\n\n# ' + title + '\n';
  if (text) md += '\n' + text + '\n';
  if (attachPaths.length) {
    md += '\n## Allegati\n';
    attachPaths.forEach((p) => { md += '- ' + (isImagePath(p) ? '!' : '') + '[[' + baseName(p) + ']]\n'; });
  }
  md += '\n---\nBack to [[index]]\n';
  return md;
}

async function saveNote() {
  if (busy) return;
  const text = $('in-text').value.replace(/\r\n?/g, '\n').trim();
  let title = safeName($('in-title').value, 80);
  if (!title && text) title = safeName(text.split('\n')[0], 60);
  if (!title && pending.length) title = 'Allegati';
  if (!title) { setMsg('new-msg', 'Scrivi almeno un titolo o un testo.', 'err'); return; }

  busy = true;
  $('btn-save').disabled = true;
  setMsg('new-msg', 'Salvataggio in corso...');
  try {
    await ensureTree(true);
    const taken = new Set(tree.map((t) => t.path.toLowerCase()));
    const date = today();
    let notePath = INBOX + '/' + date + ' ' + title + '.md';
    if (taken.has(notePath.toLowerCase())) notePath = INBOX + '/' + date + ' ' + title + ' ' + nowHM() + '.md';
    taken.add(notePath.toLowerCase());

    const files = [];
    const attachPaths = [];
    pending.forEach((p) => {
      const path = uniquePath(ATTACH_DIR, date + ' ' + nowHM() + ' ' + p.name, taken);
      attachPaths.push(path);
      files.push({ path, b64: bytesToB64(p.bytes) });
    });
    files.push({ path: notePath, b64: textToB64(buildNote(title, text, attachPaths)) });

    await commitFiles(files, 'Nota dall\'app: ' + title);

    store.set(LS.last, JSON.stringify({ ok: true, when: new Date().toISOString(), title }));
    store.del(LS.draft);
    $('in-title').value = '';
    $('in-text').value = '';
    $('in-files').value = '';
    pending = [];
    renderPending();
    tree = null;
    setMsg('new-msg', 'Salvata in ' + notePath, 'ok');
    toast('Nota salvata nel vault');
  } catch (e) {
    const why = explain(e);
    store.set(LS.last, JSON.stringify({ ok: false, when: new Date().toISOString(), title, error: why }));
    setMsg('new-msg', why + ' La nota è ancora qui: non hai perso niente.', 'err');
  } finally {
    busy = false;
    $('btn-save').disabled = false;
  }
}

/* ---------- navigazione ---------- */

function route() {
  const h = location.hash || '';
  if (!cfg.token || !cfg.repo || h === '#impostazioni') { renderSettings(); return; }
  if (h === '#nuova') { renderNew(); return; }
  if (h === '#note') { renderNotes(); return; }
  if (h.indexOf('#n/') === 0) {
    let path = '';
    try { path = decodeURIComponent(h.slice(3)); } catch (e) { path = ''; }
    renderNote(path);
    return;
  }
  renderHot();
}

async function refresh() {
  const btn = $('btn-refresh');
  btn.classList.add('spin');
  tree = null;
  try { await ensureTree(true); } catch (e) { toast(explain(e)); }
  btn.classList.remove('spin');
  route();
}

window.addEventListener('hashchange', route);
$('btn-connect').addEventListener('click', connect);
$('btn-disconnect').addEventListener('click', disconnect);
$('btn-refresh').addEventListener('click', refresh);
$('btn-save').addEventListener('click', saveNote);
$('in-title').addEventListener('input', saveDraft);
$('in-text').addEventListener('input', saveDraft);
$('in-search').addEventListener('input', onSearch);
$('in-files').addEventListener('change', (ev) => { addFiles(ev.target.files).then(() => { ev.target.value = ''; }); });
$('main').addEventListener('click', (ev) => {
  const a = ev.target.closest('a');
  if (!a) return;
  if (a.dataset.attach) { ev.preventDefault(); openAttachment(a.dataset.attach); return; }
  if (a.classList.contains('missing')) { ev.preventDefault(); toast('Nota non trovata'); }
});

route();
