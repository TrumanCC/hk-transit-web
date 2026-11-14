/* Route search for the web page: a line-by-line port of hktr/router.py.
 *
 * Everything that is modelling rather than search (each route's time model, MTR station
 * pairs, calibration, constants) arrives pre-computed in data/net.json from
 * scripts/export_web.py, so the Python and JavaScript planners give the same answers.
 * web/test/golden.mjs checks that against the Python output.
 *
 * Works in the browser (window.HKTR) and in node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HKTR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAD = Math.PI / 180;
  const PERIOD_NAME = ['peak', 'offpeak', 'sunday'];
  const WALK = 0, RIDE = 1, RAIL = 2;

  function hav(a, b) {
    const la1 = a[0] * RAD, la2 = b[0] * RAD;
    const x = Math.sin((la2 - la1) / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin((b[1] - a[1]) * RAD / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(x));
  }
  /** Python's round(): halves go to the even neighbour. */
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }
  const hhmm = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);

  function bisectLeft(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Hong Kong date and clock for a moment, whatever the device's own time zone. */
  function hkTime(ms) {
    const d = new Date((ms === undefined ? Date.now() : ms) + 8 * 3600e3);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return {
      date: `${y}${String(m).padStart(2, '0')}${String(day).padStart(2, '0')}`,
      dow: d.getUTCDay(),
      minute: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
      dayStartMs: Date.UTC(y, m - 1, day) - 8 * 3600e3,
    };
  }

  // ------------------------------------------------------------------ network
  class Net {
    constructor(d) {
      this.C = d.C;
      this.S = d.S;
      this.R = d.R;
      this.built = d.built;
      this.signalsLoaded = d.signals_loaded;
      this.holidays = new Set(d.holidays);
      this.serviceDayMap = d.serviceDayMap;
      this.mtr = d.mtr;
      this.cal = d.cal || { headway: {}, ride: {}, eta: {} };
      this.t2s = d.t2s || {};
      this.VEH = d.C.VEH; this.PED = d.C.PED;
      this.routesAt = this.S.map(() => []);
      this.R.forEach((r, ri) => {
        r.sig = r.n + '\u0001' + r.d[0];
        r.s.forEach((s, pos) => this.routesAt[s].push([ri, pos]));
      });
      this.grid = new Map();
      this.S.forEach((s, i) => {
        const k = this._cell(s[1], s[2]);
        let g = this.grid.get(k);
        if (!g) this.grid.set(k, g = []);
        g.push(i);
      });
      this.special = this.S.map((s) => s[3].includes('特別班次'));
      this.stationCodes = Object.keys(this.mtr.st);
      this.mtrLegs = this.mtr.legs.map((k) => k.split('|').map((x) => {
        const [line, ab] = x.split(':'); const [a, b] = ab.split('>'); return [line, a, b];
      }));
      this._deps = new Map();
    }

    _cell(lat, lng) { return Math.trunc(lat / 0.005) + ',' + Math.trunc(lng / 0.005); }
    pos(i) { return [this.S[i][1], this.S[i][2]]; }

    /** [[stopIndex, metres]] within radius, nearest first. */
    stopsNear(p, radius) {
      const cells = Math.ceil(radius / 500) + 1;
      const cy = Math.trunc(p[0] / 0.005), cx = Math.trunc(p[1] / 0.005);
      const out = [];
      for (let dy = -cells; dy <= cells; dy++) {
        for (let dx = -cells; dx <= cells; dx++) {
          const g = this.grid.get((cy + dy) + ',' + (cx + dx));
          if (!g) continue;
          for (const i of g) {
            const d = hav(p, [this.S[i][1], this.S[i][2]]);
            if (d <= radius) out.push([i, d]);
          }
        }
      }
      return out.sort((a, b) => a[1] - b[1]);
    }

    stationsNear(p, radius) {
      const out = [];
      for (const c of this.stationCodes) {
        const s = this.mtr.st[c];
        const d = hav(p, [s[0], s[1]]);
        if (d <= radius) out.push([c, d]);
      }
      return out.sort((a, b) => a[1] - b[1]);
    }

    /** 0 = Sunday ... 6 = Saturday; public holidays count as Sunday. */
    dayIndex(t) { return this.holidays.has(t.date) ? 0 : t.dow; }

    departures(ri, day) {
      const key = ri * 8 + day;
      let out = this._deps.get(key);
      if (out) return out;
      const set = new Set();
      const freq = this.R[ri].q || {};
      for (const code in freq) {
        const pat = this.serviceDayMap[code];
        if (!pat || pat[day] !== '1') continue;
        const slots = freq[code];
        for (const start in slots) {
          const s = hhmm(start), val = slots[start];
          if (val === null || val === undefined) { set.add(s); continue; }
          let e = hhmm(val[0]);
          if (e <= s) e += 1440;
          const step = Math.max(parseInt(val[1], 10) / 60, 1);
          // the end time is itself a departure (W3 19:00-23:30 every 30 min runs a 23:30 trip)
          for (let t = s; t <= e + 1e-6; t += step) set.add(t);
        }
      }
      out = Array.from(set).sort((a, b) => a - b);
      this._deps.set(key, out);
      return out;
    }

    // ---- route helpers
    offset(r, i) { return r.cd[i] + r.cs[i] * this.VEH[0] + r.dw * Math.max(i - 1, 0); }
    rideParts(r, i, j) {
      const n = r.cs[j] - r.cs[i];
      return [r.cd[j] - r.cd[i], n, n * this.VEH[0], r.dw * Math.max(j - i - 1, 0)];
    }
    rideMin(r, i, j) { const p = this.rideParts(r, i, j); return p[0] + p[2] + p[3]; }
    fareFrom(r, i) { return i < r.f.length ? r.f[i] : null; }
    stopId(r, pos) { return this.S[r.s[pos]][0]; }

    walkParts(metres) {
      const path = metres * this.C.WALK_DETOUR;
      const n = path / 1000 * this.C.PED_SIG_PER_KM * this.C.PED_CROSS_FRACTION;
      return [path / this.C.WALK_M_PER_MIN, n, n * this.PED[0]];
    }
    walkMin(metres) { const p = this.walkParts(metres); return p[0] + p[2]; }

    // ---- MTR
    mtrRoute(a, b, per) {
      const row = this.mtr.pairs[a];
      const e = row && row[b];
      if (!e) return null;
      const k = 2 + per * 4;
      const legs = this.mtrLegs[e[k]];
      const time = e[k + 1], wait = e[k + 2], transfer = e[k + 3];
      return { time, wait, transfer, ride: time - wait - transfer, legs, nTransfers: Math.max(legs.length - 1, 0),
        fare: e[0], fareEstimated: !!e[1] };
    }
    mtrHeadway(line, per) { return (this.C.MTR_HEADWAY[line] || this.C.MTR_HEADWAY_DEFAULT)[per]; }

    // ---- calibration from logged arrivals
    stopOperator(r, stopId) {
      if (r.m === 'gmb') return 'gmb';
      if (r.co.includes('kmb') && stopId.length === 16) return 'kmb';
      if (r.co.includes('ctb') && /^\d+$/.test(stopId)) return 'ctb';
      return null;
    }
    sid(r, pos) {
      const stop = this.stopId(r, pos), op = this.stopOperator(r, stop);
      if (op === 'kmb') return `kmb|${stop}|${r.n}|${r.b}|${r.st}`;
      if (op === 'ctb') return `ctb|${stop}|${r.n}|${r.b}|1`;
      if (op === 'gmb') return `gmb|${stop}|${r.g}|${r.b === 'O' ? 1 : 2}|${pos + 1}`;
      return null;
    }
    calHeadway(r, pos, per) {
      const h = (this.cal.headway[this.sid(r, pos)] || {})[PERIOD_NAME[per]];
      return h ? { wait: h[0], p90_gap: h[1], mean: h[2] } : null;
    }
    calRide(r, i, j) {
      const a = this.stopId(r, i), src = this.stopOperator(r, a);
      if (!src) return null;
      const rkey = src === 'gmb' ? r.g : r.n;
      const bound = src === 'gmb' ? (r.b === 'O' ? 1 : 2) : r.b;
      const x = this.cal.ride[`${src}|${rkey}|${bound}|${a}|${this.stopId(r, j)}`];
      return x ? { median: x[0], p90: x[1] } : null;
    }
    calEtaError(r, pos, lead) {
      const b = this.cal.eta[this.sid(r, pos)];
      if (!b) return null;
      for (const [lo, hi, med, p90] of b) if (lo <= lead && lead < hi) return [med, p90];
      return null;
    }
  }

  // ------------------------------------------------------------------ labels
  const TIE_MIN = 0.05;     // times this close count as equal; the label with less walking wins
  /** (t, f, walk) makes (ot, of, owalk) redundant: no slower, no dearer, and on a tie no more walking. */
  function beats(t, f, walkM, ot, of, owalkM) {
    if (t > ot + TIE_MIN || f > of) return false;
    if (Math.abs(t - ot) <= TIE_MIN && f === of) return walkM <= owalkM + 1;
    return true;
  }

  /** Labels per stop or station: the (time, fare) Pareto set, plus the best label for each
   * distinct boarding service, so an option that loses on average is still carried forward
   * for the at-the-door comparison. A label is [minutes, fare, legs, routeIndex, signature, metresWalked]. */
  class LabelStore {
    constructor(C) { this.pareto = new Map(); this.diverse = new Map(); this.L = C.LABELS_PER_STOP; this.D = C.DIVERSE_PER_STOP; }

    keep(key, t, f, ri, walkM, makeLegs) {
      let label = null;
      let div = this.diverse.get(key);
      if (!div) this.diverse.set(key, div = new Map());
      const cur = div.get(ri);
      if (!cur || t < cur[0] - TIE_MIN || (Math.abs(t - cur[0]) <= TIE_MIN && walkM < cur[5] - 1)) {
        label = [t, f, makeLegs(), ri, null, walkM];
        div.set(ri, label);
        if (div.size > this.D) {
          let worstK = null, worstT = -Infinity;
          for (const [k, v] of div) if (v[0] > worstT) { worstT = v[0]; worstK = k; }
          div.delete(worstK);
        }
      }
      let lst = this.pareto.get(key);
      if (!lst) this.pareto.set(key, lst = []);
      for (const x of lst) if (beats(x[0], x[1], x[5], t, f, walkM)) return;
      if (!label) label = [t, f, makeLegs(), ri, null, walkM];
      const kept = lst.filter((x) => !beats(t, f, walkM, x[0], x[1], x[5]));
      kept.push(label);
      if (kept.length > this.L) { kept.sort((a, b) => a[0] - b[0]); kept.length = this.L; }
      this.pareto.set(key, kept);
    }

    get(key) {
      const p = this.pareto.get(key), d = this.diverse.get(key);
      if (!p && !d) return null;
      const out = p ? p.slice() : [];
      if (d) for (const v of d.values()) if (!out.includes(v)) out.push(v);
      return out;
    }

    * items() {
      const seen = new Set();
      for (const k of this.pareto.keys()) { seen.add(k); yield [k, this.get(k)]; }
      for (const k of this.diverse.keys()) if (!seen.has(k)) yield [k, this.get(k)];
    }
  }

  // ------------------------------------------------------------------ planner
  class Planner {
    constructor(net) { this.net = net; this.lastAll = []; this.lastExcluded = []; }

    nextPass(ri, pos, clock, day) {
      const net = this.net, off = net.offset(net.R[ri], pos), deps = net.departures(ri, day);
      const k = bisectLeft(deps, clock - off);
      if (k >= deps.length) return null;
      const t = deps[k] + off;
      return t - clock <= net.C.MAX_WAIT_MIN ? t : null;
    }

    _gaps(ri, pos, clock, day) {
      const net = this.net, off = net.offset(net.R[ri], pos);
      const passes = [];
      for (const d of net.departures(ri, day)) {
        const t = d + off;
        if (t >= clock - 60 && t <= clock + 150) passes.push(t);
      }
      return passes;
    }

    /** Half the typical gap between vehicles at this stop around `clock`. */
    expectedWait(ri, pos, clock, day) {
      const passes = this._gaps(ri, pos, clock, day);
      if (!passes.length) return null;
      if (passes.length === 1) return passes[0] >= clock ? Math.max(passes[0] - clock, 0) : null;
      const gaps = [];
      for (let i = 1; i < passes.length; i++) gaps.push(passes[i] - passes[i - 1]);
      gaps.sort((a, b) => a - b);
      return gaps[gaps.length >> 1] / 2;
    }

    gap(ri, pos, clock, day) {
      const passes = this._gaps(ri, pos, clock, day);
      if (passes.length < 2) return null;
      const gaps = [];
      for (let i = 1; i < passes.length; i++) gaps.push(passes[i] - passes[i - 1]);
      gaps.sort((a, b) => a - b);
      return gaps[gaps.length >> 1];
    }

    /** Expected and bad-case wait for boarding route ri at stop pos.
     * kinds: gmb_terminus (leaves when full), gmb_mid (may pass full), fixed, sparse. */
    waitModel(ri, pos, clock, day, per) {
      const net = this.net, C = net.C, r = net.R[ri];
      const p = this.nextPass(ri, pos, clock, day);
      if (p === null) return null;
      const h = this.gap(ri, pos, clock, day);
      const n = Math.max(r.s.length - 1, 1);
      const load = Math.min(1.0, 2 * pos / n);
      if (h === null) {
        const w = p - clock;
        return { kind: 'sparse', next: p, headway: null, expected: w, worst: w, fill: null, p_full: 0, skip_extra: 0, min_wait: w };
      }
      const notStarted = p - clock > h;
      if (r.m === 'gmb' && pos === 0) {
        const fill = h * C.GMB_FILL_FACTOR[per];
        const exp = notStarted ? p - clock : fill / 2;
        const worst = notStarted ? p - clock + fill : fill;
        return { kind: 'gmb_terminus', next: p, headway: h, expected: exp, worst, fill, p_full: 0, skip_extra: 0,
          min_wait: notStarted ? p - clock : 0 };
      }
      const pf = (r.m === 'gmb' ? C.GMB_FULL_P : C.BUS_FULL_P)[per] * load;
      const skipExtra = pf < 1 ? h * pf / (1 - pf) : C.MAX_WAIT_MIN;
      let k90 = 0;
      if (pf > 0) k90 = Math.max(0, Math.ceil(Math.log(C.WORST_QUANTILE_P) / Math.log(pf)) - 1);
      const obs = notStarted ? null : net.calHeadway(r, pos, per);
      const base = obs ? obs.wait : (notStarted ? p - clock : h / 2);
      const worstGap = obs ? obs.p90_gap : h;
      return { kind: r.m === 'gmb' ? 'gmb_mid' : 'fixed', next: p, headway: obs ? obs.mean : h,
        expected: base + skipExtra, worst: (notStarted ? p - clock : 0) + worstGap + h * k90,
        fill: null, p_full: pf, skip_extra: skipExtra, observed: !!obs, min_wait: notStarted ? p - clock : 0 };
    }

    period(t, minute) {
      if (this.net.dayIndex(t) === 0) return 2;
      if (t.dow === 6) return 1;
      for (const [a, b] of this.net.C.WEEKDAY_PEAKS) if (a <= minute && minute <= b) return 0;
      return 1;
    }

    /** origin, dest: [lat, lng]. depart: {date:'YYYYMMDD', dow, minute} in Hong Kong time.
     * opts: people, bags, limit, live (Map 'ri|pos' -> [clock minutes]), state ({'12B': 'just_left'|'loading'}),
     *       taxiKm (road km if known). */
    plan(origin, dest, depart, opts) {
      opts = opts || {};
      const net = this.net, C = net.C;
      const t0 = depart.minute, day = net.dayIndex(depart), per = this.period(depart, t0);
      const wmCache = new Map();
      const wm = (ri, pos, clock) => {
        const k = ri + '|' + pos + '|' + clock;
        if (!wmCache.has(k)) wmCache.set(k, this.waitModel(ri, pos, clock, day, per));
        return wmCache.get(k);
      };
      const sigOf = (label) => {
        if (label[4] === null) {
          const parts = [];
          for (const l of label[2]) if (l.k === RIDE) parts.push('R' + net.R[l.ri].sig);
          label[4] = parts.join('|');
        }
        return label[4];
      };

      const acc = net.stopsNear(origin, C.MAX_ACCESS_WALK_M);
      const egr = net.stopsNear(dest, C.MAX_ACCESS_WALK_M);
      const egrD = new Map(egr);

      // forward: first road leg from the origin
      const fwd = new LabelStore(C);
      for (const [s, d] of acc) {
        if (net.special[s]) continue;
        const w = net.walkMin(d);
        for (const [ri, pos] of net.routesAt[s]) {
          const r = net.R[ri];
          if (pos === r.s.length - 1) continue;
          const m = wm(ri, pos, t0 + w);
          if (!m) continue;
          const fare = net.fareFrom(r, pos) || 0;
          for (let j = pos + 1; j < r.s.length; j++) {
            const t = w + m.expected + net.rideMin(r, pos, j);
            fwd.keep(r.s[j], t, fare, ri, d, () => [{ k: WALK, m: d }, { k: RIDE, ri, i: pos, j }]);
          }
        }
      }

      // backward: last road leg into the destination, expected waits
      const bwd = new LabelStore(C);
      const approx = t0 + 30;
      for (const [e, d] of egr) {
        const w = net.walkMin(d);
        for (const [ri, pos] of net.routesAt[e]) {
          if (pos === 0) continue;
          const r = net.R[ri];
          for (let i = 0; i < pos; i++) {
            if (net.special[r.s[i]]) continue;
            const m = wm(ri, i, approx);
            if (!m) continue;
            const fare = net.fareFrom(r, i) || 0;
            bwd.keep(r.s[i], m.expected + net.rideMin(r, i, pos) + w, fare, ri, d,
              () => [{ k: RIDE, ri, i, j: pos }, { k: WALK, m: d }]);
          }
        }
      }

      // quick signature -> [estimate in tenths of a minute, makeLegs, metres walked].
      // Estimates within 0.1 min are a tie: take the one with less walking (same rule as router.py).
      const cands = new Map();
      const add = (est, key, walkM, make) => {
        const e = pyRound(est * 10), cur = cands.get(key);
        if (!cur || e < cur[0] || (e === cur[0] && walkM < cur[2] - 1)) cands.set(key, [e, make, walkM]);
      };

      // W
      const od = hav(origin, dest);
      if (od <= C.MAX_WALK_ONLY_M) add(net.walkMin(od), 'W', od, () => [{ k: WALK, m: od }]);
      // R
      for (const [s, labels] of fwd.items()) {
        if (!egrD.has(s)) continue;
        const dd = egrD.get(s);
        for (const lab of labels) add(lab[0] + net.walkMin(dd), sigOf(lab), lab[5] + dd, () => lab[2].concat([{ k: WALK, m: dd }]));
      }
      // RR: join at stops within transfer distance
      for (const [b, blabels] of bwd.items()) {
        for (const [a, dab] of net.stopsNear(net.pos(b), C.MAX_TRANSFER_WALK_M)) {
          const flabels = fwd.get(a);
          if (!flabels) continue;
          const wab = net.walkMin(dab);
          for (const fa of flabels) {
            for (const fb of blabels) {
              if (net.R[fa[3]].n === net.R[fb[3]].n) continue;
              add(fa[0] + wab + fb[0], sigOf(fa) + '|' + sigOf(fb), fa[5] + dab + fb[5], () => fa[2].concat([{ k: WALK, m: dab }], fb[2]));
            }
          }
        }
      }
      // stations reachable at each end
      const fst = new LabelStore(C), bst = new LabelStore(C);
      for (const [st, d] of net.stationsNear(origin, C.MAX_STATION_WALK_M)) fst.keep(st, net.walkMin(d), 0, -1, d, () => [{ k: WALK, m: d }]);
      for (const [st, d] of net.stationsNear(dest, C.MAX_STATION_WALK_M)) bst.keep(st, net.walkMin(d), 0, -1, d, () => [{ k: WALK, m: d }]);
      for (const st of net.stationCodes) {
        const sp = net.mtr.st[st];
        for (const [s, d] of net.stopsNear([sp[0], sp[1]], C.MAX_STOP_STATION_WALK_M)) {
          const w = net.walkMin(d);
          const f = fwd.get(s);
          if (f) for (const lab of f) fst.keep(st, lab[0] + w, lab[1], lab[3], lab[5] + d, () => lab[2].concat([{ k: WALK, m: d }]));
          const bk = bwd.get(s);
          if (bk) for (const lab of bk) bst.keep(st, lab[0] + w, lab[1], lab[3], lab[5] + d, () => [{ k: WALK, m: d }].concat(lab[2]));
        }
      }
      // M, RM, MR, RMR
      for (const [a, flabels] of fst.items()) {
        for (const [b, blabels] of bst.items()) {
          if (a === b) continue;
          const m = net.mtrRoute(a, b, per);
          if (!m) continue;
          const mid = 'M' + a + '\u0001' + b;
          for (const fa of flabels) {
            for (const fb of blabels) {
              const sa = sigOf(fa), sb = sigOf(fb);
              add(fa[0] + 2 * C.MTR_ACCESS_MIN + m.time + fb[0], (sa ? sa + '|' : '') + mid + (sb ? '|' + sb : ''), fa[5] + fb[5],
                () => fa[2].concat([{ k: RAIL, a, b }], fb[2]));
            }
          }
        }
      }

      let list = Array.from(cands.values());
      if (list.length) {
        let best = Infinity;
        for (const v of list) if (v[0] < best) best = v[0];
        list = list.filter((v) => v[0] / 10 <= best / 10 * 2 + 20);
      }
      const results = [];
      for (const v of list) {
        const it = this.simulate(v[1](), depart, opts.live, opts.state);
        if (it) results.push(it);
      }
      const people = opts.people || 1;
      const tx = taxiQuote(net, origin, dest, per === 0, opts.bags || 0, opts.taxiKm);
      results.push(this._taxi(tx, people));
      const everything = dedupe(results);
      let kept = pareto(everything, C);
      const keptSet = new Set(kept);
      const excluded = [];
      for (const it of everything) {
        if (keptSet.has(it)) continue;
        let by = null;
        for (const a of kept) if (dominates(a, it, C) && (!by || a.robust < by.robust)) by = a;
        excluded.push([it, by]);
      }
      const order = (a, b) => (a.robust - b.robust) || (a.fare - b.fare);
      kept.sort(order);
      excluded.sort((a, b) => order(a[0], b[0]));
      for (const it of kept) this.flagTraps(it, day, t0);
      for (const e of excluded.slice(0, 30)) this.flagTraps(e[0], day, t0);
      this.lastExcluded = excluded;
      this.lastAll = everything;
      this.lastContext = { origin, dest, depart, per, day };
      return kept.slice(0, opts.limit || 12);
    }

    firstKey(it) {
      for (const leg of it.legs) {
        if (leg.k === RIDE) return leg.ri + '|' + leg.i;
        if (leg.k === RAIL) return null;
      }
      return null;
    }

    /** Best itinerary per first boarding (service + stop), including ones that lose on average
     * but can win at a given moment (their vehicle arriving just as you reach the stop). */
    doorOptions(n, prefer) {
      n = n || 6;
      const transit = this.lastAll.filter((it) => it.kind === 'transit' && it.first && it.first.kind);
      if (!transit.length) return [];
      const perFirst = new Map();
      for (const it of transit.slice().sort((a, b) => a.robust - b.robust)) {
        const k = it.first.route + '\u0001' + it.first.stopName;
        if (!perFirst.has(k)) perFirst.set(k, it);
      }
      const all = Array.from(perFirst.values());
      let best = all.reduce((a, b) => (b.robust < a.robust ? b : a));
      if (prefer) {
        const mine = all.filter((it) => it.first.route === prefer);
        if (mine.length) best = mine.reduce((a, b) => (b.robust < a.robust ? b : a));
      }
      const bound = best.first.walk + best.first.wait_worst + best.first.after;
      const bestCase = (it) => it.first.walk + it.first.min_wait + it.first.after;
      const others = all.filter((it) => it !== best && bestCase(it) < bound).sort((a, b) => bestCase(a) - bestCase(b));
      return [best].concat(others.slice(0, n - 1));
    }

    /** Three clocks side by side:
     *   total   now: timetable, live arrivals for the first boarding, minibus state
     *   robust  arriving at random: expected waits (fill time, pass-ups included)
     *   worst   about 1 trip in 10: full waits, pass-ups, slow traffic */
    simulate(legs, depart, live, state) {
      const net = this.net, C = net.C, VEH = net.VEH, PED = net.PED;
      const liveOn = !!(live && live.size);
      state = state || {};
      const t0 = depart.minute, day = net.dayIndex(depart);
      let clock = t0, fare = 0, est = false, rides = 0;
      const segs = [], steps = [], sig = [], names = [];
      let walk = 0, wait = 0, robustExtra = 0, worstExtra = 0;
      let crossings = 0, signalsN = 0, redWait = 0, sigVar = 0;
      let first = null;
      for (const leg of legs) {
        if (leg.k === WALK) {
          if (leg.m < 1) continue;
          const [pure, ncross, red] = net.walkParts(leg.m);
          clock += pure + red; walk += pure + red; crossings += ncross; redWait += red;
          sigVar += ncross * PED[1] ** 2;
          segs.push(['walk', pure]);
          if (red > 0.05) segs.push(['red', red]);
          steps.push({ type: 'walk', metres: Math.round(leg.m * C.WALK_DETOUR), minutes: pure + red, crossings: ncross, red });
        } else if (leg.k === RIDE) {
          const r = net.R[leg.ri];
          const per = this.period(depart, clock);
          const wm = this.waitModel(leg.ri, leg.i, clock, day, per);
          if (!wm) return null;
          const isFirst = !first;
          let w, how;
          const lv = isFirst && live ? live.get(leg.ri + '|' + leg.i) : null;
          if (lv) {
            let spread = 0;
            const corrected = lv.map((e) => {
              const err = net.calEtaError(r, leg.i, e - t0);
              if (err) spread = Math.max(spread, err[1] - err[0]);
              return e + (err ? err[0] : 0);
            });
            const catchable = corrected.filter((e) => e >= clock + C.LIVE_MARGIN_MIN);
            w = catchable.length ? Math.min(...catchable) - clock : wm.expected;
            worstExtra += spread;
            how = catchable.length ? (spread ? 'live_corrected' : 'live') : 'live_missed';
          } else if (wm.kind === 'gmb_terminus') {
            const st = state[r.n];
            w = st === 'just_left' ? wm.fill : st === 'loading' ? 0 : wm.expected;
            how = st === 'just_left' ? 'just_left' : st === 'loading' ? 'loading' : 'fill_avg';
          } else if (wm.kind === 'gmb_mid' && !(isFirst && liveOn)) {
            w = wm.next - clock + wm.skip_extra;
            how = 'timetable_full';
          } else if (isFirst && liveOn) {
            w = wm.expected;
            how = 'no_live';
          } else {
            w = wm.next - clock;
            how = 'timetable';
          }
          let [run, nsig, red, dwell] = net.rideParts(r, leg.i, leg.j);
          const seen = net.calRide(r, leg.i, leg.j);
          if (seen) {
            const k = seen.median / Math.max(run + red + dwell, 0.1);
            run *= k; red *= k; dwell *= k;
          }
          const drive = run + red;
          signalsN += nsig; redWait += red;
          robustExtra += wm.expected - w;
          worstExtra += wm.worst - w;
          if (seen) worstExtra += seen.p90 - seen.median;
          else { sigVar += nsig * VEH[1] ** 2; worstExtra += (run + dwell) * (C.ROAD_P90_FACTOR - 1); }
          const board = clock + w;
          if (isFirst) {
            first = { ri: leg.ri, pos: leg.i, route: r.n, stopName: net.S[r.s[leg.i]][3], walk: clock - t0, kind: wm.kind,
              wait_now: w, min_wait: wm.min_wait, wait_exp: wm.expected, wait_worst: wm.worst, fill: wm.fill,
              board_clock: board, how };
          }
          clock = board + drive + dwell;
          const f = net.fareFrom(r, leg.i) || 0;
          fare += f; wait += w; rides += 1;
          segs.push(['wait', w], [r.m, run], ['red', red], ['dwell', dwell]);
          steps.push({ type: 'ride', ri: leg.ri, i: leg.i, j: leg.j, board, alight: clock, wait: w, how, run, signals: nsig, red, dwell,
            fare: f, headway: wm.headway, kind: wm.kind, fill: wm.fill, p_full: wm.p_full, observedRide: !!seen,
            observedHeadway: !!wm.observed, wait_exp: wm.expected, wait_worst: wm.worst });
          sig.push('R' + r.sig);
          names.push({ t: 'r', ri: leg.ri });
        } else {
          const per = this.period(depart, clock);
          const m = net.mtrRoute(leg.a, leg.b, per);
          if (!m) return null;
          fare += m.fare; est = est || m.fareEstimated;
          rides += 1 + m.nTransfers;
          if (!first) {
            const line = m.legs[0][0], hw = net.mtrHeadway(line, per);
            first = { route: line, stopName: net.mtr.st[leg.a][2] + '站', station: leg.a, walk: clock - t0 + C.MTR_ACCESS_MIN, kind: 'mtr',
              wait_now: hw / 2, wait_exp: hw / 2, wait_worst: hw, min_wait: 0, fill: null,
              board_clock: clock + C.MTR_ACCESS_MIN + hw / 2, how: 'mtr' };
          }
          const enter = clock;
          clock += C.MTR_ACCESS_MIN;
          segs.push(['walk', C.MTR_ACCESS_MIN], ['wait', m.wait], ['rail', m.ride], ['xfer', m.transfer]);
          wait += m.wait;
          worstExtra += m.wait;
          clock += m.time + C.MTR_ACCESS_MIN;
          segs.push(['walk', C.MTR_ACCESS_MIN]);
          walk += 2 * C.MTR_ACCESS_MIN;
          steps.push({ type: 'rail', a: leg.a, b: leg.b, enter, exit: clock, legs: m.legs, wait: m.wait, ride: m.ride,
            transfer: m.transfer, fare: m.fare, fareEstimated: m.fareEstimated });
          sig.push('M' + m.legs.map((l) => l[0]).join(',') + '\u0001' + leg.a + '\u0001' + leg.b);
          names.push({ t: 'm', a: leg.a, b: leg.b });
        }
      }
      const total = clock - t0;
      const it = { legs, kind: sig.length ? 'transit' : 'walk', total, robust: total + robustExtra,
        worst: total + worstExtra + 1.28 * Math.sqrt(sigVar),
        signals: signalsN, crossings, red_wait: redWait, fare, fare_estimated: est, segments: segs, steps,
        transfers: Math.max(rides - 1, 0), walk, wait, flags: [], signature: sig.length ? sig.join('|') : 'W', names };
      if (first) first.after = it.robust - first.walk - first.wait_exp;
      it.first = first || {};
      return it;
    }

    _taxi(q, people) {
      const C = this.net.C, VEH = this.net.VEH;
      return { legs: [], kind: 'taxi', taxi: q, total: q.minutes, robust: q.minutes,
        worst: (q.minutes - q.red_wait) * C.ROAD_P90_FACTOR + q.red_wait + 1.28 * Math.sqrt(q.signals * VEH[1] ** 2) + C.TAXI_HAIL_MIN,
        signals: q.signals, crossings: 0, red_wait: q.red_wait, fare: q.total / people, fare_estimated: false,
        segments: [['wait', C.TAXI_HAIL_MIN], ['taxi', q.minutes - C.TAXI_HAIL_MIN]],
        steps: [{ type: 'taxi', q }], transfers: 0, walk: 0, wait: 0, flags: [], signature: 'T', names: [], first: {} };
    }

    /** A cheaper service covers the same stretch in similar time. */
    flagTraps(it, day, t0) {
      const net = this.net, C = net.C;
      if (it._flagged) return;
      it._flagged = true;
      for (const leg of it.legs) {
        if (leg.k !== RIDE) continue;
        const r = net.R[leg.ri];
        const f = net.fareFrom(r, leg.i) || 0;
        const mine = net.rideMin(r, leg.i, leg.j);
        const aNear = net.stopsNear(net.pos(r.s[leg.i]), 150).map((x) => x[0]);
        const bNear = new Set(net.stopsNear(net.pos(r.s[leg.j]), 150).map((x) => x[0]));
        let best = null;
        for (const s of aNear) {
          for (const [ri2, p] of net.routesAt[s]) {
            const r2 = net.R[ri2];
            if (r2.n === r.n) continue;
            const f2 = net.fareFrom(r2, p);
            if (f2 === null || f2 === undefined || f - f2 < C.TRAP_FARE_GAP) continue;
            for (let q = p + 1; q < r2.s.length; q++) {
              if (!bNear.has(r2.s[q])) continue;
              if (net.rideMin(r2, p, q) <= mine + C.TRAP_TIME_SLACK && this.expectedWait(ri2, p, t0 + 10, day)) {
                if (!best || f2 < best.fare) best = { fare: f2, ri: ri2 };
              }
              break;
            }
          }
        }
        if (best) it.flags.push({ ri: leg.ri, fare: f, altRi: best.ri, altFare: best.fare });
      }
    }
  }

  // ------------------------------------------------------------------ taxi
  function taxiMeter(C, km, slowMin) {
    const units = Math.max(Math.ceil((km - 2) / 0.2 - 1e-9), 0) + Math.ceil(slowMin);
    let fare = C.TAXI_FLAGFALL;
    for (let i = 0; i < units; i++) fare += fare < C.TAXI_THRESHOLD ? C.TAXI_STEP_BEFORE : C.TAXI_STEP_AFTER;
    return Math.round(fare * 10) / 10;
  }
  const onIsland = (p) => p[0] < 22.289 && p[1] > 114.10 && p[1] < 114.26;
  const inNTE = (p) => p[0] > 22.355 && p[1] > 114.15;
  const inKowloon = (p) => p[0] >= 22.289 && p[0] <= 22.345 && p[1] > 114.13 && p[1] < 114.24;

  function taxiRoadKmOffline(C, a, b) {
    const straight = hav(a, b) / 1000;
    const [fa, fb, fc] = C.TAXI_ROAD_FACTOR;
    return straight * (fa + fb * Math.exp(-straight / fc) + (onIsland(a) !== onIsland(b) ? C.TAXI_HARBOUR_EXTRA_FACTOR : 0));
  }

  function taxiQuote(net, a, b, peak, bags, km) {
    const C = net.C, VEH = net.VEH;
    const online = km !== null && km !== undefined;
    if (!online) km = taxiRoadKmOffline(C, a, b);
    const k = peak ? 1 : 0;
    const urban = Math.min(km, C.TAXI_URBAN_KM);
    const signals = urban * C.SIG_PER_KM_URBAN;
    const red = signals * VEH[0];
    const slow = red + km * C.TAXI_SLOW_MIN_PER_KM * (peak ? 2 : 1);
    const meter = taxiMeter(C, km, slow);
    let tolls = 0;
    const notes = [];
    if (onIsland(a) !== onIsland(b)) {
      tolls += C.TAXI_HARBOUR_TOLL + C.TAXI_HARBOUR_RETURN;
      notes.push('harbour', 'harbour_return');
    } else if ((inKowloon(a) && inNTE(b)) || (inKowloon(b) && inNTE(a))) {
      tolls += C.TAXI_KLN_NT_TOLL;
      notes.push('kln_nt');
    }
    const minutes = C.TAXI_HAIL_MIN + urban / C.TAXI_URBAN_KMH[k] * 60 + (km - urban) / C.TAXI_FAST_KMH[k] * 60 + red;
    const total = meter + tolls + C.TAXI_LUGGAGE * (bags || 0);
    return { km: Math.round(km * 10) / 10, meter, tolls, total: Math.round(total * 10) / 10, minutes, notes,
      fromRoadNetwork: online, signals, red_wait: red };
  }

  // ------------------------------------------------------------------ ranking helpers
  function dedupe(items) {
    const best = new Map();
    for (const it of items) {
      const cur = best.get(it.signature);
      if (!cur || it.robust < cur.robust || (it.robust === cur.robust && (it.fare < cur.fare ||
          (it.fare === cur.fare && it.walk < cur.walk)))) best.set(it.signature, it);
    }
    return Array.from(best.values());
  }

  /** a is no worse than b on average time, bad-case time, cost, transfers and walking, and
   * better on at least one. Tolerances: 1 min average, 2 min bad case, $0.5, WALK_TOLERANCE_MIN. */
  function dominates(a, b, C) {
    const wt = C.WALK_TOLERANCE_MIN;
    const noWorse = a.robust <= b.robust + 0.5 && a.worst <= b.worst + 1 && a.fare <= b.fare + 0.5 &&
      a.transfers <= b.transfers && a.walk <= b.walk + wt;
    if (!noWorse) return false;
    return a.robust < b.robust - 1 || a.worst < b.worst - 2 || a.fare < b.fare - 0.5 ||
      a.transfers < b.transfers || a.walk < b.walk - wt;
  }

  function pareto(items, C) {
    return items.filter((b) => !items.some((a) => a !== b && dominates(a, b, C)));
  }

  // ------------------------------------------------------------------ live arrivals
  const KMB_STOP_ETA = (stop) => `https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/${stop}`;
  const CTB_ETA = (stop, route) => `https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${stop}/${route}`;
  const GMB_STOP_ETA = (stop) => `https://data.etagmb.gov.hk/eta/stop/${stop}`;

  function parseKmb(payload, route, bound, serviceType, dayStartMs) {
    const out = [];
    for (const item of payload.data || []) {
      if (item.route === route && item.dir === bound && String(item.service_type) === serviceType && item.eta) {
        out.push([(Date.parse(item.eta) - dayStartMs) / 60000, (item.rmk_tc || '').includes('原定班次')]);
      }
    }
    return out;
  }
  function parseCtb(payload, bound, dayStartMs) {
    const out = [];
    for (const item of payload.data || []) {
      if (item.dir === bound && item.eta) out.push([(Date.parse(item.eta) - dayStartMs) / 60000, false]);
    }
    return out;
  }
  function parseGmb(payload, routeId, routeSeq, stopSeq, dayStartMs) {
    const out = [];
    for (const item of payload.data || []) {
      if (String(item.route_id) === routeId && Number(item.route_seq || 0) === routeSeq && Number(item.stop_seq || 0) === stopSeq) {
        for (const e of item.eta || []) {
          out.push([(Date.parse(e.timestamp) - dayStartMs) / 60000, (e.remarks_en || '').toLowerCase() === 'scheduled']);
        }
      }
    }
    return out;
  }

  /** Live arrivals for first boardings. keys: ['ri|pos']. Returns {live: Map key -> [clock minutes],
   * status: Map key -> 'ok'|'none'|'error', sources: {kmb:{ok,fail}, ...}}. Anything unreachable is skipped. */
  async function fetchLive(net, keys, depart, fetchImpl) {
    const doFetch = fetchImpl || fetch;
    const cache = new Map();
    const sources = {};
    const mark = (src, ok) => { const s = sources[src] || (sources[src] = { ok: 0, fail: 0 }); if (ok) s.ok++; else s.fail++; };
    const get = (src, url) => {
      if (!cache.has(url)) {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
        cache.set(url, doFetch(url, ctl ? { signal: ctl.signal } : undefined)
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((j) => { mark(src, true); return j; }, (e) => { mark(src, false); throw e; })
          .finally(() => timer && clearTimeout(timer)));
      }
      return cache.get(url);
    };
    const live = new Map(), status = new Map();
    await Promise.all(keys.map(async (key) => {
      const [ri, pos] = key.split('|').map(Number);
      const r = net.R[ri];
      let arr = [];
      try {
        if (r.m === 'gmb' && r.g) {
          const seq = r.b === 'O' ? 1 : 2;
          arr = parseGmb(await get('gmb', GMB_STOP_ETA(net.stopId(r, pos))), r.g, seq, pos + 1, depart.dayStartMs);
          if (pos === 0) arr = arr.filter((a) => !a[1]);   // terminus: leaves when full, the schedule says nothing
        } else {
          const own = r.s.map((s) => net.S[s][0]);
          const lists = r.sc || { [net.stopOperator(r, own[pos])]: own };
          const jobs = [];
          for (const co in lists) {
            const stops = lists[co];
            if (stops.length !== r.s.length) continue;
            const bound = (r.bc || {})[co] || r.b;
            if (co === 'kmb') jobs.push(get('kmb', KMB_STOP_ETA(stops[pos])).then((p) => parseKmb(p, r.n, bound, r.st, depart.dayStartMs)));
            else if (co === 'ctb') jobs.push(get('ctb', CTB_ETA(stops[pos], r.n)).then((p) => parseCtb(p, bound, depart.dayStartMs)));
          }
          if (!jobs.length) { status.set(key, 'unsupported'); return; }
          const got = await Promise.allSettled(jobs);
          if (got.every((g) => g.status === 'rejected')) throw new Error('all failed');
          for (const g of got) if (g.status === 'fulfilled') arr = arr.concat(g.value);
        }
      } catch (e) {
        status.set(key, 'error');
        return;
      }
      if (arr.length) {
        live.set(key, arr.map((a) => a[0]).sort((a, b) => a - b));
        status.set(key, 'ok');
      } else status.set(key, 'none');
    }));
    return { live, status, sources };
  }

  return { Net, Planner, LabelStore, hav, hkTime, taxiQuote, taxiRoadKmOffline, fetchLive, dedupe, pareto, dominates,
    WALK, RIDE, RAIL, PERIOD_NAME };
});
