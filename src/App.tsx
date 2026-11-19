import {
  ChangeEvent,
  ClipboardEvent,
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LiquidGlassPointer } from "./LiquidGlassPointer";
import { click } from "./sound";
import { exportDocx, exportPng } from "./export";

const COARSE =
  typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
const HINT = COARSE ? "Tap to type" : "Something to type";
const VISIBLE_LINES = 40;
const TAB = 4;
// Pill size is derived from the character cell so it scales with the type size.
const PILL_CELLS = 8; // width in character cells
const PILL_EM = 1.5; // height in em
// Mobile keyboards report Backspace only as an emptied field, so the input always holds this sentinel.
const SENT = "\u200b";

type Fmt = { b?: boolean; i?: boolean; u?: boolean };
type Cell = { ch: string; gap?: boolean } & Fmt;
type Item = Cell | null; // null = line break
/** `soft` is set on a line that continues the previous one by auto-wrap; it holds the spaces removed at the break. */
interface Line {
  id: number;
  cells: Cell[];
  soft?: Cell[];
}
interface Pos {
  row: number;
  col: number;
}
interface Doc {
  lines: Line[];
  row: number;
  col: number;
  anchor: Pos | null;
}

let uid = 0;
const mk = (cells: Cell[] = []): Line => ({ id: uid++, cells });
const gap = (): Cell => ({ ch: " ", gap: true });
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);
const order = (a: Pos, b: Pos): [Pos, Pos] =>
  a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];

function toItems(text: string, fmt: Fmt): Item[] {
  const out: Item[] = [];
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    if (ch === "\n") out.push(null);
    else if (ch === "\t") for (let i = 0; i < TAB; i++) out.push(gap());
    else if (ch >= " ") out.push({ ch, ...fmt });
  }
  return out;
}

function selRange(d: Doc, r: number): [number, number] | null {
  if (!d.anchor) return null;
  const [s, e] = order(d.anchor, { row: d.row, col: d.col });
  if (r < s.row || r > e.row) return null;
  const len = d.lines[r].cells.length;
  const from = r === s.row ? s.col : 0;
  const to = r === e.row ? e.col : len;
  return from < to ? [from, to] : null;
}

function pick(d: Doc): Cell[][] | null {
  if (!d.anchor) return null;
  const [s, e] = order(d.anchor, { row: d.row, col: d.col });
  if (s.row === e.row && s.col === e.col) return null;
  const out: Cell[][] = [];
  for (let r = s.row; r <= e.row; r++) {
    const cells = d.lines[r].cells;
    out.push(
      cells.slice(r === s.row ? s.col : 0, r === e.row ? e.col : cells.length),
    );
  }
  return out;
}

function toText(rows: Cell[][]): string {
  return rows
    .map((cells) => {
      let s = "";
      let run = 0;
      const flush = () => {
        s += "\t".repeat(Math.floor(run / TAB)) + " ".repeat(run % TAB);
        run = 0;
      };
      for (const c of cells) {
        if (c.gap) run++;
        else {
          flush();
          s += c.ch;
        }
      }
      flush();
      return s;
    })
    .join("\n");
}

function deleteSel(d: Doc): boolean {
  if (!d.anchor) return false;
  const [s, e] = order(d.anchor, { row: d.row, col: d.col });
  d.anchor = null;
  if (s.row === e.row && s.col === e.col) return false;
  const head = d.lines[s.row].cells.slice(0, s.col);
  const tail = d.lines[e.row].cells.slice(e.col);
  d.lines.splice(s.row, e.row - s.row + 1, {
    ...mk([...head, ...tail]),
    soft: d.lines[s.row].soft,
  });
  d.row = s.row;
  d.col = s.col;
  return true;
}

function newline(d: Doc) {
  deleteSel(d);
  const line = d.lines[d.row];
  d.lines[d.row] = { ...line, cells: line.cells.slice(0, d.col) };
  d.lines.splice(d.row + 1, 0, mk(line.cells.slice(d.col))); // a typed break is always a hard break
  d.row++;
  d.col = 0;
}

