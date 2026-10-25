/**
 * Tiny, safe markdown → DOM renderer for model text (Copilot replies). Never uses innerHTML: every piece of
 * model text becomes a Text node. Supports paragraphs, line breaks, #/##/### headings, - / * / • and 1. lists
 * (one level, indented items are folded in), simple | tables |, --- rules, **bold**, *italic*, `code`.
 * Optional `ref` hook turns known tokens (e.g. incident ids) into hoverable spans.
 */

export interface MdOptions {
  /** Regex (global) for tokens to wrap; `refData(token)` returns the data value or null to skip. */
  refPattern?: RegExp;
  refData?: (token: string) => string | null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Inline: `code`, **bold** / __bold__, *italic*, refs. Text only — no links, no HTML. */
function inline(parent: HTMLElement, text: string, opts: MdOptions): void {
  // Tokenise code spans first so their contents are never formatted.
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|(\*[^*\s][^*]*?\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) refs(parent, text.slice(last, m.index), opts);
    const tok = m[0];
    if (m[1]) {
      const c = el('code', 'ag-md__code');
      refs(c, tok.slice(1, -1), opts);
      parent.append(c);
    } else if (m[2]) {
      const b = el('strong');
      inline(b, tok.slice(2, -2), opts);
      parent.append(b);
    } else {
      const i = el('em');
      inline(i, tok.slice(1, -1), opts);
      parent.append(i);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) refs(parent, text.slice(last), opts);
}

function refs(parent: HTMLElement, text: string, opts: MdOptions): void {
  if (!opts.refPattern || !opts.refData) {
    parent.append(document.createTextNode(text));
    return;
  }
  const re = new RegExp(opts.refPattern.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const data = opts.refData(m[0]);
    if (data === null) continue;
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const s = el('span', 'ag-md__ref');
    s.dataset.incident = data;
    s.textContent = m[0];
    parent.append(s);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

const UL = /^\s*[-*•·]\s+(.*)$/;
const OL = /^\s*(\d{1,2})[.)、]\s+(.*)$/;
const HEAD = /^\s{0,3}(#{1,4})\s+(.*)$/;
const RULE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const TABLE = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function renderMarkdown(src: string, opts: MdOptions = {}): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: { el: HTMLOListElement | HTMLUListElement; ordered: boolean; last: HTMLLIElement | null } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const p = el('p');
    para.forEach((l, i) => {
      if (i) p.append(el('br'));
      inline(p, l.trim(), opts);
    });
    out.append(p);
    para = [];
  };
  const closeList = () => {
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    let m: RegExpMatchArray | null;
    if (TABLE.test(line)) {
      flushPara();
      closeList();
      const rows: string[] = [];
      while (i < lines.length && TABLE.test(lines[i])) rows.push(lines[i++]);
      i--;
      const table = el('table', 'ag-md__table');
      let header = true;
      for (const r of rows) {
        if (TABLE_SEP.test(r)) continue;
        const tr = el('tr');
        for (const cell of r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')) {
          const td = el(header ? 'th' : 'td');
          inline(td, cell.trim(), opts);
          tr.append(td);
        }
        table.append(tr);
        header = false;
      }
      out.append(table);
      continue;
    }
    if ((m = line.match(HEAD))) {
      flushPara();
      closeList();
      const hd = el('p', `ag-md__h ag-md__h${m[1].length}`);
      inline(hd, m[2].replace(/\s*#+\s*$/, ''), opts);
      out.append(hd);
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      closeList();
      out.append(el('hr'));
      continue;
    }
    const ul = line.match(UL);
    const ol = ul ? null : line.match(OL);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const indented = /^\s{2,}/.test(line);
      // Indented items under an open list become sub-lines of the previous item (one level only).
      if (indented && list?.last) {
        list.last.append(el('br'));
        const sub = el('span', 'ag-md__sub');
        inline(sub, (ul ? ul[1] : `${ol![1]}. ${ol![2]}`).trim(), opts);
        list.last.append(sub);
        continue;
      }
      if (!list || list.ordered !== ordered) {
        let l: HTMLOListElement | HTMLUListElement;
        if (ordered) {
          const o = el('ol');
          if (ol && ol[1] !== '1') o.start = Number(ol[1]);
          l = o;
        } else l = el('ul');
        out.append(l);
        list = { el: l, ordered, last: null };
      }
      const li = el('li');
      inline(li, (ul ? ul[1] : ol![2]).trim(), opts);
      list.el.append(li);
      list.last = li;
      continue;
    }
    // Continuation line of a list item (lazy markdown).
    if (list?.last && /^\s{2,}\S/.test(line)) {
      list.last.append(document.createTextNode(' '));
      inline(list.last, line.trim(), opts);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  return out;
}

/**
 * Typewriter over already-rendered DOM: blanks every text node and reveals characters in document order.
 * Returns a controller; `finish()` reveals everything immediately (skip).
 */
export function typeOut(root: HTMLElement, durationMs: number, onDone: () => void, onFrame?: () => void): { finish(): void; readonly done: boolean } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { n: Text; text: string }[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push({ n: n as Text, text: (n as Text).data });
  const total = nodes.reduce((a, x) => a + x.text.length, 0);
  let done = false;
  let raf = 0;
  for (const x of nodes) x.n.data = '';
  root.classList.add('is-typing');
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    for (const x of nodes) x.n.data = x.text;
    root.classList.remove('is-typing');
    onFrame?.();
    onDone();
  };
  if (!total || durationMs <= 0) {
    finish();
    return { finish, get done() { return done; } };
  }
  const t0 = performance.now();
  let shown = 0;
  const step = (now: number) => {
    if (done) return;
    const f = Math.min(1, (now - t0) / durationMs);
    const k = Math.round(total * (1 - (1 - f) * (1 - f) * 0.35 - 0.65 * (1 - f)) ); // gentle ease-out
    if (k !== shown) {
      shown = k;
      let left = k;
      for (const x of nodes) {
        const take = Math.max(0, Math.min(x.text.length, left));
        const want = x.text.slice(0, take);
        if (x.n.data !== want) x.n.data = want;
        left -= x.text.length;
      }
      onFrame?.();
    }
    if (f >= 1) finish();
    else raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { finish, get done() { return done; } };
}
