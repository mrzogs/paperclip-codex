// Volume profile for the visible range (TradingView's VPVR). Volume per price row for the bars on
// screen, split into up and down volume, with the point of control (busiest row) and the value
// area (the rows around it holding 70% of the volume). Redraws as you scroll or zoom.
export class VolumeProfile {
  constructor(pane, params = {}) {
    this.pane = pane;
    this.p = { rows: 24, width: 30, valueArea: 70, ...params };
    this._view = {
      zOrder: () => "bottom",
      renderer: () => ({
        draw: (target) =>
          target.useMediaCoordinateSpace(({ context, mediaSize }) =>
            this.draw(context, mediaSize),
          ),
      }),
    };
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.series = null;
  }
  updateAllViews() {}
  paneViews() {
    return [this._view];
  }

  // Exposed for tests: rows of { lo, hi, up, down } plus poc and value-area indexes.
  static profile(bars, rows, valueAreaPct) {
    let hi = -Infinity,
      lo = Infinity;
    for (const b of bars) {
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
    }
    if (!Number.isFinite(hi) || hi <= lo) return null;
    const step = (hi - lo) / rows;
    const up = new Array(rows).fill(0),
      down = new Array(rows).fill(0);
    for (const b of bars) {
      const v = b.volume || 0;
      if (!v) continue;
      const a = Math.min(rows - 1, Math.floor((b.low - lo) / step));
      const z = Math.min(rows - 1, Math.floor((b.high - lo) / step));
      const share = v / (z - a + 1);
      for (let k = a; k <= z; k++) (b.close >= b.open ? up : down)[k] += share;
    }
    const total = up.map((u, k) => u + down[k]);
    const sum = total.reduce((s, x) => s + x, 0);
    if (!sum) return null;
    let poc = 0;
    total.forEach((t, k) => {
      if (t > total[poc]) poc = k;
    });
    let inside = total[poc],
      a = poc,
      z = poc;
    while (inside < (sum * valueAreaPct) / 100 && (a > 0 || z < rows - 1)) {
      const below = a > 0 ? total[a - 1] : -1,
        above = z < rows - 1 ? total[z + 1] : -1;
      if (above >= below) inside += total[++z];
      else inside += total[--a];
    }
    return {
      lo,
      step,
      up,
      down,
      total,
      poc,
      vaLow: a,
      vaHigh: z,
      max: Math.max(...total),
    };
  }

  draw(ctx, size) {
    const pane = this.pane,
      bars = pane.shown;
    const range = pane.chart.timeScale().getVisibleLogicalRange();
    if (!bars?.length || !range || !this.series) return;
    const from = Math.max(0, Math.floor(range.from)),
      to = Math.min(bars.length - 1, Math.ceil(range.to));
    if (to <= from) return;
    const prof = VolumeProfile.profile(
      bars.slice(from, to + 1),
      Math.max(4, Math.min(200, this.p.rows | 0)),
      this.p.valueArea,
    );
    if (!prof) return;
    const W = (size.width * Math.max(5, Math.min(80, this.p.width))) / 100;
    const x0 = size.width - W;
    for (let k = 0; k < prof.total.length; k++) {
      const yTop = this.series.priceToCoordinate(prof.lo + (k + 1) * prof.step);
      const yBot = this.series.priceToCoordinate(prof.lo + k * prof.step);
      if (yTop == null || yBot == null) continue;
      const h = Math.max(1, yBot - yTop - 1);
      const inVa = k >= prof.vaLow && k <= prof.vaHigh;
      const uw = (prof.up[k] / prof.max) * W,
        dw = (prof.down[k] / prof.max) * W;
      ctx.fillStyle = inVa ? "rgba(8,153,129,0.45)" : "rgba(8,153,129,0.2)";
      ctx.fillRect(x0 + W - uw - dw, yTop, uw, h);
      ctx.fillStyle = inVa ? "rgba(242,54,69,0.45)" : "rgba(242,54,69,0.2)";
      ctx.fillRect(x0 + W - dw, yTop, dw, h);
    }
    const yPoc = this.series.priceToCoordinate(
      prof.lo + (prof.poc + 0.5) * prof.step,
    );
    if (yPoc != null) {
      ctx.strokeStyle = "#ff9800";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yPoc);
      ctx.lineTo(size.width, yPoc);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ff9800";
      ctx.font = "10px -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("POC", size.width - 4, yPoc - 4);
    }
  }
}
