/* EPUB parser: unzips, reads OPF/spine/TOC, sanitises chapters into
 * self-contained HTML strings and scopes the publisher CSS so the reader
 * keeps control of typography (like a Kindle does) while honouring the
 * book's own emphasis, alignment and indentation. */
/* global JSZip */

const IMG_TYPES = /^image\//;
const DROP_TAGS = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'textarea', 'select', 'audio', 'video', 'noscript', 'title', 'head', 'base']);

/* ---------- path helpers ---------- */
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function resolvePath(base, rel) {
  if (!rel) return '';
  try {
    const u = new URL(rel, 'http://book/' + base);
    return decodeURIComponent(u.pathname.slice(1));
  } catch { return rel; }
}
function splitHref(base, href) {
  const [p, frag = ''] = href.split('#');
  return { path: p ? resolvePath(base, p) : base, frag: decodeURIComponent(frag) };
}
const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return new DOMParser().parseFromString(text, 'text/html');
  return doc;
}
function parseMarkup(text) {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}
const byTag = (root, name) => [...root.getElementsByTagNameNS('*', name)];
const epubType = (el) => el.getAttribute('epub:type') || el.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '';

/* ---------- CSS scoping ---------- */
const relLen = /^-?\d*\.?\d+(em|rem|%)$/;
const ALLOW = {
  'text-align': (v) => /^(center|right|end)$/.test(v),
  'font-style': () => true,
  'font-weight': (v) => /^(bold|bolder|[5-9]00)$/.test(v),
  'font-variant-caps': () => true,
  'text-transform': () => true,
  'text-decoration-line': (v) => /^(underline|line-through|none)$/.test(v),
  'vertical-align': (v) => /^(super|sub|baseline|middle|top|bottom|text-top|text-bottom)$/.test(v),
  'font-size': (v) => relLen.test(v) || /^(smaller|larger|small|x-small|xx-small|medium|large|x-large)$/.test(v),
  'margin-left': (v) => relLen.test(v) || v === '0px' || v === 'auto',
  'margin-right': (v) => relLen.test(v) || v === '0px' || v === 'auto',
  'padding-left': (v) => relLen.test(v) || v === '0px',
  'text-indent': (v) => relLen.test(v) || v === '0px',
  'letter-spacing': (v) => /em$/.test(v) || v === 'normal',
  'display': (v) => v === 'none',
  'float': (v) => /^(left|right)$/.test(v),
  'width': (v) => /%$/.test(v),
  'clear': () => true,
};
function clampValue(prop, v) {
  const m = v.match(/^(-?\d*\.?\d+)(em|rem|%)$/);
  if (!m) return v;
  let n = parseFloat(m[1]);
  const pct = m[2] === '%';
  if (prop === 'font-size') n = pct ? Math.min(Math.max(n, 60), 200) : Math.min(Math.max(n, 0.6), 2);
  else if (prop.startsWith('margin') || prop === 'padding-left') n = pct ? Math.min(n, 30) : Math.min(n, 4);
  else if (prop === 'text-indent') n = pct ? Math.max(Math.min(n, 15), -15) : Math.max(Math.min(n, 3), -3);
  return n + m[2];
}
function filterDecl(style) {
  const out = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    const test = ALLOW[prop];
    if (!test) continue;
    const v = style.getPropertyValue(prop).trim();
    if (v && test(v)) out.push(`${prop}:${clampValue(prop, v)}`);
  }
  return out.join(';');
}
function scopeSelector(sel) {
  sel = sel.trim();
  if (!sel || sel.includes('@')) return null;
  sel = sel.replace(/^html\b\s*/i, '');
  if (/^body\b/i.test(sel)) sel = sel.replace(/^body/i, '.bk-chapter');
  if (!sel) sel = '.bk-chapter';
  return '.bk-content ' + sel;
}
export function scopeCss(text) {
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(text.replace(/@import[^;]+;/g, '')); } catch { return ''; }
  const out = [];
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue;
    const decl = filterDecl(rule.style);
    if (!decl) continue;
    const sels = rule.selectorText.split(',').map(scopeSelector).filter(Boolean);
    if (sels.length) out.push(`${sels.join(',')}{${decl}}`);
  }
  return out.join('\n');
}