function insert(d: Doc, items: Item[], cols: number) {
  deleteSel(d);
  for (const it of items) {
    if (!it) {
      newline(d);
      continue;
    }
    const line = d.lines[d.row];
    const atEnd = d.col === line.cells.length;
    if (!atEnd && line.cells.length >= cols) continue; // margin stop
    const cells = line.cells.slice();
    cells.splice(d.col, 0, it);
    d.col++;
    if (cells.length <= cols) {
      d.lines[d.row] = { ...line, cells };
      continue;
    }
    // carriage return at the margin, breaking on a real space when possible
    let i = cells.map((c) => (c.gap ? "\0" : c.ch)).lastIndexOf(" ", cols);
    if (i <= 0) i = cols;
    let rest = cells.slice(i);
    const dropped: Cell[] = [];
    while (rest.length && !rest[0].gap && rest[0].ch === " ") {
      dropped.push(rest[0]);
      rest = rest.slice(1);
    }
    d.lines[d.row] = { ...line, cells: cells.slice(0, i) };
    d.lines.splice(d.row + 1, 0, { ...mk(rest), soft: dropped });
    if (d.col > i) {
      d.row++;
      d.col = Math.max(0, d.col - i - dropped.length);
    }
  }
}

function backspace(d: Doc) {
  if (deleteSel(d)) return;
  const line = d.lines[d.row];
  if (d.col > 0) {
    const cells = line.cells.slice();
    cells.splice(d.col - 1, 1);
    d.lines[d.row] = { ...line, cells };
    d.col--;
  } else if (d.row > 0) {
    const prev = d.lines[d.row - 1];
    d.col = prev.cells.length;
    d.lines.splice(d.row - 1, 2, {
      ...prev,
      cells: [...prev.cells, ...line.cells],
    });
    d.row--;
  }
}

function del(d: Doc) {
  if (deleteSel(d)) return;
  const line = d.lines[d.row];
  if (d.col < line.cells.length) {
    const cells = line.cells.slice();
    cells.splice(d.col, 1);
    d.lines[d.row] = { ...line, cells };
  } else if (d.row < d.lines.length - 1) {
    const next = d.lines[d.row + 1];
    d.lines.splice(d.row, 2, {
      ...line,
      cells: [...line.cells, ...next.cells],
    });
  }
}

function move(d: Doc, k: string, shift: boolean) {
  const sel = d.anchor && (d.anchor.row !== d.row || d.anchor.col !== d.col);
  if (!shift && sel && (k === "ArrowLeft" || k === "ArrowRight")) {
    const [s, e] = order(d.anchor!, { row: d.row, col: d.col });
    const p = k === "ArrowLeft" ? s : e;
    d.row = p.row;
    d.col = p.col;
    d.anchor = null;
    return;
  }
  if (shift) d.anchor ??= { row: d.row, col: d.col };
  else d.anchor = null;
  const len = (r: number) => d.lines[r].cells.length;
  const last = d.lines.length - 1;
  if (k === "ArrowLeft") {
    if (d.col > 0) d.col--;
    else if (d.row > 0) {
      d.row--;
      d.col = len(d.row);
    }
  } else if (k === "ArrowRight") {
    if (d.col < len(d.row)) d.col++;
    else if (d.row < last) {
      d.row++;
      d.col = 0;
    }
  } else if (k === "ArrowUp") {
    if (d.row > 0) {
      d.row--;
      d.col = Math.min(d.col, len(d.row));
    } else d.col = 0;
  } else if (k === "ArrowDown") {
    if (d.row < last) {
      d.row++;
      d.col = Math.min(d.col, len(d.row));
    } else d.col = len(d.row);
  } else if (k === "Home") d.col = 0;
  else d.col = len(d.row);
}

function selectAll(d: Doc) {
  d.anchor = { row: 0, col: 0 };
  d.row = d.lines.length - 1;
  d.col = d.lines[d.row].cells.length;
}

function toggleSel(d: Doc, key: "b" | "i" | "u") {
  const ranges = d.lines.map((_, r) => selRange(d, r));
  const all = ranges.every(
    (rg, r) =>
      !rg || d.lines[r].cells.slice(rg[0], rg[1]).every((c) => c.gap || c[key]),
  );
  d.lines = d.lines.map((ln, r) => {
    const rg = ranges[r];
    if (!rg) return ln;
    return {
      ...ln,
      cells: ln.cells.map((c, i) =>
        i >= rg[0] && i < rg[1] && !c.gap ? ({ ...c, [key]: !all } as Cell) : c,
      ),
    };
  });
}

