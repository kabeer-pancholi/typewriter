export interface XCell { ch: string; gap?: boolean; b?: boolean; i?: boolean; u?: boolean }
export interface XLine { cells: XCell[]; soft?: XCell[] }
export interface XMetrics { cw: number; left: number; fs: number; pitch: number; cols: number }

const FAMILY = '"JetBrains Mono"';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Drop trailing empty lines. */
function trim(lines: XLine[]): XLine[] {
  let n = lines.length;
  while (n > 0 && lines[n - 1].cells.length === 0) n--;
  return lines.slice(0, n);
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function save(blob: Blob, ext: string, name?: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name ? `${name}.${ext}` : `typewriter-${stamp()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ------------------------------------------------------------------ PNG */

/** Whole document as a PNG: same font, weights, size, pitch and margins as the screen; no rail, pointer or caret. */
export async function exportPng(all: XLine[], m: XMetrics, name?: string): Promise<boolean> {
  const lines = trim(all);
  if (!lines.length) return false;
  const { cw, left: pad, fs, pitch, cols } = m;

  const chars = [...new Set(lines.flatMap((l) => l.cells.map((c) => c.ch)))].join('');
  await Promise.all(
    ['normal', 'italic'].flatMap((s) =>
      ['400', '700'].map((w) => document.fonts.load(`${s} ${w} ${fs}px ${FAMILY}`, chars)),
    ),
  );

  const longest = lines.reduce((n, l) => Math.max(n, l.cells.length), 0);
  const W = Math.ceil(pad * 2 + Math.max(cols, longest) * cw);
  const H = Math.ceil(pad * 2 + lines.length * pitch);
  let s = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
  s = Math.min(s, 16000 / W, 16000 / H, Math.sqrt(16_000_000 / (W * H)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(W * s));
  canvas.height = Math.max(1, Math.floor(H * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);

  const css = getComputedStyle(document.documentElement);
  const paper = css.getPropertyValue('--paper').trim() || '#fff';
  const ink = css.getPropertyValue('--ink').trim() || '#000';
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ink;

  // Place the baseline the way a 1em line box does: glyph box centred in the line.
  const face = (c: XCell) => `${c.i ? 'italic' : 'normal'} ${c.b ? 700 : 400} ${fs}px ${FAMILY}, monospace`;
  ctx.font = face({ ch: 'M' });
  const tm = ctx.measureText('M');
  const asc = tm.fontBoundingBoxAscent ?? fs * 1.02;
  const desc = tm.fontBoundingBoxDescent ?? fs * 0.3;
  const off = (fs - (asc + desc)) / 2 + asc;

  let cur = '';
  lines.forEach((ln, r) => {
    const base = pad + r * pitch + off;
    let ux = -1;
    const flush = (end: number) => {
      if (ux >= 0) {
        ctx.fillRect(pad + ux * cw, base + fs / 6, (end - ux) * cw, Math.max(1, fs / 12));
        ux = -1;
      }
    };
    ln.cells.forEach((c, i) => {
      if (c.u && !c.gap) { if (ux < 0) ux = i; } else flush(i);
      if (c.gap || c.ch === ' ') return;
      const f = face(c);
      if (f !== cur) { ctx.font = f; cur = f; }
      ctx.fillText(c.ch, pad + i * cw, base);
    });
    flush(ln.cells.length);
  });

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return false;
  save(blob, 'png', name);
  return true;
}

/* ----------------------------------------------------------------- DOCX */

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ENT[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');

const F = 'JetBrains Mono';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function run(text: string, c: XCell) {
  const rpr =
    `<w:rPr><w:rFonts w:ascii="${F}" w:hAnsi="${F}" w:eastAsia="${F}" w:cs="${F}"/>` +
    (c.b ? '<w:b/><w:bCs/>' : '') +
    (c.i ? '<w:i/><w:iCs/>' : '') +
    '<w:sz w:val="24"/><w:szCs w:val="24"/>' + // 12pt: 10 characters per inch
    (c.u ? '<w:u w:val="single"/>' : '') +
    '</w:rPr>';
  return `<w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function runs(cells: XCell[]) {
  const same = (a: XCell, b: XCell) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u;
  let out = '';
  let i = 0;
  while (i < cells.length) {
    let j = i + 1;
    while (j < cells.length && same(cells[j], cells[i])) j++;
    out += run(cells.slice(i, j).map((x) => x.ch).join(''), cells[i]);
    i = j;
  }
  return out;
}

export function exportDocx(all: XLine[], pitchK: number, name?: string): boolean {
  const lines = trim(all);
  if (!lines.length) return false;

  // Soft-wrapped lines rejoin into one paragraph; lines ended with Enter stay separate.
  const paras: XCell[][] = [];
  lines.forEach((ln, i) => {
    if (i > 0 && ln.soft !== undefined) paras[paras.length - 1] = paras[paras.length - 1].concat(ln.soft, ln.cells);
    else paras.push(ln.cells);
  });

  const line = Math.round(240 * pitchK); // 12pt = 240 twips
  const body = paras
    .map((p) => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/></w:pPr>${runs(p)}</w:p>`)
    .join('');

  const files: [string, string][] = [
    ['[Content_Types].xml',
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
      '</Types>'],
    ['_rels/.rels',
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'],
    ['word/document.xml',
      `${XML}<w:document xmlns:w="${W_NS}"><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>'],
    ['word/_rels/document.xml.rels',
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' +
      '</Relationships>'],
    ['word/fontTable.xml',
      `${XML}<w:fonts xmlns:w="${W_NS}"><w:font w:name="${F}">` +
      '<w:altName w:val="Courier New"/><w:family w:val="modern"/><w:pitch w:val="fixed"/>' +
      '</w:font></w:fonts>'],
  ];

  save(zip(files), 'docx', name);
  return true;
}

/* ------------------------------------------------- minimal ZIP (stored) */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: [string, string][]): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let cdSize = 0;
  const DATE = 0x21; // 1980-01-01

  for (const [name, text] of files) {
    const nm = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true);      // stored
    lh.setUint16(10, 0, true);
    lh.setUint16(12, DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nm.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nm, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, DATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nm);

    offset += 30 + nm.length + data.length;
    cdSize += 46 + nm.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...parts, ...central, end.buffer], { type: DOCX_MIME });
}