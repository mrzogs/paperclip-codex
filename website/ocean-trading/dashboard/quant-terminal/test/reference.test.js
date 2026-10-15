// Cross-check every built-in indicator against a second, deliberately naive implementation
// written straight from TradingView's published Pine formulas. Nothing here imports the
// app's helpers: every window is recomputed from scratch, bar by bar, so a shared bug can't
// hide. Checked on the last 400 bars of real BTC daily data.
//
// The headline indicators were also checked against the open-source `technicalindicators`
// library (v3.1.0) on the same data: SMA, EMA, WMA, ATR, MACD, Bollinger, Stochastic,
// Williams %R, CCI, ROC, AO, ADX/DMI, PSAR, OBV, A/D, Ichimoku and Keltner matched to 1e-6;
// RSI, MFI and Stoch RSI matched to that library's 2-decimal rounding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compute, INDICATORS } from "../public/lib/indicators.js";

const bars = JSON.parse(
  readFileSync(new URL("./fixtures/btc-1d.json", import.meta.url), "utf8"),
);
const N = bars.length;
const O = bars.map((b) => b.open),
  H = bars.map((b) => b.high),
  L = bars.map((b) => b.low);
const C = bars.map((b) => b.close),
  V = bars.map((b) => b.volume);
const HL2 = bars.map((b) => (b.high + b.low) / 2),
  HLC3 = bars.map((b) => (b.high + b.low + b.close) / 3);
const ok = Number.isFinite;

// ---- naive building blocks: each one recomputes its window from scratch ----
const win = (s, i, n) => (i - n + 1 < 0 ? null : s.slice(i - n + 1, i + 1));
const allOk = (w) => w && w.every(ok);
const SMA = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? w.reduce((a, b) => a + b, 0) / n : NaN;
  });
const SUM = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? w.reduce((a, b) => a + b, 0) : NaN;
  });
const WMA = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    if (!allOk(w)) return NaN;
    let a = 0,
      d = 0;
    w.forEach((v, k) => {
      a += v * (k + 1);
      d += k + 1;
    });
    return a / d;
  });
const STDEV = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    if (!allOk(w)) return NaN;
    const m = w.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  });
const DEV = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    if (!allOk(w)) return NaN;
    const m = w.reduce((a, b) => a + b, 0) / n;
    return w.reduce((a, b) => a + Math.abs(b - m), 0) / n;
  });
const HIGHEST = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? Math.max(...w) : NaN;
  });
const LOWEST = (s, n) =>
  s.map((_, i) => {
    const w = win(s, i, n);
    return allOk(w) ? Math.min(...w) : NaN;
  });