/** Break one paragraph into lines of at most `cols` cells, preferring real spaces. `lead` = spaces removed before a line. */
function wrapCells(
  all: Cell[],
  cols: number,
): { cells: Cell[]; lead: Cell[] }[] {
  const out: { cells: Cell[]; lead: Cell[] }[] = [];
  let rest = all;
  let lead: Cell[] = [];
  while (rest.length > cols) {
    let i = rest.map((c) => (c.gap ? "\0" : c.ch)).lastIndexOf(" ", cols);
    if (i <= 0) i = cols;
    out.push({ cells: rest.slice(0, i), lead });
    rest = rest.slice(i);
    lead = [];
    while (rest.length && !rest[0].gap && rest[0].ch === " ") {
      lead.push(rest[0]);
      rest = rest.slice(1);
    }
  }
  out.push({ cells: rest, lead });
  return out;
}

/** Re-wrap every paragraph (a hard line plus its soft continuations) to a new width, keeping cursor and selection. */
function reflow(d: Doc, cols: number): Doc {
  const lines: Line[] = [];
  let cur: Pos | null = null;
  let anc: Pos | null = null;
  let r = 0;
  while (r < d.lines.length) {
    let end = r + 1;
    while (end < d.lines.length && d.lines[end].soft !== undefined) end++;
    const group = d.lines.slice(r, end);

    let flat: Cell[] = [];
    const base: number[] = []; // flat offset where each source line starts
    group.forEach((ln, j) => {
      if (j > 0 && flat.length && ln.soft) flat = flat.concat(ln.soft);
      base.push(flat.length);
      flat = flat.concat(ln.cells);
    });

    const wrapped = wrapCells(flat, cols);
    const starts: number[] = [];
    let off = 0;
    wrapped.forEach((w, k) => {
      if (k) off += w.lead.length;
      starts.push(off);
      off += w.cells.length;
    });

    const place = (p: Pos): Pos | null => {
      if (p.row < r || p.row >= end) return null;
      const o = base[p.row - r] + p.col;
      let k = starts.length - 1;
      while (k > 0 && starts[k] > o) k--;
      return {
        row: lines.length + k,
        col: Math.min(o - starts[k], wrapped[k].cells.length),
      };
    };
    cur ??= place({ row: d.row, col: d.col });
    if (d.anchor) anc ??= place(d.anchor);

    wrapped.forEach((w, k) => {
      const id = group[k]?.id ?? uid++;
      lines.push(
        k ? { id, cells: w.cells, soft: w.lead } : { id, cells: w.cells },
      );
    });
    r = end;
  }
  return {
    lines,
    row: cur?.row ?? d.row,
    col: cur?.col ?? d.col,
    anchor: d.anchor ? (anc ?? d.anchor) : null,
  };
}

function Runs({ cells, sel }: { cells: Cell[]; sel: [number, number] | null }) {
  const hl = (i: number) => !!sel && i >= sel[0] && i < sel[1] && !cells[i].gap;
  const sig = (i: number) =>
    `${cells[i].b ? 1 : 0}${cells[i].i ? 1 : 0}${cells[i].u ? 1 : 0}${hl(i) ? 1 : 0}`;
  const out: JSX.Element[] = [];
  let start = 0;
  for (let i = 1; i <= cells.length; i++) {
    if (i === cells.length || sig(i) !== sig(start)) {
      const c = cells[start];
      const cls = [c.b && "b", c.i && "i", c.u && "u", hl(start) && "sel"]
        .filter(Boolean)
        .join(" ");
      out.push(
        <span key={start} className={cls || undefined}>
          {cells
            .slice(start, i)
            .map((x) => x.ch)
            .join("")}
        </span>,
      );
      start = i;
    }
  }
  return <>{out}</>;
}

