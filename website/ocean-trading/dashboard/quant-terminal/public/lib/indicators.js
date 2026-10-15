// Technical indicators. Pure functions, no dependencies. Runs in the browser and in Node.
// Formulas follow the Pine Script reference (ta.* functions) so values line up with
// TradingView's built-ins: RMA-based RSI/ATR/ADX, SMA-seeded EMA, population stdev.
// Every series is a plain array the same length as the bars; missing values are NaN.

const N = NaN;
const isNum = (v) => typeof v === "number" && !Number.isNaN(v);

// ---------- sources ----------
export function source(bars, name = "close") {
  switch (name) {
    case "open":
      return bars.map((b) => b.open);
    case "high":
      return bars.map((b) => b.high);
    case "low":
      return bars.map((b) => b.low);
    case "volume":
      return bars.map((b) => b.volume ?? 0);
    case "hl2":
      return bars.map((b) => (b.high + b.low) / 2);
    case "hlc3":
      return bars.map((b) => (b.high + b.low + b.close) / 3);
    case "ohlc4":
      return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    case "hlcc4":
      return bars.map((b) => (b.high + b.low + 2 * b.close) / 4);
    default:
      return bars.map((b) => b.close);
  }
}

// ---------- building blocks (ta.*) ----------
export function change(src, n = 1) {
  return src.map((v, i) => (i >= n ? v - src[i - n] : N));
}

export function sum(src, n) {
  const out = new Array(src.length).fill(N);
  let s = 0,
    valid = 0;
  for (let i = 0; i < src.length; i++) {
    if (isNum(src[i])) {
      s += src[i];
      valid++;
    }
    if (i >= n && isNum(src[i - n])) {
      s -= src[i - n];
      valid--;
    }
    if (i >= n - 1 && valid === n) out[i] = s;
  }
  return out;
}

export function sma(src, n) {
  return sum(src, n).map((v) => v / n);
}