/* ---------- main entry ---------- */
export async function parseEpub(data) {
  const zip = await JSZip.loadAsync(data);
  const files = {};
  const lower = {};
  zip.forEach((p, f) => { if (!f.dir) { files[p] = f; lower[p.toLowerCase()] = f; } });
  const get = (p) => files[p] || lower[p.toLowerCase()];
  const text = async (p) => { const f = get(p); if (!f) throw new Error('Missing file in EPUB: ' + p); return f.async('string'); };

  const container = parseXml(await text('META-INF/container.xml'));
  const opfPath = byTag(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('Not a valid EPUB (no rootfile)');
  const opf = parseXml(await text(opfPath));
  const opfDir = dirname(opfPath);

  const md = byTag(opf, 'metadata')[0] || opf;
  const dc = (n) => byTag(md, n).map((e) => e.textContent.trim()).filter(Boolean);
  const title = dc('title')[0] || 'Untitled';
  let author = dc('creator').join(', ');
  if (/^[^,]+,\s*[^,]+$/.test(author)) { const [l, f] = author.split(/,\s*/); author = `${f} ${l}`; }
  const language = dc('language')[0] || 'en';
  const publisher = dc('publisher')[0] || '';
  const authors = dc('creator');
  const published = dc('date')[0] || '';
  const description = (dc('description')[0] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // Publisher genre tags (BISAC-style "Business & Economics / Marketing", "Self-Help"…); used for auto-categorising.
  const subjects = [...new Set(dc('subject').flatMap((s) => s.split(/\s*[;|]\s*/)).map((s) => s.trim()).filter((s) => s && s.length <= 120))].slice(0, 20);
  const isbn = byTag(md, 'identifier').map((e) => e.textContent.trim())
    .map((v) => v.replace(/^urn:isbn:/i, '').replace(/[\s-]/g, ''))
    .find((v) => /^(97[89]\d{10}|\d{9}[\dX])$/i.test(v)) || '';

  const manifest = {};
  const byPath = {};
  for (const it of byTag(opf, 'item')) {
    const m = {
      id: it.getAttribute('id'),
      path: resolvePath(opfDir, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: (it.getAttribute('properties') || '').split(/\s+/),
    };
    manifest[m.id] = m; byPath[m.path] = m;
  }

  /* images -> blob urls */
  const resources = {};
  const imgItems = Object.values(manifest).filter((m) => IMG_TYPES.test(m.type) && get(m.path));
  await Promise.all(imgItems.map(async (m) => {
    const blob = new Blob([await get(m.path).async('uint8array')], { type: m.type });
    resources[m.path] = URL.createObjectURL(blob);
  }));
  const resUrl = async (p) => {
    if (resources[p]) return resources[p];
    const f = get(p);
    if (!f) return '';
    const ext = p.split('.').pop().toLowerCase();
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream';
    resources[p] = URL.createObjectURL(new Blob([await f.async('uint8array')], { type }));
    return resources[p];
  };

  /* cover */
  let coverPath = Object.values(manifest).find((m) => m.props.includes('cover-image'))?.path;
  if (!coverPath) {
    const metaCover = byTag(md, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const it = metaCover && manifest[metaCover.getAttribute('content')];
    if (it && IMG_TYPES.test(it.type)) coverPath = it.path;
  }
  if (!coverPath) coverPath = imgItems.find((m) => /cover/i.test(m.path))?.path;
  const coverBlob = coverPath && get(coverPath)
    ? new Blob([await get(coverPath).async('uint8array')], { type: byPath[coverPath]?.type || 'image/jpeg' })
    : null;

  /* spine */
  const spineEl = byTag(opf, 'spine')[0];
  const refs = spineEl ? byTag(spineEl, 'itemref') : [];
  const spineItems = refs.map((r) => ({ item: manifest[r.getAttribute('idref')], linear: r.getAttribute('linear') !== 'no' }))
    .filter((s) => s.item && /html|xml/.test(s.item.type) && get(s.item.path));
  const spineIndex = {};
  spineItems.forEach((s, i) => { spineIndex[s.item.path] = i; });

  /* chapters */
  const cssCache = new Map();
  const cssOrder = [];
  const htmlDoc = document.implementation.createHTMLDocument('');
  const scratch = htmlDoc.createElement('div');

  const spine = [];
  for (let i = 0; i < spineItems.length; i++) {
    const path = spineItems[i].item.path;
    const base = path;
    const doc = parseMarkup(await text(path));

    for (const link of [...doc.getElementsByTagName('link')]) {
      if (!/stylesheet/i.test(link.getAttribute('rel') || '')) continue;
      const p = resolvePath(base, link.getAttribute('href'));
      if (!cssCache.has(p) && get(p)) { cssCache.set(p, scopeCss(await text(p))); cssOrder.push(p); }
    }
    for (const st of [...doc.getElementsByTagName('style')]) {
      const key = path + '#style' + cssOrder.length;
      cssCache.set(key, scopeCss(st.textContent)); cssOrder.push(key);
    }

    const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
    const holder = htmlDoc.createElement('div');
    for (const n of [...body.childNodes]) holder.appendChild(htmlDoc.importNode(n, true));

    for (const el of [...holder.querySelectorAll('*')]) {
      const tag = el.localName.toLowerCase();
      if (DROP_TAGS.has(tag)) { el.remove(); continue; }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on')) el.removeAttribute(a.name);
        else if (n === 'style') {
          scratch.setAttribute('style', a.value);
          const d = filterDecl(scratch.style);
          d ? el.setAttribute('style', d) : el.removeAttribute('style');
        } else if (n === 'epub:type' || a.localName === 'type' && a.namespaceURI === 'http://www.idpf.org/2007/ops') {
          el.setAttribute('data-epub-type', a.value); el.removeAttribute(a.name);
        } else if (n === 'class') {
          el.setAttribute('class', a.value);
        }
      }
      if (tag === 'img') {
        const src = el.getAttribute('src');
        if (src && !isExternal(src)) el.setAttribute('src', await resUrl(resolvePath(base, src)));
        el.removeAttribute('width'); el.removeAttribute('height'); el.setAttribute('draggable', 'false');
        el.setAttribute('loading', 'eager');
      } else if (tag === 'image') {
        const href = el.getAttribute('xlink:href') || el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (href && !isExternal(href)) {
          const u = await resUrl(resolvePath(base, href));
          el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u);
          el.setAttribute('href', u);
        }
      } else if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href) {
          if (isExternal(href)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); el.classList.add('bk-ext'); }
          else {
            const t = splitHref(base, href);
            el.removeAttribute('href');
            el.classList.add('bk-link');
            el.dataset.target = `${t.path}#${t.frag}`;
          }
        }
      }
    }

    const bodyClass = body.getAttribute?.('class') || '';
    const html = holder.innerHTML;
    const chars = holder.textContent.length;
    const headTitle = doc.getElementsByTagName('title')[0]?.textContent.trim() || '';
    spine.push({ path, html, chars, bodyClass, linear: spineItems[i].linear, headTitle, title: '' });
  }

  /* toc */
  let toc = [];
  const navItem = Object.values(manifest).find((m) => m.props.includes('nav'));
  if (navItem && get(navItem.path)) {
    const ndoc = parseMarkup(await text(navItem.path));
    const navs = [...ndoc.getElementsByTagName('nav')];
    const nav = navs.find((n) => /toc/.test(epubType(n))) || navs[0];
    const ol = nav && [...nav.children].find((c) => c.localName === 'ol');
    const walk = (list) => [...list.children].filter((c) => c.localName === 'li').map((li) => {
      const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
      const sub = [...li.children].find((c) => c.localName === 'ol');
      const href = a?.getAttribute('href');
      const t = href ? splitHref(navItem.path, href) : { path: '', frag: '' };
      return { label: (a?.textContent || '').replace(/\s+/g, ' ').trim(), ...t, children: sub ? walk(sub) : [] };
    });
    if (ol) toc = walk(ol);
  }
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx = (ncxId && manifest[ncxId]) || Object.values(manifest).find((m) => m.type === 'application/x-dtbncx+xml');
    if (ncx && get(ncx.path)) {
      const ndoc = parseXml(await text(ncx.path));
      const navMap = byTag(ndoc, 'navMap')[0];
      const walk = (el) => [...el.children].filter((c) => c.localName === 'navPoint').map((np) => {
        const label = byTag(np, 'text')[0]?.textContent.replace(/\s+/g, ' ').trim() || '';
        const src = [...np.children].find((c) => c.localName === 'content')?.getAttribute('src') || '';
        return { label, ...splitHref(ncx.path, src), children: walk(np) };
      });
      if (navMap) toc = walk(navMap);
    }
  }
  const annotate = (items, depth) => items.forEach((t) => {
    t.spine = spineIndex[t.path] ?? -1; t.depth = depth; annotate(t.children, depth + 1);
  });
  annotate(toc, 0);
  // assign chapter titles to spine items
  const flat = [];
  const flatten = (items) => items.forEach((t) => { flat.push(t); flatten(t.children); });
  flatten(toc);
  let last = '';
  spine.forEach((s, i) => {
    const hit = flat.find((t) => t.spine === i);
    if (hit) last = hit.label;
    s.title = hit ? hit.label : last || s.headTitle.split(',')[0] || title;
  });

  const css = cssOrder.map((p) => cssCache.get(p)).join('\n');
  let offset = 0;
  spine.forEach((s) => { s.start = offset; offset += s.chars; });

  return {
    title, author, authors, language, publisher, published, description, isbn, subjects,
    coverPath: coverPath && get(coverPath) ? coverPath : '', coverType: (coverPath && byPath[coverPath]?.type) || '',
    css, spine, toc, flatToc: flat, coverBlob, spineIndex,
    totalChars: offset,
    destroy() { Object.values(resources).forEach((u) => URL.revokeObjectURL(u)); },
  };
}

/** Catalogue fields for the library, taken from a parsed book (no binary data). */
export function bookMetadata(book) {
  const { title, author, authors, language, publisher, published, description, isbn, subjects, coverPath, coverType } = book;
  return { title, author, authors, language, publisher, published, description, isbn, subjects, coverPath, coverType };
}

/** Read just the cover image out of an EPUB, using the path parseEpub() resolved. */
export async function readCover(data, coverPath, type = '') {
  if (!coverPath) return null;
  const zip = await JSZip.loadAsync(data);
  const f = zip.file(coverPath) || Object.values(zip.files).find((x) => x.name.toLowerCase() === coverPath.toLowerCase());
  return f ? new Blob([await f.async('uint8array')], { type: type || 'image/jpeg' }) : null;
}

export async function bookId(buffer) {
  const h = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(h)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}