export default function App() {
  const [doc, setDoc] = useState<Doc>(() => ({
    lines: [mk()],
    row: 0,
    col: 0,
    anchor: null,
  }));
  const [fmt, setFmt] = useState<Fmt>({});
  const [focused, setFocused] = useState(false);
  const [x, setX] = useState(0);
  const [cw, setCw] = useState(0);
  const [pill, setPill] = useState({ w: 58, h: 18 });
  const [strike, setStrike] = useState(0);
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState("");
  const noteTimer = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const cols = useRef(60);
  const metrics = useRef({ cw: 7.2, left: 0, fs: 12, pitch: 15 });
  const clip = useRef<{ text: string; items: Item[] } | null>(null);

  const edit = (fn: (d: Doc) => void) =>
    setDoc((p) => {
      const d: Doc = { ...p, lines: p.lines.slice() };
      fn(d);
      return d;
    });

  // Follow the visual viewport so the rail stays above the on-screen keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const s = document.documentElement.style;
      s.setProperty("--vh", `${vv.height}px`);
      s.setProperty("--vt", `${vv.offsetTop}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  // Keep the pointer under the caret, size it from the character cell, and re-wrap when the column count changes.
  const measure = useCallback(() => {
    if (!caret.current || !probe.current) return;
    const w = probe.current.getBoundingClientRect().width / 10;
    const rootStyle = getComputedStyle(document.documentElement);
    const fs = parseFloat(rootStyle.fontSize);
    const k = parseFloat(rootStyle.getPropertyValue("--pitch-k")) || 1.25;
    const r = caret.current.getBoundingClientRect();
    const left = caret.current.parentElement!.getBoundingClientRect().left;
    metrics.current = { cw: w, left, fs, pitch: fs * k };

    const nc = Math.max(10, Math.floor((innerWidth - left * 2) / w));
    if (nc !== cols.current) {
      cols.current = nc;
      setDoc((p) => reflow(p, nc));
    }

    setCw(w);
    setX(r.left + r.width / 2);
    const pw = Math.round(w * PILL_CELLS);
    const ph = Math.round(fs * PILL_EM);
    setPill((p) => (p.w === pw && p.h === ph ? p : { w: pw, h: ph }));
  }, []);
  useLayoutEffect(measure, [doc.row, doc.col, doc.lines, cw, measure]);
  useEffect(() => {
    addEventListener("resize", measure);
    document.fonts.ready.then(measure);
    return () => removeEventListener("resize", measure);
  }, [measure]);

  const format = (key: "b" | "i" | "u") => {
    const hasSel =
      doc.anchor && (doc.anchor.row !== doc.row || doc.anchor.col !== doc.col);
    if (hasSel) edit((d) => toggleSel(d, key));
    else setFmt((f) => ({ ...f, [key]: !f[key] }));
  };
  const flash = (msg: string) => {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(""), 2200);
  };
  const runExport = async (kind: "png" | "docx") => {
    setMenu(false);
    input.current?.focus();
    try {
      const m = metrics.current;
      const ok =
        kind === "png"
          ? await exportPng(doc.lines, { ...m, cols: cols.current })
          : exportDocx(doc.lines, m.pitch / m.fs);
      if (!ok) flash("Nothing to export");
    } catch {
      flash("Export failed");
    }
  };
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const v = el.value;
    el.value = SENT;
    el.setSelectionRange(SENT.length, SENT.length);
    const text = v.split(SENT).join("");
    if (text) edit((d) => insert(d, toItems(text, fmt), cols.current));
    else if (!v.includes(SENT)) edit(backspace); // sentinel erased: virtual-keyboard Backspace
  };

  const copySel = (e: ClipboardEvent<HTMLInputElement>): boolean => {
    const rows = pick(doc);
    if (!rows) return false;
    e.preventDefault();
    const text = toText(rows);
    clip.current = {
      text,
      items: rows.flatMap<Item>((r, i) => (i ? [null, ...r] : r)),
    };
    e.clipboardData.setData("text/plain", text);
    return true;
  };
  const onCopy = (e: ClipboardEvent<HTMLInputElement>) => {
    copySel(e);
  };
  const onCut = (e: ClipboardEvent<HTMLInputElement>) => {
    if (copySel(e))
      edit((d) => {
        deleteSel(d);
      });
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const items =
      clip.current?.text === text ? clip.current.items : toItems(text, fmt);
    edit((d) => insert(d, items, cols.current));
    click();
    setStrike((n) => n + 1);
  };

  const NAV = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
  ];
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (k === "Escape") {
      setMenu(false);
      return;
    }
    if (
      !mod &&
      !["Shift", "Meta", "Control", "Alt", "CapsLock", "Dead"].includes(k)
    ) {
      click(k === "Enter");
      setStrike((n) => n + 1);
    }
    if (e.nativeEvent.isComposing) return;
    if (NAV.includes(k)) {
      e.preventDefault();
      const key =
        mod && k === "ArrowLeft"
          ? "Home"
          : mod && k === "ArrowRight"
            ? "End"
            : k;
      edit((d) => move(d, key, e.shiftKey));
      return;
    }
    if (mod) {
      const l = k.toLowerCase();
      if (l === "b" || l === "i" || l === "u") {
        e.preventDefault();
        format(l);
      } else if (l === "a") {
        e.preventDefault();
        edit(selectAll);
      } else if (l === "s") {
        e.preventDefault();
        void runExport(e.shiftKey ? "docx" : "png");
      }
      return; // c, x, v fall through to the clipboard events
    }
    if (k === "Enter") {
      e.preventDefault();
      edit(newline);
    } else if (k === "Backspace") {
      e.preventDefault();
      edit(backspace);
    } else if (k === "Delete") {
      e.preventDefault();
      edit(del);
    } else if (k === "Tab") {
      e.preventDefault();
      if (!e.shiftKey) edit((d) => insert(d, toItems("\t", {}), cols.current));
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    input.current?.focus();
    setMenu(false);
    const { cw: w, left, fs, pitch } = metrics.current;
    // active row centre sits 7/6 em above the rail
    const railTop =
      rail.current?.getBoundingClientRect().top ?? innerHeight * 0.831;
    const n = Math.round((railTop - (fs * 7) / 6 - e.clientY) / pitch);
    const cx = e.clientX;
    setDoc((p) => {
      const row = clamp(p.row - n, 0, p.lines.length - 1);
      const col = clamp(
        Math.round((cx - left) / w),
        0,
        p.lines[row].cells.length,
      );
      return { ...p, row, col, anchor: null };
    });
  };

  const { lines, row, col } = doc;
  const lo = Math.max(0, row - VISIBLE_LINES);
  const hi = Math.min(lines.length, row + VISIBLE_LINES + 1);
  const empty = lines.length === 1 && !lines[0].cells.length;

  return (
    <main
      className="sheet"
      onPointerDown={onPointerDown}
      onClick={() => input.current?.focus()}
    >
      <span ref={probe} className="probe" aria-hidden="true">
        0000000000
      </span>

      <div ref={rail} className="rail" />

      {lines.slice(lo, hi).map((ln, j) => {
        const k = lo + j;
        const n = row - k;
        return (
          <div
            key={ln.id}
            className="row"
            style={
              {
                "--n": n,
                "--o": Math.max(0.15, 1 - Math.abs(n) * 0.02),
              } as CSSProperties
            }
          >
            {n === 0 && empty && <span className="hint">{HINT}</span>}
            <Runs cells={ln.cells} sel={selRange(doc, k)} />
            {n === 0 && (
              <span
                key={`${row}:${col}`}
                ref={caret}
                className={`caret${focused ? " caret--on" : ""}`}
                style={{ left: col * cw }}
              />
            )}
          </div>
        );
      })}
      <div
        className="export"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="export__bar">
          {note && (
            <span className="export__note" role="status">
              {note}
            </span>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            Export
          </button>
        </div>
        {menu && (
          <div className="export__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => void runExport("png")}
            >
              Save as image (PNG)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void runExport("docx")}
            >
              Save as document (DOCX)
            </button>
          </div>
        )}
      </div>

      <LiquidGlassPointer x={x} strike={strike} w={pill.w} h={pill.h} />

      <input
        ref={input}
        className="capture"
        aria-label="Typewriter"
        defaultValue={SENT}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onCut={onCut}
        onPaste={onPaste}
        onFocus={(e) => {
          const t = e.currentTarget;
          t.setSelectionRange(t.value.length, t.value.length);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        inputMode="text"
        enterKeyHint="enter"
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
    </main>
  );
}