// Shared core for EMA and RMA: seeded with the SMA of the first n valid values, as Pine does.
function smoothed(src, n, alpha) {
  const out = new Array(src.length).fill(N);
  let prev = N,
    seedSum = 0,
    seedCount = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) {
      continue;
    }
    if (!isNum(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const ema = (src, n) => smoothed(src, n, 2 / (n + 1));
export const rma = (src, n) => smoothed(src, n, 1 / n);

export function wma(src, n) {
  const out = new Array(src.length).fill(N);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < src.length; i++) {
    let s = 0,
      ok = true;
    for (let j = 0; j < n; j++) {
      const v = src[i - j];
      if (!isNum(v)) {
        ok = false;
        break;
      }
      s += v * (n - j);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

export function vwma(src, vol, n) {
  const pv = sma(
    src.map((v, i) => v * vol[i]),
    n,
  );
  const vv = sma(vol, n);
  return pv.map((v, i) => (vv[i] ? v / vv[i] : N));
}

export function hma(src, n) {
  const half = wma(src, Math.max(1, Math.floor(n / 2)));
  const full = wma(src, n);
  return wma(
    half.map((v, i) => 2 * v - full[i]),
    Math.max(1, Math.floor(Math.sqrt(n))),
  );
}

export function dema(src, n) {
  const e1 = ema(src, n),
    e2 = ema(e1, n);
  return e1.map((v, i) => 2 * v - e2[i]);
}

export function tema(src, n) {
  const e1 = ema(src, n),
    e2 = ema(e1, n),
    e3 = ema(e2, n);
  return e1.map((v, i) => 3 * (v - e2[i]) + e3[i]);
}

export function alma(src, n, offset = 0.85, sigma = 6) {
  const m = offset * (n - 1),
    s = n / sigma;
  const w = Array.from({ length: n }, (_, i) =>
    Math.exp(-((i - m) ** 2) / (2 * s * s)),
  );
  const norm = w.reduce((a, b) => a + b, 0);
  const out = new Array(src.length).fill(N);
  for (let t = n - 1; t < src.length; t++) {
    let acc = 0,
      ok = true;
    for (let i = 0; i < n; i++) {
      const v = src[t - (n - 1 - i)];
      if (!isNum(v)) {
        ok = false;
        break;
      }
      acc += v * w[i];
    }
    if (ok) out[t] = acc / norm;
  }
  return out;
}

export function linreg(src, n, offset = 0) {
  const out = new Array(src.length).fill(N);
  for (let t = n - 1; t < src.length; t++) {
    let sx = 0,
      sy = 0,
      sxy = 0,
      sxx = 0,
      ok = true;
    for (let i = 0; i < n; i++) {
      const y = src[t - n + 1 + i];
      if (!isNum(y)) {
        ok = false;
        break;
      }
      sx += i;
      sy += y;
      sxy += i * y;
      sxx += i * i;
    }
    if (!ok) continue;
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    out[t] = intercept + slope * (n - 1 - offset);
  }
  return out;
}

export function stdev(src, n) {
  const m = sma(src, n),
    m2 = sma(
      src.map((v) => v * v),
      n,
    );
  return m.map((v, i) => Math.sqrt(Math.max(0, m2[i] - v * v)));
}

// Mean absolute deviation (ta.dev), used by CCI.
export function dev(src, n) {
  const m = sma(src, n);
  return m.map((mean, i) => {
    if (!isNum(mean)) return N;
    let s = 0;
    for (let j = 0; j < n; j++) s += Math.abs(src[i - j] - mean);
    return s / n;
  });
}

export function highest(src, n) {
  const out = new Array(src.length).fill(N);
  for (let i = n - 1; i < src.length; i++) {
    let h = -Infinity;
    for (let j = 0; j < n; j++) if (src[i - j] > h) h = src[i - j];
    out[i] = h;
  }
  return out;
}

export function lowest(src, n) {
  const out = new Array(src.length).fill(N);
  for (let i = n - 1; i < src.length; i++) {
    let l = Infinity;
    for (let j = 0; j < n; j++) if (src[i - j] < l) l = src[i - j];
    out[i] = l;
  }
  return out;
}

// Offset (0 or negative) of the highest/lowest value within the last n bars, like ta.highestbars.
function extremeBars(src, n, cmp) {
  const out = new Array(src.length).fill(N);
  for (let i = n - 1; i < src.length; i++) {
    let best = src[i],
      off = 0;
    for (let j = 1; j < n; j++)
      if (cmp(src[i - j], best)) {
        best = src[i - j];
        off = -j;
      }
    out[i] = off;
  }
  return out;
}

export function tr(bars) {
  return bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(
          b.high - b.low,
          Math.abs(b.high - bars[i - 1].close),
          Math.abs(b.low - bars[i - 1].close),
        ),
  );
}

export const atr = (bars, n = 14) => rma(tr(bars), n);

export function crossover(a, b) {
  return a.map((v, i) => i > 0 && v > val(b, i) && a[i - 1] <= val(b, i - 1));
}
export function crossunder(a, b) {
  return a.map((v, i) => i > 0 && v < val(b, i) && a[i - 1] >= val(b, i - 1));
}
const val = (x, i) => (Array.isArray(x) ? x[i] : x);

export function rsiOf(src, n = 14) {
  const ch = change(src);
  const up = rma(
    ch.map((v) => (isNum(v) ? Math.max(v, 0) : N)),
    n,
  );
  const dn = rma(
    ch.map((v) => (isNum(v) ? Math.max(-v, 0) : N)),
    n,
  );
  return up.map((u, i) => {
    const d = dn[i];
    if (!isNum(u) || !isNum(d)) return N;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  });
}

function stochOf(src, high, low, n) {
  const hh = highest(high, n),
    ll = lowest(low, n);
  return src.map((v, i) =>
    hh[i] - ll[i] === 0 ? N : (100 * (v - ll[i])) / (hh[i] - ll[i]),
  );
}

function cum(src) {
  let s = 0;
  return src.map((v) => (s += isNum(v) ? v : 0));
}

function shiftForward(src, k) {
  // Value computed at bar i is drawn at bar i + k (k may be negative).
  const out = new Array(src.length + Math.max(0, k)).fill(N);
  src.forEach((v, i) => {
    if (i + k >= 0) out[i + k] = v;
  });
  return out;
}

// Period key used by VWAP resets and pivot points. Times are UTC seconds.
function periodKey(t, period) {
  const d = new Date(t * 1000);
  if (period === "day")
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  if (period === "month") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  if (period === "year") return `${d.getUTCFullYear()}`;
  // ISO week, Monday start
  const day = Math.floor(t / 86400);
  return `w${Math.floor((day + 3) / 7)}`;
}

// ---------- candle patterns ----------
export function candlePatterns(bars) {
  const markers = [];
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i],
      p = bars[i - 1],
      pp = bars[i - 2];
    const body = Math.abs(b.close - b.open),
      range = b.high - b.low || 1e-12;
    const upper = b.high - Math.max(b.open, b.close),
      lower = Math.min(b.open, b.close) - b.low;
    const pBody = Math.abs(p.close - p.open);
    const bull = b.close > b.open,
      pBull = p.close > p.open;
    let name = null,
      up = true;
    if (
      !pBull &&
      bull &&
      b.open <= p.close &&
      b.close >= p.open &&
      body > pBody
    )
      name = "Engulfing";
    else if (
      pBull &&
      !bull &&
      b.open >= p.close &&
      b.close <= p.open &&
      body > pBody
    ) {
      name = "Engulfing";
      up = false;
    } else if (lower >= 2 * body && upper <= body * 0.5 && body / range < 0.35)
      name = "Hammer";
    else if (upper >= 2 * body && lower <= body * 0.5 && body / range < 0.35) {
      name = "Star";
      up = false;
    } else if (
      pp.close < pp.open &&
      Math.abs(p.close - p.open) / (p.high - p.low || 1) < 0.3 &&
      bull &&
      b.close > (pp.open + pp.close) / 2
    )
      name = "Star";
    else if (
      pp.close > pp.open &&
      Math.abs(p.close - p.open) / (p.high - p.low || 1) < 0.3 &&
      !bull &&
      b.close < (pp.open + pp.close) / 2
    ) {
      name = "Star";
      up = false;
    }
    if (name) {
      markers.push({
        time: b.time,
        position: up === false ? "aboveBar" : "belowBar",
        shape: up === null ? "circle" : up ? "arrowUp" : "arrowDown",
        color: up === null ? "#9598a1" : up ? "#26a69a" : "#ef5350",
        text: name,
      });
    }
  }
  return markers;
}

// ---------- registry ----------
// Each indicator: inputs (shown in its settings), outputs (one chart series each), and calc().
// overlay: true draws on the price pane; false gets its own pane.
const src = {
  key: "source",
  label: "Source",
  type: "source",
  default: "close",
};
const len = (d, label = "Length") => ({
  key: "length",
  label,
  type: "int",
  default: d,
  min: 1,
});
const line = (key, label, color, extra = {}) => ({
  key,
  label,
  kind: "line",
  color,
  ...extra,
});
const hist = (key, label, color, extra = {}) => ({
  key,
  label,
  kind: "histogram",
  color,
  ...extra,
});

const MA_COLORS = "#2962ff";

function maDef(id, name, fn, extraInputs = []) {
  return {
    id,
    name,
    group: "Moving averages",
    overlay: true,
    inputs: [len(id === "ema" ? 9 : 20), src, ...extraInputs],
    outputs: [line("value", name, MA_COLORS)],
    calc: (bars, p) => ({
      value: fn(source(bars, p.source), p.length, p, bars),
    }),
  };
}

export const INDICATORS = [
  maDef("sma", "Moving Average (SMA)", (s, n) => sma(s, n)),
  maDef("ema", "Exponential Moving Average (EMA)", (s, n) => ema(s, n)),
  maDef("wma", "Weighted Moving Average (WMA)", (s, n) => wma(s, n)),
  maDef("vwma", "Volume Weighted Moving Average (VWMA)", (s, n, p, bars) =>
    vwma(s, source(bars, "volume"), n),
  ),
  maDef("hma", "Hull Moving Average (HMA)", (s, n) => hma(s, n)),
  maDef("dema", "Double EMA (DEMA)", (s, n) => dema(s, n)),
  maDef("tema", "Triple EMA (TEMA)", (s, n) => tema(s, n)),
  maDef("smma", "Smoothed Moving Average (SMMA / RMA)", (s, n) => rma(s, n)),
  maDef(
    "alma",
    "Arnaud Legoux Moving Average (ALMA)",
    (s, n, p) => alma(s, n, p.offset, p.sigma),
    [
      { key: "offset", label: "Offset", type: "float", default: 0.85 },
      { key: "sigma", label: "Sigma", type: "float", default: 6 },
    ],
  ),
  maDef("lsma", "Least Squares Moving Average (LSMA)", (s, n) =>
    linreg(s, n, 0),
  ),
  {
    id: "macross",
    name: "MA Cross",
    group: "Moving averages",
    overlay: true,
    inputs: [
      { key: "fast", label: "Fast length", type: "int", default: 9, min: 1 },
      { key: "slow", label: "Slow length", type: "int", default: 21, min: 1 },
      {
        key: "type",
        label: "Type",
        type: "select",
        options: ["EMA", "SMA"],
        default: "EMA",
      },
      src,
    ],
    outputs: [line("fast", "Fast", "#2962ff"), line("slow", "Slow", "#ff6d00")],
    calc: (bars, p) => {
      const s = source(bars, p.source),
        f = p.type === "SMA" ? sma : ema;
      const fast = f(s, p.fast),
        slow = f(s, p.slow);
      const up = crossover(fast, slow),
        dn = crossunder(fast, slow);
      const markers = [];
      bars.forEach((b, i) => {
        if (up[i])
          markers.push({
            time: b.time,
            position: "belowBar",
            shape: "arrowUp",
            color: "#26a69a",
            text: "Cross up",
          });
        if (dn[i])
          markers.push({
            time: b.time,
            position: "aboveBar",
            shape: "arrowDown",
            color: "#ef5350",
            text: "Cross down",
          });
      });
      return { fast, slow, markers };
    },
  },
  {
    id: "ribbon",
    name: "Moving Average Ribbon",
    group: "Moving averages",
    overlay: true,
    inputs: [src],
    outputs: [
      line("m20", "MA 20", "#f6c309"),
      line("m50", "MA 50", "#fb9800"),
      line("m100", "MA 100", "#fb6500"),
      line("m200", "MA 200", "#f60c0c"),
    ],
    calc: (bars, p) => {
      const s = source(bars, p.source);
      return {
        m20: ema(s, 20),
        m50: ema(s, 50),
        m100: ema(s, 100),
        m200: ema(s, 200),
      };
    },
  },
  {
    id: "vwap",
    name: "Volume Weighted Average Price (VWAP)",
    group: "Volume",
    overlay: true,
    inputs: [{ ...src, default: "hlc3" }],
    outputs: [line("value", "VWAP", "#2962ff", { lineWidth: 2 })],
    calc: (bars, p) => {
      const s = source(bars, p.source);
      let key = null,
        pv = 0,
        v = 0;
      const breaks = new Array(bars.length).fill(false);
      const value = bars.map((b, i) => {
        const k = periodKey(b.time, "day");
        if (k !== key) {
          breaks[i] = key !== null; // new session: don't join it to yesterday's line
          key = k;
          pv = 0;
          v = 0;
        }
        const vol = b.volume || 0;
        pv += s[i] * vol;
        v += vol;
        return v ? pv / v : s[i];
      });
      return { value, breaks };
    },
  },
  {
    id: "bb",
    name: "Bollinger Bands",
    group: "Volatility",
    overlay: true,
    inputs: [
      len(20),
      src,
      { key: "mult", label: "StdDev", type: "float", default: 2 },
    ],
    outputs: [
      line("upper", "Upper", "#f23645"),
      line("basis", "Basis", "#2962ff"),
      line("lower", "Lower", "#089981"),
    ],
    calc: (bars, p) => {
      const s = source(bars, p.source),
        basis = sma(s, p.length),
        sd = stdev(s, p.length);
      return {
        basis,
        upper: basis.map((v, i) => v + p.mult * sd[i]),
        lower: basis.map((v, i) => v - p.mult * sd[i]),
      };
    },
  },
  {
    id: "bbpb",
    name: "Bollinger Bands %B",
    group: "Volatility",
    overlay: false,
    inputs: [
      len(20),
      src,
      { key: "mult", label: "StdDev", type: "float", default: 2 },
    ],
    outputs: [line("value", "%B", "#22ab94")],
    levels: [0, 0.5, 1],
    calc: (bars, p) => {
      const s = source(bars, p.source),
        basis = sma(s, p.length),
        sd = stdev(s, p.length);
      return {
        value: s.map(
          (v, i) => (v - (basis[i] - p.mult * sd[i])) / (2 * p.mult * sd[i]),
        ),
      };
    },
  },
  {
    id: "bbw",
    name: "Bollinger BandWidth",
    group: "Volatility",
    overlay: false,
    inputs: [
      len(20),
      src,
      { key: "mult", label: "StdDev", type: "float", default: 2 },
    ],
    outputs: [line("value", "BBW", "#2962ff")],
    calc: (bars, p) => {
      const s = source(bars, p.source),
        basis = sma(s, p.length),
        sd = stdev(s, p.length);
      return { value: basis.map((b, i) => ((2 * p.mult * sd[i]) / b) * 100) };
    },
  },
  {
    id: "kc",
    name: "Keltner Channels",
    group: "Volatility",
    overlay: true,
    inputs: [
      len(20),
      { key: "mult", label: "Multiplier", type: "float", default: 2 },
      { key: "atrLength", label: "ATR length", type: "int", default: 10 },
      src,
    ],
    outputs: [
      line("upper", "Upper", "#2962ff"),
      line("basis", "Basis", "#2962ff"),
      line("lower", "Lower", "#2962ff"),
    ],
    calc: (bars, p) => {
      const basis = ema(source(bars, p.source), p.length),
        a = atr(bars, p.atrLength);
      return {
        basis,
        upper: basis.map((v, i) => v + p.mult * a[i]),
        lower: basis.map((v, i) => v - p.mult * a[i]),
      };
    },
  },
  {
    id: "donchian",
    name: "Donchian Channels",
    group: "Volatility",
    overlay: true,
    inputs: [len(20)],
    outputs: [
      line("upper", "Upper", "#2962ff"),
      line("basis", "Basis", "#ff6d00"),
      line("lower", "Lower", "#2962ff"),
    ],
    calc: (bars, p) => {
      const upper = highest(source(bars, "high"), p.length),
        lower = lowest(source(bars, "low"), p.length);
      return { upper, lower, basis: upper.map((v, i) => (v + lower[i]) / 2) };
    },
  },
  {
    id: "envelope",
    name: "Envelope",
    group: "Volatility",
    overlay: true,
    inputs: [
      len(20),
      { key: "percent", label: "Percent", type: "float", default: 10 },
      src,
    ],
    outputs: [
      line("upper", "Upper", "#2962ff"),
      line("basis", "Basis", "#ff6d00"),
      line("lower", "Lower", "#2962ff"),
    ],
    calc: (bars, p) => {
      const basis = sma(source(bars, p.source), p.length),
        k = p.percent / 100;
      return {
        basis,
        upper: basis.map((v) => v * (1 + k)),
        lower: basis.map((v) => v * (1 - k)),
      };
    },
  },
  {
    id: "atr",
    name: "Average True Range (ATR)",
    group: "Volatility",
    overlay: false,
    inputs: [len(14)],
    outputs: [line("value", "ATR", "#b71c1c")],
    calc: (bars, p) => ({ value: atr(bars, p.length) }),
  },
  {
    id: "stdev",
    name: "Standard Deviation",
    group: "Volatility",
    overlay: false,
    inputs: [len(20), src],
    outputs: [line("value", "StdDev", "#2962ff")],
    calc: (bars, p) => ({ value: stdev(source(bars, p.source), p.length) }),
  },
  {
    id: "hv",
    name: "Historical Volatility",
    group: "Volatility",
    overlay: false,
    inputs: [
      len(10),
      { key: "annual", label: "Periods per year", type: "int", default: 365 },
    ],
    outputs: [line("value", "HV", "#2962ff")],
    calc: (bars, p) => {
      const lr = bars.map((b, i) =>
        i ? Math.log(b.close / bars[i - 1].close) : N,
      );
      return {
        value: stdev(lr, p.length).map((v) => 100 * v * Math.sqrt(p.annual)),
      };
    },
  },
  {
    id: "rsi",
    name: "Relative Strength Index (RSI)",
    group: "Momentum",
    overlay: false,
    inputs: [
      len(14),
      src,
      {
        key: "maLength",
        label: "Smoothing (SMA, 0 = off)",
        type: "int",
        default: 14,
        min: 0,
      },
    ],
    outputs: [
      line("value", "RSI", "#7e57c2"),
      line("ma", "RSI-based MA", "#f7c600", { lineWidth: 1 }),
    ],
    levels: [30, 50, 70],
    calc: (bars, p) => {
      const value = rsiOf(source(bars, p.source), p.length);
      return {
        value,
        ma: p.maLength > 0 ? sma(value, p.maLength) : value.map(() => N),
      };
    },
  },
  {
    id: "stoch",
    name: "Stochastic",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "k", label: "%K length", type: "int", default: 14 },
      { key: "smoothK", label: "%K smoothing", type: "int", default: 1 },
      { key: "d", label: "%D smoothing", type: "int", default: 3 },
    ],
    outputs: [line("k", "%K", "#2962ff"), line("d", "%D", "#ff6d00")],
    levels: [20, 50, 80],
    calc: (bars, p) => {
      const k = sma(
        stochOf(
          source(bars, "close"),
          source(bars, "high"),
          source(bars, "low"),
          p.k,
        ),
        p.smoothK,
      );
      return { k, d: sma(k, p.d) };
    },
  },
  {
    id: "stochrsi",
    name: "Stochastic RSI",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "smoothK", label: "K", type: "int", default: 3 },
      { key: "smoothD", label: "D", type: "int", default: 3 },
      { key: "rsiLength", label: "RSI length", type: "int", default: 14 },
      {
        key: "stochLength",
        label: "Stochastic length",
        type: "int",
        default: 14,
      },
      src,
    ],
    outputs: [line("k", "K", "#2962ff"), line("d", "D", "#ff6d00")],
    levels: [20, 50, 80],
    calc: (bars, p) => {
      const r = rsiOf(source(bars, p.source), p.rsiLength);
      const k = sma(stochOf(r, r, r, p.stochLength), p.smoothK);
      return { k, d: sma(k, p.smoothD) };
    },
  },
  {
    id: "macd",
    name: "MACD",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "fast", label: "Fast length", type: "int", default: 12 },
      { key: "slow", label: "Slow length", type: "int", default: 26 },
      { key: "signal", label: "Signal smoothing", type: "int", default: 9 },
      src,
    ],
    outputs: [
      hist("hist", "Histogram", "#26a69a"),
      line("macd", "MACD", "#2962ff"),
      line("signal", "Signal", "#ff6d00"),
    ],
    calc: (bars, p) => {
      return macdFrom(source(bars, p.source), p);
    },
  },
  {
    id: "cci",
    name: "Commodity Channel Index (CCI)",
    group: "Momentum",
    overlay: false,
    inputs: [len(20), { ...src, default: "hlc3" }],
    outputs: [line("value", "CCI", "#2962ff")],
    levels: [-100, 0, 100],
    calc: (bars, p) => {
      const s = source(bars, p.source),
        m = sma(s, p.length),
        d = dev(s, p.length);
      return { value: s.map((v, i) => (v - m[i]) / (0.015 * d[i])) };
    },
  },
  {
    id: "willr",
    name: "Williams %R",
    group: "Momentum",
    overlay: false,
    inputs: [len(14)],
    outputs: [line("value", "%R", "#7e57c2")],
    levels: [-80, -50, -20],
    calc: (bars, p) => {
      const hh = highest(source(bars, "high"), p.length),
        ll = lowest(source(bars, "low"), p.length);
      return {
        value: bars.map((b, i) => (100 * (b.close - hh[i])) / (hh[i] - ll[i])),
      };
    },
  },
  {
    id: "roc",
    name: "Rate Of Change (ROC)",
    group: "Momentum",
    overlay: false,
    inputs: [len(9), src],
    outputs: [line("value", "ROC", "#2962ff")],
    levels: [0],
    calc: (bars, p) => {
      const s = source(bars, p.source);
      return {
        value: s.map((v, i) =>
          i >= p.length ? (100 * (v - s[i - p.length])) / s[i - p.length] : N,
        ),
      };
    },
  },
  {
    id: "mom",
    name: "Momentum",
    group: "Momentum",
    overlay: false,
    inputs: [len(10), src],
    outputs: [line("value", "Momentum", "#2962ff")],
    levels: [0],
    calc: (bars, p) => ({ value: change(source(bars, p.source), p.length) }),
  },
  {
    id: "mfi",
    name: "Money Flow Index (MFI)",
    group: "Volume",
    overlay: false,
    inputs: [len(14)],
    outputs: [line("value", "MFI", "#7e57c2")],
    levels: [20, 50, 80],
    calc: (bars, p) => {
      const tp = source(bars, "hlc3"),
        ch = change(tp);
      const up = sum(
        bars.map((b, i) =>
          isNum(ch[i]) ? (ch[i] <= 0 ? 0 : (b.volume || 0) * tp[i]) : N,
        ),
        p.length,
      );
      const dn = sum(
        bars.map((b, i) =>
          isNum(ch[i]) ? (ch[i] >= 0 ? 0 : (b.volume || 0) * tp[i]) : N,
        ),
        p.length,
      );
      return {
        value: up.map((u, i) =>
          dn[i] === 0 ? 100 : 100 - 100 / (1 + u / dn[i]),
        ),
      };
    },
  },
  {
    id: "cmo",
    name: "Chande Momentum Oscillator",
    group: "Momentum",
    overlay: false,
    inputs: [len(9), src],
    outputs: [line("value", "CMO", "#2962ff")],
    levels: [-50, 0, 50],
    calc: (bars, p) => {
      const ch = change(source(bars, p.source));
      const su = sum(
          ch.map((v) => (isNum(v) ? Math.max(v, 0) : N)),
          p.length,
        ),
        sd = sum(
          ch.map((v) => (isNum(v) ? Math.max(-v, 0) : N)),
          p.length,
        );
      return { value: su.map((u, i) => (100 * (u - sd[i])) / (u + sd[i])) };
    },
  },
  {
    id: "trix",
    name: "TRIX",
    group: "Momentum",
    overlay: false,
    inputs: [len(18)],
    outputs: [line("value", "TRIX", "#f23645")],
    levels: [0],
    calc: (bars, p) => {
      const l = bars.map((b) => Math.log(b.close));
      return {
        value: change(ema(ema(ema(l, p.length), p.length), p.length)).map(
          (v) => 10000 * v,
        ),
      };
    },
  },
  {
    id: "ao",
    name: "Awesome Oscillator",
    group: "Momentum",
    overlay: false,
    inputs: [],
    outputs: [hist("value", "AO", "#26a69a")],
    calc: (bars) => {
      const hl2 = source(bars, "hl2"),
        slow = sma(hl2, 34),
        v = sma(hl2, 5).map((x, i) => x - slow[i]);
      return {
        value: v,
        colors: v.map((x, i) => (i && x >= v[i - 1] ? "#26a69a" : "#ef5350")),
      };
    },
  },
  {
    id: "uo",
    name: "Ultimate Oscillator",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "fast", label: "Fast", type: "int", default: 7 },
      { key: "middle", label: "Middle", type: "int", default: 14 },
      { key: "slow", label: "Slow", type: "int", default: 28 },
    ],
    outputs: [line("value", "UO", "#f23645")],
    levels: [30, 50, 70],
    calc: (bars, p) => {
      const bp = bars.map((b, i) =>
        i ? b.close - Math.min(b.low, bars[i - 1].close) : N,
      );
      const trr = bars.map((b, i) =>
        i
          ? Math.max(b.high, bars[i - 1].close) -
            Math.min(b.low, bars[i - 1].close)
          : N,
      );
      const avg = (n) => {
        const t = sum(trr, n);
        return sum(bp, n).map((v, i) => v / t[i]);
      };
      const a = avg(p.fast),
        b = avg(p.middle),
        c = avg(p.slow);
      return { value: a.map((v, i) => (100 * (4 * v + 2 * b[i] + c[i])) / 7) };
    },
  },
  {
    id: "tsi",
    name: "True Strength Index",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "long", label: "Long length", type: "int", default: 25 },
      { key: "short", label: "Short length", type: "int", default: 13 },
      { key: "signal", label: "Signal length", type: "int", default: 13 },
    ],
    outputs: [
      line("value", "TSI", "#2962ff"),
      line("signal", "Signal", "#f23645"),
    ],
    levels: [0],
    calc: (bars, p) => {
      const pc = change(source(bars, "close"));
      const num = ema(ema(pc, p.long), p.short),
        den = ema(ema(pc.map(Math.abs), p.long), p.short);
      const value = num.map((v, i) => (100 * v) / den[i]);
      return { value, signal: ema(value, p.signal) };
    },
  },
  {
    id: "ppo",
    name: "Price Oscillator (PPO)",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "fast", label: "Fast", type: "int", default: 12 },
      { key: "slow", label: "Slow", type: "int", default: 26 },
      { key: "signal", label: "Signal", type: "int", default: 9 },
      src,
    ],
    outputs: [
      line("value", "PPO", "#2962ff"),
      line("signal", "Signal", "#ff6d00"),
    ],
    levels: [0],
    calc: (bars, p) => {
      const s = source(bars, p.source),
        f = ema(s, p.fast),
        sl = ema(s, p.slow);
      const value = f.map((v, i) => ((v - sl[i]) / sl[i]) * 100);
      return { value, signal: ema(value, p.signal) };
    },
  },
  {
    id: "coppock",
    name: "Coppock Curve",
    group: "Momentum",
    overlay: false,
    inputs: [
      { key: "wma", label: "WMA length", type: "int", default: 10 },
      { key: "long", label: "Long ROC", type: "int", default: 14 },
      { key: "short", label: "Short ROC", type: "int", default: 11 },
    ],
    outputs: [line("value", "Coppock", "#2962ff")],
    levels: [0],
    calc: (bars, p) => {
      const c = source(bars, "close"),
        roc = (n) =>
          c.map((v, i) => (i >= n ? (100 * (v - c[i - n])) / c[i - n] : N));
      const l = roc(p.long),
        s = roc(p.short);
      return {
        value: wma(
          l.map((v, i) => v + s[i]),
          p.wma,
        ),
      };
    },
  },
  {
    id: "elder",
    name: "Elder Ray (Bull/Bear Power)",
    group: "Momentum",
    overlay: false,
    inputs: [len(13)],
    outputs: [
      hist("bull", "Bull power", "#26a69a"),
      hist("bear", "Bear power", "#ef5350"),
    ],
    levels: [0],
    calc: (bars, p) => {
      const e = ema(source(bars, "close"), p.length);
      return {
        bull: bars.map((b, i) => b.high - e[i]),
        bear: bars.map((b, i) => b.low - e[i]),
      };
    },
  },
  {
    id: "bop",
    name: "Balance of Power",
    group: "Momentum",
    overlay: false,
    inputs: [],
    outputs: [line("value", "BOP", "#f23645")],
    levels: [0],
    calc: (bars) => ({
      value: bars.map((b) =>
        b.high === b.low ? 0 : (b.close - b.open) / (b.high - b.low),
      ),
    }),
  },
  {
    id: "dmi",
    name: "Directional Movement (DMI / ADX)",
    group: "Trend",
    overlay: false,
    inputs: [
      { key: "diLength", label: "DI length", type: "int", default: 14 },
      { key: "adxSmoothing", label: "ADX smoothing", type: "int", default: 14 },
    ],
    outputs: [
      line("adx", "ADX", "#f23645"),
      line("plus", "+DI", "#2962ff"),
      line("minus", "-DI", "#ff6d00"),
    ],
    calc: (bars, p) => dmiOf(bars, p.diLength, p.adxSmoothing),
  },
  {
    id: "adx",
    name: "Average Directional Index (ADX)",
    group: "Trend",
    overlay: false,
    inputs: [
      { key: "diLength", label: "DI length", type: "int", default: 14 },
      { key: "adxSmoothing", label: "ADX smoothing", type: "int", default: 14 },
    ],
    outputs: [line("adx", "ADX", "#f23645")],
    levels: [20, 25],
    calc: (bars, p) => ({ adx: dmiOf(bars, p.diLength, p.adxSmoothing).adx }),
  },
  {
    id: "aroon",
    name: "Aroon",
    group: "Trend",
    overlay: false,
    inputs: [len(14)],
    outputs: [
      line("up", "Aroon up", "#ff6d00"),
      line("down", "Aroon down", "#2962ff"),
    ],
    calc: (bars, p) => {
      const hb = extremeBars(
        source(bars, "high"),
        p.length + 1,
        (a, b) => a > b,
      );
      const lb = extremeBars(
        source(bars, "low"),
        p.length + 1,
        (a, b) => a < b,
      );
      return {
        up: hb.map((v) => (100 * (v + p.length)) / p.length),
        down: lb.map((v) => (100 * (v + p.length)) / p.length),
      };
    },
  },
  {
    id: "vortex",
    name: "Vortex Indicator",
    group: "Trend",
    overlay: false,
    inputs: [len(14)],
    outputs: [
      line("plus", "VI +", "#2962ff"),
      line("minus", "VI -", "#e91e63"),
    ],
    calc: (bars, p) => {
      const vmp = sum(
        bars.map((b, i) => (i ? Math.abs(b.high - bars[i - 1].low) : N)),
        p.length,
      );
      const vmm = sum(
        bars.map((b, i) => (i ? Math.abs(b.low - bars[i - 1].high) : N)),
        p.length,
      );
      const str = sum(
        tr(bars).map((v, i) => (i ? v : N)),
        p.length,
      );
      return {
        plus: vmp.map((v, i) => v / str[i]),
        minus: vmm.map((v, i) => v / str[i]),
      };
    },
  },
  {
    id: "chop",
    name: "Choppiness Index",
    group: "Trend",
    overlay: false,
    inputs: [len(14)],
    outputs: [line("value", "CHOP", "#2962ff")],
    levels: [38.2, 61.8],
    calc: (bars, p) => {
      const s = sum(tr(bars), p.length),
        hh = highest(source(bars, "high"), p.length),
        ll = lowest(source(bars, "low"), p.length);
      return {
        value: s.map(
          (v, i) =>
            (100 * Math.log10(v / (hh[i] - ll[i]))) / Math.log10(p.length),
        ),
      };
    },
  },
  {
    id: "mass",
    name: "Mass Index",
    group: "Trend",
    overlay: false,
    inputs: [len(10)],
    outputs: [line("value", "Mass", "#2962ff")],
    calc: (bars, p) => {
      const span = bars.map((b) => b.high - b.low),
        e1 = ema(span, 9),
        e2 = ema(e1, 9);
      return {
        value: sum(
          e1.map((v, i) => v / e2[i]),
          p.length,
        ),
      };
    },
  },
  {
    id: "psar",
    name: "Parabolic SAR",
    group: "Trend",
    overlay: true,
    inputs: [
      { key: "start", label: "Start", type: "float", default: 0.02 },
      { key: "inc", label: "Increment", type: "float", default: 0.02 },
      { key: "max", label: "Max value", type: "float", default: 0.2 },
    ],
    outputs: [line("value", "SAR", "#2962ff", { dots: true })],
    calc: (bars, p) => ({ value: psarOf(bars, p.start, p.inc, p.max) }),
  },
  {
    id: "supertrend",
    name: "Supertrend",
    group: "Trend",
    overlay: true,
    inputs: [
      { key: "atrLength", label: "ATR length", type: "int", default: 10 },
      { key: "factor", label: "Factor", type: "float", default: 3 },
    ],
    outputs: [
      line("up", "Up trend", "#26a69a", { lineWidth: 2 }),
      line("down", "Down trend", "#ef5350", { lineWidth: 2 }),
    ],
    calc: (bars, p) => {
      const { st, dir } = supertrendOf(bars, p.factor, p.atrLength);
      return {
        up: st.map((v, i) => (dir[i] < 0 ? v : N)),
        down: st.map((v, i) => (dir[i] > 0 ? v : N)),
        direction: dir,
      };
    },
  },
  {
    id: "ichimoku",
    name: "Ichimoku Cloud",
    group: "Trend",
    overlay: true,
    inputs: [
      { key: "conversion", label: "Conversion line", type: "int", default: 9 },
      { key: "base", label: "Base line", type: "int", default: 26 },
      { key: "spanB", label: "Leading span B", type: "int", default: 52 },
      { key: "displacement", label: "Lagging span", type: "int", default: 26 },
    ],
    outputs: [
      line("conversion", "Conversion", "#2962ff"),
      line("base", "Base", "#b71c1c"),
      line("lagging", "Lagging span", "#43a047"),
      line("spanA", "Leading span A", "#a5d6a7"),
      line("spanB", "Leading span B", "#ef9a9a"),
    ],
    calc: (bars, p) => {
      const hi = source(bars, "high"),
        lo = source(bars, "low");
      const mid = (n) => {
        const ll = lowest(lo, n);
        return highest(hi, n).map((v, i) => (v + ll[i]) / 2);
      };
      const conversion = mid(p.conversion),
        base = mid(p.base);
      const a = conversion.map((v, i) => (v + base[i]) / 2),
        b = mid(p.spanB);
      const off = p.displacement - 1;
      return {
        conversion,
        base,
        lagging: shiftForward(source(bars, "close"), -off),
        spanA: shiftForward(a, off),
        spanB: shiftForward(b, off),
        extendBars: off,
      };
    },
  },
  {
    id: "pivots",
    name: "Pivot Points Standard",
    noAutoscale: true,
    group: "Trend",
    overlay: true,
    inputs: [
      {
        key: "period",
        label: "Pivot period",
        type: "select",
        options: ["auto", "day", "week", "month", "year"],
        default: "auto",
      },
    ],
    outputs: [
      line("r3", "R3", "#ef5350", { lineWidth: 1 }),
      line("r2", "R2", "#ef5350", { lineWidth: 1 }),
      line("r1", "R1", "#ef5350", { lineWidth: 1 }),
      line("p", "P", "#ff9800", { lineWidth: 1 }),
      line("s1", "S1", "#26a69a", { lineWidth: 1 }),
      line("s2", "S2", "#26a69a", { lineWidth: 1 }),
      line("s3", "S3", "#26a69a", { lineWidth: 1 }),
    ],
    calc: (bars, p) => pivotsOf(bars, p.period),
  },
  {
    id: "volume",
    name: "Volume",
    volumeFormat: true,
    group: "Volume",
    overlay: false,
    inputs: [
      {
        key: "maLength",
        label: "MA length (0 = off)",
        type: "int",
        default: 20,
        min: 0,
      },
    ],
    outputs: [
      hist("value", "Volume", "#26a69a"),
      line("ma", "Volume MA", "#2962ff", { lineWidth: 1 }),
    ],
    calc: (bars, p) => {
      const v = source(bars, "volume");
      return {
        value: v,
        colors: bars.map((b) =>
          b.close >= b.open ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
        ),
        ma: p.maLength > 0 ? sma(v, p.maLength) : v.map(() => N),
      };
    },
  },
  {
    id: "obv",
    name: "On Balance Volume (OBV)",
    volumeFormat: true,
    group: "Volume",
    overlay: false,
    inputs: [],
    outputs: [line("value", "OBV", "#2962ff")],
    calc: (bars) => ({
      value: cum(
        bars.map((b, i) =>
          i ? Math.sign(b.close - bars[i - 1].close) * (b.volume || 0) : 0,
        ),
      ),
    }),
  },
  {
    id: "cmf",
    name: "Chaikin Money Flow",
    group: "Volume",
    overlay: false,
    inputs: [len(20)],
    outputs: [line("value", "CMF", "#43a047")],
    levels: [0],
    calc: (bars, p) => {
      const ad = bars.map((b) =>
        b.high === b.low
          ? 0
          : ((2 * b.close - b.low - b.high) / (b.high - b.low)) *
            (b.volume || 0),
      );
      const sv = sum(source(bars, "volume"), p.length);
      return {
        value: sum(ad, p.length).map((v, i) => (sv[i] ? v / sv[i] : 0)),
      };
    },
  },
  {
    id: "ad",
    name: "Accumulation/Distribution",
    volumeFormat: true,
    group: "Volume",
    overlay: false,
    inputs: [],
    outputs: [line("value", "A/D", "#999915")],
    calc: (bars) => ({
      value: cum(
        bars.map((b) =>
          b.high === b.low
            ? 0
            : ((2 * b.close - b.low - b.high) / (b.high - b.low)) *
              (b.volume || 0),
        ),
      ),
    }),
  },
  {
    id: "pvt",
    name: "Price Volume Trend",
    volumeFormat: true,
    group: "Volume",
    overlay: false,
    inputs: [],
    outputs: [line("value", "PVT", "#2962ff")],
    calc: (bars) => ({
      value: cum(
        bars.map((b, i) =>
          i
            ? ((b.close - bars[i - 1].close) / bars[i - 1].close) *
              (b.volume || 0)
            : 0,
        ),
      ),
    }),
  },
  {
    id: "eom",
    name: "Ease of Movement",
    group: "Volume",
    overlay: false,
    inputs: [
      len(14),
      { key: "divisor", label: "Divisor", type: "int", default: 10000 },
    ],
    outputs: [line("value", "EOM", "#43a047")],
    levels: [0],
    calc: (bars, p) => {
      const hl2 = source(bars, "hl2"),
        ch = change(hl2);
      return {
        value: sma(
          bars.map((b, i) =>
            b.volume ? (p.divisor * ch[i] * (b.high - b.low)) / b.volume : 0,
          ),
          p.length,
        ),
      };
    },
  },
  {
    // Lewis's hedge fund method: label each bar bull, bear or sideways by its trailing return,
    // count how often each state follows each other one, and read tomorrow's odds from today's
    // row. Walk-forward: each bar only uses transitions that had already happened.
    id: "markov",
    name: "Markov Regime (bull, bear, sideways)",
    group: "Quant (bonus)",
    overlay: false,
    inputs: [
      { key: "lookback", label: "Trailing return (bars)", type: "int", default: 20, min: 2 },
      { key: "threshold", label: "Bull/bear threshold %", type: "float", default: 5 },
      { key: "minHistory", label: "Transitions before odds show", type: "int", default: 50, min: 5 },
    ],
    outputs: [hist("signal", "Bull minus bear odds", "#9598a1"), line("pbull", "Odds of bull next", "#26a69a"), line("pbear", "Odds of bear next", "#ef5350")],
    levels: [0],
    calc: (bars, p) => {
      const n = bars.length, th = p.threshold / 100;
      const state = new Array(n).fill(N), signal = new Array(n).fill(N), pbull = new Array(n).fill(N), pbear = new Array(n).fill(N), colors = new Array(n).fill("#9598a1");
      const counts = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // rows: from bear, sideways, bull
      let seen = 0;
      for (let i = p.lookback; i < n; i++) {
        const r = bars[i].close / bars[i - p.lookback].close - 1;
        state[i] = r >= th ? 1 : r <= -th ? -1 : 0;
        if (Number.isFinite(state[i - 1])) { counts[state[i - 1] + 1][state[i] + 1]++; seen++; }
        const row = counts[state[i] + 1], total = row[0] + row[1] + row[2];
        colors[i] = state[i] === 1 ? "#26a69a" : state[i] === -1 ? "#ef5350" : "#9598a1";
        if (seen >= p.minHistory && total > 0) {
          pbull[i] = row[2] / total; pbear[i] = row[0] / total; signal[i] = pbull[i] - pbear[i];
        }
      }
      return { signal, pbull, pbear, state, colors };
    },
  },
  {
    id: "vpvr",
    name: "Volume Profile, visible range (VPVR)",
    group: "Volume",
    overlay: true,
    inputs: [
      { key: "rows", label: "Rows", type: "int", default: 24, min: 4 },
      { key: "width", label: "Width (% of chart)", type: "int", default: 30, min: 5 },
      { key: "valueArea", label: "Value area %", type: "int", default: 70, min: 10 },
    ],
    outputs: [],
    calc: (bars, p) => ({ volumeProfile: { rows: p.rows, width: p.width, valueArea: p.valueArea } }),
  },
  {
    id: "patterns",
    name: "Candlestick Patterns",
    group: "Patterns",
    overlay: true,
    inputs: [],
    outputs: [],
    calc: (bars) => ({ markers: candlePatterns(bars) }),
  },
];

