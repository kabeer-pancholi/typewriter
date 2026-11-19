import { useEffect, useMemo, useRef } from 'react';
import { buildGlassMaps } from './glassMaps';

// SVG filters inside backdrop-filter only work in Chromium; everything else gets a frosted fallback.
const canRefract =
  typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#a)') && /Chrom/.test(navigator.userAgent);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Props { x: number; strike: number; w: number; h: number }

/** A liquid-glass capsule that rides the rail under the caret. `x` is its centre; bump `strike` on every keystroke. */
export function LiquidGlassPointer({ x, strike, w, h }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const width = useRef(w);
  width.current = w;
  const st = useRef({ x, v: 0, target: x, press: 0 });
  const dpr = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
  const maps = useMemo(() => buildGlassMaps(w, h, dpr), [w, h, dpr]);
  const refraction = Math.round((h * 2) / 3);

  const tick = () => {
    const s = st.current;
    s.v += ((s.target - s.x) * 260 - s.v * 22) / 60; // under-damped spring: a little overshoot reads as liquid
    s.x += s.v / 60;
    s.press *= 0.86;
    const k = Math.min(Math.abs(s.v) / 1400, 0.12);    // stretch while travelling
    if (el.current) {
      el.current.style.transform =
        `translate3d(${s.x - width.current / 2}px,0,0) scale(${1 + k - s.press * 0.06},${1 - k * 0.7 - s.press * 0.14})`;
    }
    const live = Math.abs(s.v) > 0.05 || Math.abs(s.target - s.x) > 0.05 || s.press > 0.01;
    raf.current = live ? requestAnimationFrame(tick) : 0;
  };
  const start = () => { if (!raf.current) raf.current = requestAnimationFrame(tick); };

  useEffect(() => {
    st.current.target = x;
    if (reduceMotion()) st.current.x = x;
    start();
  }, [x]);
  useEffect(() => { start(); }, [w]); // re-centre after a size change
  useEffect(() => {
    if (strike && !reduceMotion()) { st.current.press = 1; start(); }
  }, [strike]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <>
      <svg className="lg-defs" aria-hidden="true">
        <filter id="liquid-glass" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage href={maps.disp} x="0" y="0" width={w} height={h} preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={refraction} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div
        ref={el}
        className={`pointer${canRefract ? ' pointer--refract' : ''}`}
        style={{ width: w, height: h, borderRadius: h / 2, top: `calc(var(--rail) + 2px - ${h / 2}px)` }}
        aria-hidden="true"
      >
        <span className="pointer__spec" style={{ backgroundImage: `url(${maps.spec})` }} />
      </div>
    </>
  );
}