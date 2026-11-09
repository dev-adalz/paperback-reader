/* Auto-categorising books from their metadata — no network, no AI service.
 *
 * Signals, strongest first:
 *   1. Author   — another book by the same author already has a category.
 *   2. Learned  — the words in each category's books (title, publisher subjects,
 *                 description), weighted towards words that are distinctive for
 *                 that category (tf–idf across categories). Grows as you sort books.
 *   3. Seeds    — a few starter keywords per default category, so it works on day one.
 *
 * It only answers when one category clearly wins; otherwise it returns null and
 * the book stays Uncategorized. Pure functions: no DOM, safe to unit-test in Node.
 */

const STOP = new Set(('the and for with your you that this from into how what why are was were will can our their them they his her its not '
  + 'but all any more most about over when who whom which book books guide new edition life one way ways get make made use using also just '
  + 'than then there here been have has had does did out own very much many such each other these those only even every same between '
  + 'through within without while where would could should may might must shall upon via per inc llc ltd press publishing publisher '
  + 'general nonfiction fiction ebook kindle volume vol part read reading reader readers author bestselling bestseller times york world '
  + 'people year years first best now today help self ever never still like know takes take show shows learn reveals').split(' '));

/** Lower-case, strip accents and HTML entities. */
export const fold = (s) => String(s ?? '').replace(/&[a-z]+;/gi, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SUFFIX = /(ations|ation|nesses|ness|ments|ment|ings|ing|isms|ism|ists|ist|ies|es|ed|ly|s)$/;
/** Crude stemmer: one common suffix off, then the first 6 letters (negotiate/negotiation/negotiating → "negoti"). */
const stem = (w) => { const s = w.length > 5 ? w.replace(SUFFIX, '') : w; return (s.length >= 4 ? s : w).slice(0, 6); };

export function tokens(text) {
  return fold(text).split(/[^a-z0-9$]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}

/** Starter keywords for the default categories (matched by name; other categories rely on learning). */
export const SEEDS = {
  'Habits & Productivity': 'habit habits routine routines productivity productive focus focused attention time management discipline procrastination goals deep work success achievement',
  'Communication': 'conversation conversations negotiation negotiating persuasion influence relationships listening talk talking communication communicate conflict connect connection friends',
  'Emotion Mastery': 'emotion emotions emotional feelings anxiety depression mood therapy mental health stress worry cognitive overthinking',
  'Writing': 'writing writer writers prose grammar style craft nonfiction memoir words language editing',
  'Ideas & Content': 'ideas idea viral sticky creativity creative audience share sharing content spread stories storytelling attention products habit-forming',
  'Marketing & Sales': 'marketing sales selling sell offers offer customers customer advertising brand branding business leads startup copywriting entrepreneur entrepreneurs persuasion',
  'Money & Mindset': 'money wealth rich riches finance financial investing invest wealthy income thinking decisions psychology economics',
  'Philosophy & Strategy': 'stoic stoicism philosophy philosopher wisdom strategy war power ancient meditations virtue ego human nature',
  'Purpose & Meaning': 'meaning purpose happiness fulfillment fulfilment spiritual destiny dreams soul courage adlerian',
  'Quitting Porn': 'porn pornography addiction addicted dopamine pleasure craving cravings compulsive quit quitting recovery sobriety',
};

const authorKeys = (b) => [...new Set([...(b.authors || []), ...String(b.author || '').split(/\s*(?:,|;|&|\band\b)\s*/)]
  .map((a) => fold(a).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim())
  .filter((a) => a.length > 3 && a !== 'unknown' && a !== 'anonymous'))];

/** Weighted bag of words for one book. */
function bookVector(b) {
  const v = new Map();
  const add = (text, w) => { for (const t of tokens(text)) v.set(t, (v.get(t) || 0) + w); };
  add(b.title, 3);
  add((b.subjects || []).join(' '), 2);
  add(String(b.description || '').slice(0, 1500), 1);
  return v;
}
const unit = (v) => { let n = 0; for (const x of v.values()) n += x * x; n = Math.sqrt(n) || 1; return new Map([...v].map(([k, x]) => [k, x / n])); };

/**
 * Build a model from books that already have a category.
 * @param {Array} books        catalogue entries (title, author(s), description, subjects)
 * @param {(b) => string|null} categoryOf   the category to learn from, or null to skip the book
 * @param {string[]} categories all category names that can be chosen
 */
export function buildModel(books, categoryOf, categories) {
  const vecs = new Map(categories.map((c) => [c, new Map()]));
  const authors = new Map(); // author key -> Map(category -> count)
  for (const b of books) {
    const c = categoryOf(b);
    if (!c || !vecs.has(c)) continue;
    for (const [t, x] of unit(bookVector(b))) vecs.get(c).set(t, (vecs.get(c).get(t) || 0) + x);
    for (const a of authorKeys(b)) {
      const m = authors.get(a) || new Map();
      m.set(c, (m.get(c) || 0) + 1);
      authors.set(a, m);
    }
  }
  for (const c of categories) {
    if (!SEEDS[c]) continue;
    const v = vecs.get(c);
    for (const t of tokens(SEEDS[c])) v.set(t, (v.get(t) || 0) + 0.6);
  }
  // idf across categories: a word found in every category says nothing.
  const df = new Map();
  for (const v of vecs.values()) for (const t of v.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = categories.length;
  const idf = (t) => Math.log(1 + n / (df.get(t) || n));
  const weighted = new Map([...vecs].map(([c, v]) => [c, unit(new Map([...v].map(([t, x]) => [t, x * idf(t)])))]));
  return { categories, weighted, idf, authors };
}

/**
 * Suggest a category for one book.
 * @returns {{ category: string|null, confidence: number, reason: string, scores: Array }}
 */
export function suggestCategory(model, b, { minScore = 0.08, minLead = 1.25 } = {}) {
  // 1. Same author → same shelf, when that author lives on exactly one shelf.
  for (const a of authorKeys(b)) {
    const m = model.authors.get(a);
    if (m && m.size === 1) return { category: [...m.keys()][0], confidence: 1, reason: 'author', scores: [] };
  }
  // 2+3. Learned words and seeds.
  const v = unit(new Map([...bookVector(b)].map(([t, x]) => [t, x * model.idf(t)])));
  const scores = model.categories.map((c) => {
    const cv = model.weighted.get(c);
    let s = 0;
    for (const [t, x] of v) s += x * (cv.get(t) || 0);
    return [c, s];
  }).sort((p, q) => q[1] - p[1]);
  const [best, second] = scores;
  if (!best || best[1] < minScore) return { category: null, confidence: best?.[1] || 0, reason: 'weak', scores };
  if (second && second[1] > 0 && best[1] / second[1] < minLead) return { category: null, confidence: best[1], reason: 'ambiguous', scores };
  return { category: best[0], confidence: best[1], reason: 'words', scores };
}