function macdFrom(s, p) {
  const f = ema(s, p.fast),
    sl = ema(s, p.slow);
  const macd = f.map((v, i) => v - sl[i]);
  const signal = ema(macd, p.signal);
  const histv = macd.map((v, i) => v - signal[i]);
  const colors = histv.map((v, i) => {
    const prev = i ? histv[i - 1] : 0;
    if (v >= 0) return v >= prev ? "#26a69a" : "#b2dfdb";
    return v <= prev ? "#ef5350" : "#ffcdd2";
  });
  return { macd, signal, hist: histv, colors };
}

function dmiOf(bars, diLen, adxLen) {
  const t = tr(bars);
  const plusDM = bars.map((b, i) => {
    if (!i) return N;
    const up = b.high - bars[i - 1].high,
      down = bars[i - 1].low - b.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = bars.map((b, i) => {
    if (!i) return N;
    const up = b.high - bars[i - 1].high,
      down = bars[i - 1].low - b.low;
    return down > up && down > 0 ? down : 0;
  });
  const trur = rma(
    t.map((v, i) => (i ? v : N)),
    diLen,
  );
  const plus = rma(plusDM, diLen).map((v, i) => (100 * v) / trur[i]);
  const minus = rma(minusDM, diLen).map((v, i) => (100 * v) / trur[i]);
  const dx = plus.map((v, i) => {
    const s = v + minus[i];
    return Math.abs(v - minus[i]) / (s === 0 ? 1 : s);
  });
  return { plus, minus, adx: rma(dx, adxLen).map((v) => 100 * v) };
}

function psarOf(bars, start, inc, max) {
  const out = new Array(bars.length).fill(N);
  if (bars.length < 2) return out;
  let up = bars[1].close >= bars[0].close;
  let af = start,
    ep = up ? bars[0].high : bars[0].low,
    sar = up ? bars[0].low : bars[0].high;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i],
      p = bars[i - 1];
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, p.low, i > 1 ? bars[i - 2].low : p.low);
      if (b.low < sar) {
        up = false;
        sar = ep;
        ep = b.low;
        af = start;
      } else if (b.high > ep) {
        ep = b.high;
        af = Math.min(af + inc, max);
      }
    } else {
      sar = Math.max(sar, p.high, i > 1 ? bars[i - 2].high : p.high);
      if (b.high > sar) {
        up = true;
        sar = ep;
        ep = b.high;
        af = start;
      } else if (b.low < ep) {
        ep = b.low;
        af = Math.min(af + inc, max);
      }
    }
    out[i] = sar;
  }
  return out;
}