// Pine's ta.ema / ta.rma: seeded with an SMA of the first full window, then recursive.
function smooth(s, n, alpha) {
  const out = new Array(s.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < s.length; i++) {
    if (!ok(s[i])) {
      prev = NaN;
      continue;
    }
    if (!ok(prev)) {
      const w = win(s, i, n);
      if (allOk(w)) prev = w.reduce((a, b) => a + b, 0) / n;
      else continue;
    } else prev = alpha * s[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}
const EMA = (s, n) => smooth(s, n, 2 / (n + 1));
const RMA = (s, n) => smooth(s, n, 1 / n);
const CHANGE = (s, n = 1) => s.map((v, i) => (i >= n ? v - s[i - n] : NaN));
const TR = bars.map((b, i) =>
  i
    ? Math.max(
        b.high - b.low,
        Math.abs(b.high - C[i - 1]),
        Math.abs(b.low - C[i - 1]),
      )
    : b.high - b.low,
);
const ATR = (n) => RMA(TR, n);
const RSI = (s, n) => {
  const ch = CHANGE(s);
  const u = RMA(
      ch.map((d) => (ok(d) ? Math.max(d, 0) : NaN)),
      n,
    ),
    d = RMA(
      ch.map((x) => (ok(x) ? Math.max(-x, 0) : NaN)),
      n,
    );
  return u.map((x, i) =>
    d[i] === 0 ? 100 : x === 0 ? 0 : 100 - 100 / (1 + x / d[i]),
  );
};
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, k) => a.map((v) => v * k);

// ---- TradingView's formulas, one per indicator ----
const REF = {
  sma: () => ({ value: SMA(C, 20) }),
  ema: () => ({ value: EMA(C, 9) }),
  wma: () => ({ value: WMA(C, 20) }),
  vwma: () => {
    const pv = C.map((c, i) => c * V[i]);
    return { value: SMA(pv, 20).map((x, i) => x / SMA(V, 20)[i]) };
  },
  hma: () => ({
    value: WMA(sub(mul(WMA(C, 10), 2), WMA(C, 20)), Math.floor(Math.sqrt(20))),
  }),
  dema: () => {
    const e = EMA(C, 20);
    return { value: sub(mul(e, 2), EMA(e, 20)) };
  },
  tema: () => {
    const e1 = EMA(C, 20),
      e2 = EMA(e1, 20),
      e3 = EMA(e2, 20);
    return { value: add(mul(sub(e1, e2), 3), e3) };
  },
  smma: () => ({ value: RMA(C, 20) }),
  alma: () => {
    const n = 20,
      m = 0.85 * (n - 1),
      s = n / 6;
    return {
      value: C.map((_, i) => {
        if (i < n - 1) return NaN;
        let norm = 0,
          sum = 0;
        for (let k = 0; k < n; k++) {
          const w = Math.exp(-((k - m) ** 2) / (2 * s * s));
          norm += w;
          sum += C[i - (n - 1 - k)] * w;
        }
        return sum / norm;
      }),
    };
  },
  lsma: () => ({
    value: C.map((_, i) => {
      const w = win(C, i, 20);
      if (!w) return NaN;
      const xs = w.map((__, k) => k),
        mx = 9.5,
        my = w.reduce((a, b) => a + b) / 20;
      let num = 0,
        den = 0;
      xs.forEach((x, k) => {
        num += (x - mx) * (w[k] - my);
        den += (x - mx) ** 2;
      });
      const slope = num / den;
      return my + slope * (19 - mx);
    }),
  }),
  macross: () => ({ fast: EMA(C, 9), slow: EMA(C, 21) }),
  ribbon: () => ({
    m20: EMA(C, 20),
    m50: EMA(C, 50),
    m100: EMA(C, 100),
    m200: EMA(C, 200),
  }),
  vwap: () => ({ value: HLC3 }), // daily bars: every bar is its own session
  bb: () => {
    const b = SMA(C, 20),
      sd = STDEV(C, 20);
    return { upper: add(b, mul(sd, 2)), basis: b, lower: sub(b, mul(sd, 2)) };
  },
  bbpb: () => {
    const b = SMA(C, 20),
      sd = STDEV(C, 20);
    return { value: C.map((c, i) => (c - (b[i] - 2 * sd[i])) / (4 * sd[i])) };
  },
  bbw: () => {
    const b = SMA(C, 20),
      sd = STDEV(C, 20);
    return { value: b.map((x, i) => ((4 * sd[i]) / x) * 100) };
  },
  kc: () => {
    const b = EMA(C, 20),
      a = ATR(10);
    return { upper: add(b, mul(a, 2)), basis: b, lower: sub(b, mul(a, 2)) };
  },
  donchian: () => {
    const u = HIGHEST(H, 20),
      l = LOWEST(L, 20);
    return { upper: u, lower: l, basis: u.map((x, i) => (x + l[i]) / 2) };
  },
  envelope: () => {
    const b = SMA(C, 20);
    return { upper: mul(b, 1.1), basis: b, lower: mul(b, 0.9) };
  },
  atr: () => ({ value: ATR(14) }),
  stdev: () => ({ value: STDEV(C, 20) }),
  hv: () => ({
    value: STDEV(
      C.map((c, i) => (i ? Math.log(c / C[i - 1]) : NaN)),
      10,
    ).map((x) => 100 * x * Math.sqrt(365)),
  }),
  rsi: () => {
    const r = RSI(C, 14);
    return { value: r, ma: SMA(r, 14) };
  },
  stoch: () => {
    const hh = HIGHEST(H, 14),
      ll = LOWEST(L, 14);
    const k = C.map((c, i) => (100 * (c - ll[i])) / (hh[i] - ll[i]));
    return { k, d: SMA(k, 3) };
  },
  stochrsi: () => {
    const r = RSI(C, 14),
      hh = HIGHEST(r, 14),
      ll = LOWEST(r, 14);
    const raw = r.map((x, i) => (100 * (x - ll[i])) / (hh[i] - ll[i]));
    const k = SMA(raw, 3);
    return { k, d: SMA(k, 3) };
  },
  macd: () => {
    const m = sub(EMA(C, 12), EMA(C, 26)),
      s = EMA(m, 9);
    return { macd: m, signal: s, hist: sub(m, s) };
  },
  cci: () => {
    const s = SMA(HLC3, 20),
      d = DEV(HLC3, 20);
    return { value: HLC3.map((x, i) => (x - s[i]) / (0.015 * d[i])) };
  },
  willr: () => {
    const hh = HIGHEST(H, 14),
      ll = LOWEST(L, 14);
    return { value: C.map((c, i) => (100 * (c - hh[i])) / (hh[i] - ll[i])) };
  },
  roc: () => ({
    value: C.map((c, i) => (i >= 9 ? (100 * (c - C[i - 9])) / C[i - 9] : NaN)),
  }),
  mom: () => ({ value: CHANGE(C, 10) }),
  mfi: () => {
    const ch = CHANGE(HLC3);
    const up = SUM(
        HLC3.map((x, i) => (ch[i] > 0 ? x * V[i] : ok(ch[i]) ? 0 : NaN)),
        14,
      ),
      dn = SUM(
        HLC3.map((x, i) => (ch[i] < 0 ? x * V[i] : ok(ch[i]) ? 0 : NaN)),
        14,
      );
    return { value: up.map((u, i) => 100 - 100 / (1 + u / dn[i])) };
  },
  cmo: () => {
    const m = CHANGE(C);
    const s1 = SUM(
        m.map((x) => (ok(x) ? Math.max(x, 0) : NaN)),
        9,
      ),
      s2 = SUM(
        m.map((x) => (ok(x) ? Math.max(-x, 0) : NaN)),
        9,
      );
    return { value: s1.map((a, i) => (100 * (a - s2[i])) / (a + s2[i])) };
  },
  trix: () => {
    const lc = C.map(Math.log);
    return { value: mul(CHANGE(EMA(EMA(EMA(lc, 18), 18), 18)), 10000) };
  },
  ao: () => ({ value: sub(SMA(HL2, 5), SMA(HL2, 34)) }),
  uo: () => {
    const pc = C.map((_, i) => (i ? C[i - 1] : NaN));
    const lo = L.map((l, i) => Math.min(l, pc[i])),
      hi = H.map((h, i) => Math.max(h, pc[i]));
    const bp = C.map((c, i) => c - lo[i]),
      tr = hi.map((h, i) => h - lo[i]);
    const avg = (n) => SUM(bp, n).map((x, i) => x / SUM(tr, n)[i]);
    const a7 = avg(7),
      a14 = avg(14),
      a28 = avg(28);
    return {
      value: a7.map((x, i) => (100 * (4 * x + 2 * a14[i] + a28[i])) / 7),
    };
  },
  tsi: () => {
    const pc = CHANGE(C);
    const ds = (s) => EMA(EMA(s, 25), 13);
    const t = ds(pc).map((x, i) => (100 * x) / ds(pc.map(Math.abs))[i]);
    return { value: t, signal: EMA(t, 13) };
  },
  ppo: () => {
    const f = EMA(C, 12),
      s = EMA(C, 26);
    const v = f.map((x, i) => (100 * (x - s[i])) / s[i]);
    return { value: v, signal: EMA(v, 9) };
  },
  coppock: () => {
    const roc = (n) =>
      C.map((c, i) => (i >= n ? (100 * (c - C[i - n])) / C[i - n] : NaN));
    return { value: WMA(add(roc(14), roc(11)), 10) };
  },
  elder: () => {
    const e = EMA(C, 13);
    return { bull: sub(H, e), bear: sub(L, e) };
  },
  bop: () => ({ value: C.map((c, i) => (c - O[i]) / (H[i] - L[i])) }),
  dmi: () => {
    const up = CHANGE(H),
      dn = CHANGE(L).map((x) => -x);
    const pdm = up.map((u, i) => (ok(u) ? (u > dn[i] && u > 0 ? u : 0) : NaN)),
      mdm = dn.map((d, i) => (ok(d) ? (d > up[i] && d > 0 ? d : 0) : NaN));
    const tr = RMA(
      TR.map((t, i) => (i ? t : NaN)),
      14,
    );
    const plus = RMA(pdm, 14).map((x, i) => (100 * x) / tr[i]),
      minus = RMA(mdm, 14).map((x, i) => (100 * x) / tr[i]);
    const dx = plus.map(
      (p, i) =>
        (100 * Math.abs(p - minus[i])) /
        (p + minus[i] === 0 ? 1 : p + minus[i]),
    );
    return { adx: RMA(dx, 14), plus, minus };
  },
  adx: () => ({ adx: REF.dmi().adx }),
  aroon: () => ({
    up: H.map((_, i) => {
      const w = win(H, i, 15);
      if (!w) return NaN;
      let k = 0;
      w.forEach((v, j) => {
        if (v >= w[k]) k = j;
      });
      return (100 * k) / 14;
    }),
    down: L.map((_, i) => {
      const w = win(L, i, 15);
      if (!w) return NaN;
      let k = 0;
      w.forEach((v, j) => {
        if (v <= w[k]) k = j;
      });
      return (100 * k) / 14;
    }),
  }),
  vortex: () => {
    const vmp = SUM(
        H.map((h, i) => (i ? Math.abs(h - L[i - 1]) : NaN)),
        14,
      ),
      vmm = SUM(
        L.map((l, i) => (i ? Math.abs(l - H[i - 1]) : NaN)),
        14,
      ),
      str = SUM(TR, 14);
    return {
      plus: vmp.map((x, i) => x / str[i]),
      minus: vmm.map((x, i) => x / str[i]),
    };
  },
  chop: () => {
    const s = SUM(TR, 14),
      hh = HIGHEST(H, 14),
      ll = LOWEST(L, 14);
    return {
      value: s.map(
        (x, i) => (100 * Math.log10(x / (hh[i] - ll[i]))) / Math.log10(14),
      ),
    };
  },
  mass: () => {
    const span = sub(H, L),
      e1 = EMA(span, 9),
      e2 = EMA(e1, 9);
    return {
      value: SUM(
        e1.map((x, i) => x / e2[i]),
        10,
      ),
    };
  },
  psar: null, // matched to technicalindicators above, and a step-by-step test lives in indicators.test.js
  supertrend: () => {
    const a = ATR(10),
      up = [],
      down = [];
    let pu = NaN,
      pl = NaN,
      pst = NaN;
    for (let i = 0; i < N; i++) {
      if (!ok(a[i])) {
        up.push(NaN);
        down.push(NaN);
        continue;
      }
      let u = HL2[i] + 3 * a[i],
        l = HL2[i] - 3 * a[i];
      if (ok(pl)) l = l > pl || C[i - 1] < pl ? l : pl;
      if (ok(pu)) u = u < pu || C[i - 1] > pu ? u : pu;
      const dir = !ok(pst)
        ? 1
        : pst === pu
          ? C[i] > u
            ? -1
            : 1
          : C[i] < l
            ? 1
            : -1;
      const st = dir === -1 ? l : u;
      up.push(dir === -1 ? st : NaN);
      down.push(dir === 1 ? st : NaN);
      pu = u;
      pl = l;
      pst = st;
    }
    return { up, down };
  },
  ichimoku: () => {
    const mid = (n) => HIGHEST(H, n).map((x, i) => (x + LOWEST(L, n)[i]) / 2);
    const conv = mid(9),
      base = mid(26);
    return { conversion: conv, base };
  },
  pivots: () => {
    // Daily bars, auto period = month: levels for a month come from the previous calendar month.
    const mk = (t) => {
      const d = new Date(t * 1000);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    };
    const out = { p: [], r1: [], s1: [], r2: [], s2: [], r3: [], s3: [] };
    bars.forEach((b) => {
      const prev = bars.filter((x) => mk(x.time) === mk(b.time) - 1);
      if (!prev.length || mk(bars[0].time) === mk(b.time) - 1) {
        for (const k in out) out[k].push(NaN);
        return;
      }
      const h = Math.max(...prev.map((x) => x.high)),
        l = Math.min(...prev.map((x) => x.low)),
        c = prev[prev.length - 1].close,
        P = (h + l + c) / 3;
      out.p.push(P);
      out.r1.push(2 * P - l);
      out.s1.push(2 * P - h);
      out.r2.push(P + h - l);
      out.s2.push(P - (h - l));
      out.r3.push(h + 2 * (P - l));
      out.s3.push(l - 2 * (h - P));
    });
    return out;
  },
  volume: () => ({ value: V, ma: SMA(V, 20) }),
  obv: () => {
    let s = 0;
    return {
      value: C.map(
        (c, i) =>
          (s += i === 0 ? 0 : c > C[i - 1] ? V[i] : c < C[i - 1] ? -V[i] : 0),
      ),
    };
  },
  cmf: () => {
    const ad = bars.map((b) =>
      b.high === b.low
        ? 0
        : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume,
    );
    return { value: SUM(ad, 20).map((x, i) => x / SUM(V, 20)[i]) };
  },
  ad: () => {
    let s = 0;
    return {
      value: bars.map(
        (b) =>
          (s +=
            b.high === b.low
              ? 0
              : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume),
      ),
    };
  },
  pvt: () => {
    let s = 0;
    return {
      value: C.map((c, i) =>
        i ? (s += ((c - C[i - 1]) / C[i - 1]) * V[i]) : NaN,
      ),
    };
  },
  eom: () => {
    const ch = CHANGE(HL2);
    return {
      value: SMA(
        ch.map((x, i) => (10000 * x * (H[i] - L[i])) / V[i]),
        14,
      ),
    };
  },
  patterns: null, // markers, not a series
  vpvr: null, // drawn by the chart, checked in the volume profile test below
  markov: null, // checked in the Markov regime test below
};

test("the reference covers every built-in indicator", () => {
  const missing = INDICATORS.filter(
    (d) => !d.id.startsWith("custom:") && !(d.id in REF),
  ).map((d) => d.id);
  assert.deepEqual(missing, []);
});

for (const [id, ref] of Object.entries(REF)) {
  if (!ref) continue;
  test(`${id} matches TradingView's formula on the last 400 bars`, () => {
    const ours = compute(id, bars),
      theirs = ref();
    for (const [key, want] of Object.entries(theirs)) {
      const got = ours[key];
      assert.ok(Array.isArray(got), `${id}.${key} missing`);
      let compared = 0;
      for (let i = N - 400; i < N; i++) {
        if (!ok(want[i])) continue;
        assert.ok(
          ok(got[i]),
          `${id}.${key}[${i}] is ${got[i]}, expected ${want[i]}`,
        );
        const tol = 1e-7 * Math.max(1, Math.abs(want[i]));
        assert.ok(
          Math.abs(got[i] - want[i]) <= tol,
          `${id}.${key}[${i}] = ${got[i]}, expected ${want[i]}`,
        );
        compared++;
      }
      assert.ok(
        compared > 100,
        `${id}.${key} only had ${compared} comparable bars`,
      );
    }
  });
}

// Volume profile: every bar's volume lands in the rows its range covers, and the value area holds
// at least the asked-for share of the total.
test("volume profile conserves volume and its value area holds 70%", async () => {
  const { VolumeProfile } = await import("../public/js/volume-profile.js");
  const sample = bars.slice(-200);
  const prof = VolumeProfile.profile(sample, 24, 70);
  const total = prof.total.reduce((a, b) => a + b, 0);
  const want = sample.reduce((a, b) => a + (b.volume || 0), 0);
  assert.ok(Math.abs(total - want) / want < 1e-9, "no volume lost or invented");
  const va = prof.total.slice(prof.vaLow, prof.vaHigh + 1).reduce((a, b) => a + b, 0);
  assert.ok(va / total >= 0.7);
  assert.ok(prof.vaLow <= prof.poc && prof.poc <= prof.vaHigh);
  assert.equal(prof.total[prof.poc], Math.max(...prof.total));
});

// Markov regime: states follow the trailing-return rule, odds are probabilities, and no bar uses
// a transition that hadn't happened yet.
test("Markov regime labels states by trailing return and its odds never look ahead", () => {
  const r = compute("markov", bars, { lookback: 20, threshold: 5, minHistory: 50 });
  for (let i = 20; i < bars.length; i++) {
    const ret = bars[i].close / bars[i - 20].close - 1;
    assert.equal(r.state[i], ret >= 0.05 ? 1 : ret <= -0.05 ? -1 : 0);
    if (Number.isFinite(r.signal[i])) {
      assert.ok(r.pbull[i] >= 0 && r.pbull[i] <= 1 && r.pbear[i] >= 0 && r.pbear[i] <= 1);
      assert.ok(Math.abs(r.signal[i] - (r.pbull[i] - r.pbear[i])) < 1e-12);
    }
  }
  const cut = compute("markov", bars.slice(0, 600), { lookback: 20, threshold: 5, minHistory: 50 });
  for (let i = 0; i < 600; i++) if (Number.isFinite(cut.signal[i])) assert.ok(Math.abs(cut.signal[i] - r.signal[i]) < 1e-12, `bar ${i} changed when later bars were added`);
});