function supertrendOf(bars, factor, atrLen) {
  const a = atr(bars, atrLen);
  const st = new Array(bars.length).fill(N),
    dir = new Array(bars.length).fill(N);
  let prevUpper = N,
    prevLower = N,
    prevSt = N;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i],
      mid = (b.high + b.low) / 2;
    if (!isNum(a[i])) continue;
    let upper = mid + factor * a[i],
      lower = mid - factor * a[i];
    const prevClose = i ? bars[i - 1].close : N;
    if (isNum(prevLower))
      lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    if (isNum(prevUpper))
      upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    let d;
    if (!isNum(prevSt)) d = 1;
    else if (prevSt === prevUpper) d = b.close > upper ? -1 : 1;
    else d = b.close < lower ? 1 : -1;
    st[i] = d === -1 ? lower : upper;
    dir[i] = d;
    prevUpper = upper;
    prevLower = lower;
    prevSt = st[i];
  }
  return { st, dir };
}

function pivotsOf(bars, period) {
  let per = period;
  if (per === "auto") {
    const step = bars.length > 1 ? bars[1].time - bars[0].time : 86400;
    per =
      step <= 900
        ? "day"
        : step < 86400
          ? "week"
          : step < 7 * 86400
            ? "month"
            : "year";
  }
  const keys = ["p", "r1", "s1", "r2", "s2", "r3", "s3"];
  const out = Object.fromEntries(
    keys.map((k) => [k, new Array(bars.length).fill(N)]),
  );
  const colorsBreak = new Array(bars.length).fill(false);
  let key = null,
    cur = null,
    prev = null;
  bars.forEach((b, i) => {
    const k = periodKey(b.time, per);
    if (k !== key) {
      if (cur) prev = cur;
      cur = { h: b.high, l: b.low, c: b.close };
      key = k;
      colorsBreak[i] = true;
    } else {
      cur.h = Math.max(cur.h, b.high);
      cur.l = Math.min(cur.l, b.low);
      cur.c = b.close;
    }
    if (prev) {
      const P = (prev.h + prev.l + prev.c) / 3;
      out.p[i] = P;
      out.r1[i] = 2 * P - prev.l;
      out.s1[i] = 2 * P - prev.h;
      out.r2[i] = P + (prev.h - prev.l);
      out.s2[i] = P - (prev.h - prev.l);
      out.r3[i] = prev.h + 2 * (P - prev.l);
      out.s3[i] = prev.l - 2 * (prev.h - P);
    }
  });
  return { ...out, breaks: colorsBreak };
}

export const BY_ID = Object.fromEntries(INDICATORS.map((d) => [d.id, d]));

export function defaults(id) {
  const def = BY_ID[id];
  return Object.fromEntries((def?.inputs || []).map((i) => [i.key, i.default]));
}

// Compute an indicator. Unknown params fall back to defaults; returns { outputKey: number[] , markers? }.
export function compute(id, bars, params = {}) {
  const def = BY_ID[id];
  if (!def) throw new Error(`Unknown indicator: ${id}`);
  const p = { ...defaults(id), ...params };
  return def.calc(bars, p, ta);
}

// Custom indicators (files in /custom) register here. calc(bars, params, ta) gets the helpers.
export function registerIndicator(def) {
  if (!def?.id || typeof def.calc !== "function")
    throw new Error(
      "A custom indicator needs an id and a calc(bars, params, ta) function",
    );
  const full = {
    group: "Custom",
    overlay: true,
    inputs: [],
    outputs: [
      {
        key: "value",
        label: def.name || def.id,
        kind: "line",
        color: "#ff9800",
      },
    ],
    ...def,
  };
  const i = INDICATORS.findIndex((d) => d.id === full.id);
  if (i >= 0) INDICATORS[i] = full;
  else INDICATORS.push(full);
  BY_ID[full.id] = full;
  return full;
}

// Helpers exposed to custom indicator scripts as `ta`.
export const ta = {
  sma,
  ema,
  rma,
  wma,
  vwma,
  hma,
  dema,
  tema,
  alma,
  linreg,
  stdev,
  dev,
  highest,
  lowest,
  change,
  sum,
  rsi: rsiOf,
  atr,
  tr,
  crossover,
  crossunder,
  compute,
  source,
  macd: (s, fast = 12, slow = 26, signal = 9) =>
    macdFrom(s, { fast, slow, signal }),
  supertrend: (bars, factor = 3, len = 10) => supertrendOf(bars, factor, len),
  psar: (bars, start = 0.02, inc = 0.02, max = 0.2) =>
    psarOf(bars, start, inc, max),
  dmi: (bars, diLen = 14, adxLen = 14) => dmiOf(bars, diLen, adxLen),
};
