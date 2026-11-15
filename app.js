/* The page: choose a trip, see which ride to take if you leave now (live arrivals), every
 * sensible option with fares, and a one-tap trip log that feeds the calibration.
 * Search logic lives in planner.js; this file is interface only. */
(function () {
  'use strict';
  const CONFIG = window.HKTR_CONFIG || { version: 'dev', feedback: {} };
  /* Features that keep a person's own places and trips on the phone and show them again.
   * Off on the public site, so nobody sees where the previous user of a phone went. */
  const FEAT = Object.assign({ records: false, savedPlaces: false, recent: false }, CONFIG.features || {});
  const HK_BOUNDS = [22.13, 22.58, 113.82, 114.45];
  const LINE_COLOR = { TWL: '#E2231A', KTL: '#00AF41', ISL: '#0075C2', TKL: '#7E3C93', TCL: '#F3982D', TML: '#9C2E00',
    EAL: '#5EB7E8', SIL: '#CBD300', AEL: '#00888E', DRL: '#EB6EA5' };
  const KEEP_UPPER = new Set(['MTR', 'HKU', 'IFC', 'HK', 'BBI', 'PTI', 'LRT', 'KMB', 'GMB', 'HKUST', 'CUHK', 'ICC', 'II', 'III', 'IV', 'YMCA', 'HSBC', 'TKO', 'KCR']);

  const S = { net: null, planner: null, lang: 'zh-Hans', view: 'home', from: { kind: 'gps' }, to: null,
    when: { mode: 'now', day: 0, time: '' }, plan: null, live: null, liveStatus: null, liveSources: null, liveAt: 0,
    state: {}, now: null, busy: false, trip: null, msg: null, idx: null, pick: null, summary: null };
  window.__hktr = S;

  // ------------------------------------------------------------------ small helpers
  const $ = (sel, el) => (el || document).querySelector(sel);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hktr.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v === null) localStorage.removeItem('hktr.' + k); else localStorage.setItem('hktr.' + k, JSON.stringify(v)); } catch (e) { /* private mode: carry on without */ } },
  };
  function t(key, vars) {
    const L = window.I18N || {};
    let s = (L[S.lang] && L[S.lang][key]);
    if (s === undefined) s = (L['zh-Hans'] || {})[key];
    if (s === undefined) s = key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : vars[k])) : s;
  }
  const n0 = (x) => String(Math.max(0, Math.round(x)));
  const n1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const money = (x) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
  function clock(minute) {
    const m = ((Math.round(minute) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function clockMs(ms) { const x = HKTR.hkTime(ms); return clock(Math.floor(x.minute)); }
  function simp(s) { const m = S.net ? S.net.t2s : {}; let o = ''; for (const ch of s) o += m[ch] || ch; return o; }
  function titleCase(s) {
    return s.toLowerCase().replace(/[a-z][a-z']*/g, (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  }
  const stripCode = (s) => s.replace(/\s*\([A-Za-z]{1,3}-?[A-Za-z]?\d{1,4}\)\s*$/, '').replace(/\s+/g, ' ').trim();
  function nm(zh, en) {
    if (S.lang === 'en' && en) return stripCode(titleCase(en));
    return stripCode(S.lang === 'zh-Hans' ? simp(zh) : zh);
  }
  const stopName = (i) => nm(S.net.S[i][3], S.net.S[i][4]);
  const stationName = (code) => { const s = S.net.mtr.st[code]; return nm(s[2], s[3]); };
  const coLabel = (r) => r.co.map((c) => t('co_' + c)).join('/');
  const routeLabel = (r) => coLabel(r) + ' ' + r.n;
  function toast(text) {
    const old = $('.toast'); if (old) old.remove();
    const el = h('div', { class: 'toast', role: 'status' }, text);
    document.body.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ------------------------------------------------------------------ names and badges
  function badgeClass(r) {
    if (r.co.includes('kmb') && r.co.includes('ctb')) return 'b-kmbctb';
    if (r.m === 'ferry') return 'b-ferry';
    return 'b-' + r.co[0];
  }
  function routeBadge(ri, withDest) {
    const r = S.net.R[ri];
    return h('span', { class: 'badge ' + badgeClass(r) }, r.co.length === 1 ? h('small', null, coLabel(r)) : null, r.n,
      withDest ? h('small', null, '→' + nm(r.d[0], r.d[1])) : null);
  }
  function mtrBadge(a, b, lines) {
    return h('span', { class: 'badge b-mtr' }, (lines || []).map((l) => h('i', { class: 'dot', style: 'background:' + (LINE_COLOR[l] || '#888') })),
      t('mtr') + ' ' + stationName(a) + '→' + stationName(b));
  }
  function linesOf(it, n) {
    const step = it.steps.filter((s) => s.type === 'rail')[it.names.slice(0, n + 1).filter((x) => x.t === 'm').length - 1];
    return step ? step.legs.map((l) => l[0]) : [];
  }
  function nameEl(it, dupes) {
    if (it.kind === 'taxi') return h('span', { class: 'names' }, h('span', { class: 'badge b-taxi' }, t('taxi')));
    if (it.kind === 'walk') return h('span', { class: 'names' }, h('span', { class: 'badge b-walk' }, t('walk_only')));
    const out = [];
    it.names.forEach((x, i) => {
      if (i) out.push(h('span', { class: 'sep' }, '›'));
      out.push(x.t === 'r' ? routeBadge(x.ri, dupes && dupes.has(nameText(it))) : mtrBadge(x.a, x.b, linesOf(it, i)));
    });
    return h('span', { class: 'names' }, out);
  }
  function nameText(it) {
    if (it.kind === 'taxi') return t('taxi');
    if (it.kind === 'walk') return t('walk_only');
    return it.names.map((x) => (x.t === 'r' ? S.net.R[x.ri].n : t('mtr') + ' ' + stationName(x.a) + '→' + stationName(x.b))).join(' › ');
  }

  // ------------------------------------------------------------------ places
  const placeLabel = (p) => (!p ? '' : p.kind === 'gps' ? t('my_location') : p.label ? p.label : nm(p.zh, p.en));
  const samePlace = (a, b) => a && b && a.kind === b.kind && (a.kind === 'gps' || (Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5));
  const inHK = (lat, lng) => lat >= HK_BOUNDS[0] && lat <= HK_BOUNDS[1] && lng >= HK_BOUNDS[2] && lng <= HK_BOUNDS[3];
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('unsupported'));
      navigator.geolocation.getCurrentPosition((p) => resolve([p.coords.latitude, p.coords.longitude]),
        (e) => reject(e), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    });
  }
  const norm = (s) => simp(s).toLowerCase().replace(/[\s'’\-–()（）.,，]/g, '');

  // Places people name by a nickname that no stop or station carries. [zh, en, lat, lng, aliases]
  // Coordinates checked against OpenStreetMap on 2026-11-14.
  const LANDMARKS = [
    ['香港西九龍站（高鐵）', 'Hong Kong West Kowloon Station (High Speed Rail)', 22.30368, 114.16493, '高鐵站 高铁站 西九龍高鐵站 西九龙高铁站 高鐵西九龍站 xrl hsr west kowloon station'],
    ['香港中文大學', 'The Chinese University of Hong Kong', 22.42018, 114.20791, '中大 cuhk'],
    ['香港中文大學 鄭裕彤樓', 'CUHK Cheng Yu Tung Building', 22.41226, 114.21079, '中大鄭裕彤樓 鄭裕彤樓 郑裕彤楼 cheng yu tung building cuhk'],
    ['香港大學', 'The University of Hong Kong', 22.28288, 114.13786, '港大 hku'],
    ['香港科技大學', 'The Hong Kong University of Science and Technology', 22.33872, 114.26190, '科大 hkust ust'],
    ['香港理工大學', 'The Hong Kong Polytechnic University', 22.30267, 114.17754, '理大 polyu'],
    ['香港城市大學', 'City University of Hong Kong', 22.34002, 114.16972, '城大 cityu'],
    ['香港浸會大學', 'Hong Kong Baptist University', 22.33799, 114.18263, '浸大 hkbu'],
    ['嶺南大學', 'Lingnan University', 22.41236, 113.98128, '嶺大 lingnan'],
    ['香港教育大學', 'The Education University of Hong Kong', 22.46932, 114.19470, '教大 eduhk'],
    ['香港都會大學', 'Hong Kong Metropolitan University', 22.31639, 114.18020, '都大 hkmu'],
    ['香港國際機場 客運大樓', 'Hong Kong International Airport Terminal 1', 22.31580, 113.93650, '機場 机场 airport hkia'],
    ['深圳灣口岸', 'Shenzhen Bay Port', 22.50406, 113.94472, '深圳灣 shenzhen bay'],
    ['蓮塘口岸', 'Heung Yuen Wai Boundary Control Point', 22.55146, 114.15354, '蓮塘 香園圍 heung yuen wai'],
  ];
  function buildIndex() {
    const net = S.net, idx = [];
    for (const [zh, en, lat, lng, alias] of LANDMARKS) {
      idx.push({ type: 'landmark', zh, en, lat, lng, key: norm(zh) + '|' + norm(en) + '|' + alias.split(' ').map(norm).join('|') });
    }
    for (const code of net.stationCodes) {
      const s = net.mtr.st[code];
      idx.push({ type: 'station', zh: s[2], en: s[3], lat: s[0], lng: s[1], key: norm(s[2]) + '|' + norm(s[3]) + '|' + code.toLowerCase(), sub: null });
    }
    const groups = new Map();
    net.S.forEach((s, i) => {
      const base = stripCode(s[3]);
      const k = base + '|' + Math.round(s[1] * 200) + ',' + Math.round(s[2] * 200);
      let g = groups.get(k);
      if (!g) groups.set(k, g = { type: 'stop', zh: base, en: stripCode(s[4] || ''), lat: s[1], lng: s[2], members: [] });
      g.members.push(i);
    });
    for (const g of groups.values()) {
      g.key = norm(g.zh) + '|' + norm(g.en);
      idx.push(g);
    }
    S.idx = idx;
  }
  function routesAtGroup(g) {
    const set = new Set();
    for (const i of g.members) for (const [ri] of S.net.routesAt[i]) set.add(S.net.R[ri].n);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).slice(0, 7).join(' · ');
  }
  function searchLocal(q) {
    if (!S.idx) buildIndex();
    const k = norm(q);
    if (!k) return { stations: [], stops: [] };
    const inOrder = (key) => {     // every query character, in order, inside one name: 中大郑裕彤 finds 中文大學鄭裕彤樓
      for (const part of key.split('|')) {
        let i = 0;
        for (const ch of part) if (ch === k[i]) i++;
        if (i === k.length) return true;
      }
      return false;
    };
    const score = (e) => {
      const p = e.key.indexOf(k);
      if (p >= 0) return (e.key.startsWith(k) || e.key.includes('|' + k) ? 0 : 1) * 1000 + e.zh.length;
      return k.length >= 2 && /[^\x00-\x7f]/.test(k) && inOrder(e.key) ? 2000 + e.zh.length : -1;
    };
    const st = [], sp = [], lm = [];
    for (const e of S.idx) {
      const sc = score(e);
      if (sc < 0) continue;
      (e.type === 'station' ? st : e.type === 'landmark' ? lm : sp).push([sc, e]);
    }
    const top = (arr, n) => arr.sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
    return { landmarks: top(lm, 4), stations: top(st, 6), stops: top(sp, 20) };
  }
  async function fetchJson(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 7000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  /** Addresses and buildings: the government Address Lookup Service first, OpenStreetMap as a fallback. */
  /** Buildings, places and addresses. OpenStreetMap (bounded to Hong Kong) finds named places
   * such as 鄭裕彤樓 or 西九龍站; the government Address Lookup Service finds street addresses. */
  async function searchOnline(q) {
    const query = q.replace(/高[铁鐵]/g, ' ').trim() || q;
    const zh = S.lang !== 'en';
    const osm = fetchJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&addressdetails=1&namedetails=1&bounded=1&viewbox=113.82,22.58,114.45,22.13' +
      '&accept-language=' + (zh ? 'zh-HK,zh,en' : 'en') + '&q=' + encodeURIComponent(query)).then((j) => (j || []).map((a) => {
      const lat = parseFloat(a.lat), lng = parseFloat(a.lon), nd = a.namedetails || {}, ad = a.address || {};
      const name = (zh ? nd['name:zh-Hant'] || nd['name:zh'] || nd.name : nd['name:en'] || nd.name) || a.name || (a.display_name || '').split(',')[0];
      const area = [ad.suburb || ad.neighbourhood || ad.quarter || ad.village || ad.town, ad.city_district || ad.city].filter(Boolean)
        .filter((x, i, arr) => arr.indexOf(x) === i).join(zh ? '，' : ', ');
      return { kind: 'pt', lat, lng, label: S.lang === 'zh-Hans' ? simp(name) : name, sub: (S.lang === 'zh-Hans' ? simp : (x) => x)([ad.road, area].filter(Boolean).join(zh ? '，' : ', ')), src: 'osm' };
    }).filter((p) => inHK(p.lat, p.lng) && p.label)).catch(() => []);
    const als = fetchJson('https://www.als.gov.hk/lookup?n=5&q=' + encodeURIComponent(query), { headers: { Accept: 'application/json', 'Accept-Language': zh ? 'zh-Hant' : 'en' } })
      .then((j) => (j.SuggestedAddress || []).filter((a) => ((a.ValidationInformation || {}).Score || 0) >= 50).map((a) => {
        const p = (a.Address || {}).PremisesAddress || {}, g = p.GeospatialInformation || {};
        const pick = (o, chi) => {
          if (!o) return '';
          const est = (o.ChiEstate || o.EngEstate || {}).EstateName || '';
          const st = o.ChiStreet || o.EngStreet || {};
          const street = st.StreetName ? (chi ? st.StreetName + (st.BuildingNoFrom ? st.BuildingNoFrom + '號' : '') : (st.BuildingNoFrom ? st.BuildingNoFrom + ' ' : '') + st.StreetName) : '';
          return [o.BuildingName, est, street].filter(Boolean).join(chi ? ' ' : ', ');
        };
        const chi = zh && pick(p.ChiPremisesAddress, true);
        const label = chi ? (S.lang === 'zh-Hans' ? simp(chi) : chi) : titleCase(pick(p.EngPremisesAddress, false));
        return { kind: 'pt', lat: parseFloat(g.Latitude), lng: parseFloat(g.Longitude), label, sub: '', src: 'als' };
      }).filter((p) => inHK(p.lat, p.lng) && p.label)).catch(() => []);
    const [a, b] = await Promise.all([osm, als]);
    const out = [], seen = [];
    for (const p of a.concat(b)) {
      if (seen.some((x) => HKTR.hav([x.lat, x.lng], [p.lat, p.lng]) < 40 && x.label === p.label)) continue;
      seen.push(p); out.push(p);
    }
    if (!out.length && (a === null || b === null)) throw new Error('offline');
    return out.slice(0, 10);
  }

  // ------------------------------------------------------------------ planning
  const kmCache = new Map();
  async function taxiKm(a, b) {
    if (!navigator.onLine) return null;
    const k = a.map((x) => x.toFixed(4)) + '>' + b.map((x) => x.toFixed(4));
    if (kmCache.has(k)) return kmCache.get(k);
    try {
      const j = await fetchJson(`https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`, null, 2500);
      const km = j.routes[0].distance / 1000;
      kmCache.set(k, km);
      return km;
    } catch (e) { return null; }
  }
  function departTime() {
    if (S.when.mode === 'now' || !S.when.time) return HKTR.hkTime();
    const base = HKTR.hkTime(Date.now() + S.when.day * 86400e3);
    const [hh, mm] = S.when.time.split(':').map(Number);
    return { date: base.date, dow: base.dow, minute: hh * 60 + mm, dayStartMs: base.dayStartMs };
  }
  async function resolve(p) {
    if (p.kind !== 'gps') return [p.lat, p.lng];
    const pos = await locate();
    if (!inHK(pos[0], pos[1])) { const e = new Error('outside'); e.outside = true; throw e; }
    return pos;
  }
  async function runPlan(silent) {
    if (!S.from || !S.to) { S.msg = t('need_both'); return render(); }
    S.msg = null; S.busy = true;
    if (!silent) render();
    let o, d;
    try { o = await resolve(S.from); d = await resolve(S.to); } catch (e) {
      S.busy = false; S.msg = e.outside ? t('loc_outside') : t('loc_denied'); return render();
    }
    if (HKTR.hav(o, d) < 60) { S.busy = false; S.msg = t('same_place'); return render(); }
    const km = await taxiKm(o, d);
    await new Promise((r) => setTimeout(r, 30));     // let the spinner paint before the search blocks
    const depart = departTime();
    const planner = new HKTR.Planner(S.net);
    const results = planner.plan(o, d, depart, { limit: 12, taxiKm: km });
    S.planner = planner;
    S.plan = { origin: o, dest: d, depart, results, excluded: planner.lastExcluded, door: planner.doorOptions(8),
      taxi: planner.lastAll.find((x) => x.kind === 'taxi'), at: Date.now(), from: S.from, to: S.to, when: Object.assign({}, S.when) };
    if (!silent) { S.state = {}; S.live = null; S.liveStatus = null; S.liveAt = 0; rememberTrip(); }
    S.busy = false;
    computeNow();
    S.view = 'go';
    syncUrl();
    render();
    if (S.when.mode === 'now') refreshLive();
  }
  function rememberTrip() {
    if (!FEAT.recent) return;
    store.set('last', { from: S.from, to: S.to });
    const key = (x) => placeLabel(x.from) + '>' + placeLabel(x.to);
    const cur = { from: S.from, to: S.to };
    const list = [cur].concat(store.get('recent', []).filter((x) => key(x) !== key(cur))).slice(0, 8);
    store.set('recent', list);
  }
  function candidates() {
    const seen = new Set(), out = [];
    for (const it of S.plan.door.concat(S.plan.results)) {
      if (it.kind === 'taxi' || seen.has(it.signature)) continue;
      seen.add(it.signature); out.push(it);
    }
    return out;
  }
  function computeNow() {
    const P = S.plan;
    if (!P) return;
    const live = P.when.mode === 'now';
    const now = live ? HKTR.hkTime() : P.depart;
    const rows = [];
    for (const it of candidates()) {
      const sim = S.planner.simulate(it.legs, now, live ? S.live : null, S.state);
      if (sim) rows.push({ it, sim, arrive: now.minute + sim.total, worst: now.minute + sim.worst });
    }
    rows.sort((a, b) => a.sim.total - b.sim.total);
    S.now = { at: now, rows, live };
  }
  async function refreshLive() {
    const P = S.plan;
    if (!P || P.when.mode !== 'now' || S.refreshing) return;
    if (!navigator.onLine) { S.liveSources = null; computeNow(); return renderNow(); }
    S.refreshing = true;
    try {
      const keys = Array.from(new Set(candidates().map((it) => S.planner.firstKey(it)).filter(Boolean)));
      const got = await HKTR.fetchLive(S.net, keys, HKTR.hkTime());
      if (S.plan !== P) return;
      S.live = got.live; S.liveStatus = got.status; S.liveSources = got.sources; S.liveAt = Date.now();
    } catch (e) { /* keep what we had */ } finally { S.refreshing = false; }
    computeNow();
    renderNow();
  }
  setInterval(() => {
    if (S.view !== 'go' || !S.plan || S.plan.when.mode !== 'now' || document.hidden || S.busy) return;
    if (Date.now() - S.plan.at > 5 * 60e3) runPlan(true); else refreshLive();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.view === 'go' && S.plan && S.plan.when.mode === 'now' && Date.now() - S.liveAt > 20000) refreshLive();
  });

  // ------------------------------------------------------------------ text for steps
  function howText(sim, now) {
    const f = sim.first || {};
    if (sim.kind === 'walk') return t('how_walk');
    const due = f.board_clock - now.minute;
    switch (f.how) {
      case 'live': return t('how_live', { n: n0(due) });
      case 'live_corrected': return t('how_live_corrected', { n: n0(due) });
      case 'live_missed': return t('how_live_missed', { n: n0(f.wait_exp) });
      case 'no_live': return t('how_no_live', { n: n0(f.wait_exp) });
      case 'fill_avg': return t('how_fill_avg', { n: n0(f.wait_now) });
      case 'just_left': return t('how_just_left', { n: n0(f.wait_now) });
      case 'loading': return t('how_loading');
      case 'timetable_full': return t('how_timetable_full', { n: n0(due) });
      case 'mtr': return t('how_mtr', { n: n0(f.wait_now) });
      default: return t('how_timetable', { n: n0(due) });
    }
  }
  function stepItems(it) {
    const net = S.net, C = net.C;
    return it.steps.map((s) => {
      if (s.type === 'walk') {
        return h('li', null, s.crossings >= 0.5
          ? t('st_walk_x', { m: s.metres, n: n0(s.minutes), c: n1(s.crossings), r: n1(s.red) })
          : t('st_walk', { m: s.metres, n: n0(s.minutes) }));
      }
      if (s.type === 'ride') {
        const r = net.R[s.ri];
        const extra = [s.headway ? t('st_headway', { n: n0(s.headway) }) : t('st_sparse')];
        if (s.kind === 'gmb_terminus') extra.push(t('st_fill', { n: n0(s.fill) }));
        else if (s.kind === 'gmb_mid' && s.p_full > 0) extra.push(t('st_pfull', { p: n0(s.p_full * 100) }));
        if (s.observedRide) extra.push(t('st_obs_ride'));
        if (s.observedHeadway) extra.push(t('st_obs_hw'));
        if (!net.signalsLoaded && !s.observedRide) extra.push(t('st_est'));
        return h('li', null,
          t('st_ride', { t: clock(s.board), label: routeLabel(r), dest: nm(r.d[0], r.d[1]), a: stopName(r.s[s.i]), k: s.j - s.i, b: stopName(r.s[s.j]) }),
          h('span', null, t('st_ride_d', { w: n0(s.wait), how: t('w_' + s.how), run: n0(s.run), s: n0(s.signals), r: n0(s.red), dw: n0(s.dwell), f: money(s.fare) })),
          h('span', null, extra.join(S.lang === 'en' ? '; ' : '；')));
      }
      if (s.type === 'rail') {
        const desc = s.legs.map((l) => nm(net.mtr.lines[l[0]][0], net.mtr.lines[l[0]][1]) + ' ' + stationName(l[1]) + '→' + stationName(l[2])).join(S.lang === 'en' ? ', ' : '，');
        return h('li', null, t('st_rail', { desc }),
          h('span', null, t('st_rail_d', { acc: n1(C.MTR_ACCESS_MIN), w: n0(s.wait), r: n0(s.ride), x: n0(s.transfer), f: money(s.fare), est: s.fareEstimated ? t('st_rail_est') : '' })));
      }
      const q = s.q;
      const tolls = q.notes.length ? (S.lang === 'en' ? ', ' : '，') + q.notes.map((x) => t('toll_' + x)).join(S.lang === 'en' ? ', ' : '，') : '';
      return h('li', null, t('st_taxi', { km: q.km, src: q.fromRoadNetwork ? t('taxi_road') : t('taxi_line'), s: n0(q.signals), r: n0(q.red_wait), m: n0(q.meter), tolls, t: n0(q.total) }));
    });
  }
  function flagItems(it) {
    return it.flags.map((f) => h('div', { class: 'flag' }, '⚠ ' + t('trap', { a: routeLabel(S.net.R[f.ri]), fa: money(f.fare), b: routeLabel(S.net.R[f.altRi]), fb: money(f.altFare) })));
  }
  function segBar(it) {
    const cls = { walk: 's-walk', wait: 's-wait', red: 's-red', dwell: 's-dwell', rail: 's-rail', xfer: 's-wait', taxi: 's-taxi' };
    const total = it.segments.reduce((a, s) => a + Math.max(s[1], 0), 0) || 1;
    return h('div', { class: 'segbar', role: 'img', 'aria-label': t('avg') + ' ' + n0(it.robust) }, it.segments.filter((s) => s[1] > 0.05).map((s) =>
      h('i', { class: cls[s[0]] || 's-ride', style: 'flex:' + (s[1] / total).toFixed(4) })));
  }

  // ------------------------------------------------------------------ views
  function setView(v) { S.view = v; if (location.hash.slice(1) !== (v === 'home' ? '' : v)) history.pushState(null, '', v === 'home' ? location.pathname + location.search : '#' + v); render(); window.scrollTo(0, 0); }
  window.addEventListener('popstate', () => { const v = location.hash.slice(1) || 'home'; S.view = (v === 'go' && !S.plan) || (v === 'trip' && !S.trip) || (v === 'log' && !FEAT.records) ? 'home' : v; closePicker(); render(); });
  function syncUrl() {
    const enc = (p) => (p.kind === 'gps' ? 'gps' : p.lat.toFixed(5) + ',' + p.lng.toFixed(5) + ',' + encodeURIComponent(placeLabel(p)));
    try { history.replaceState(null, '', location.pathname + '?from=' + enc(S.from) + '&to=' + enc(S.to) + '#go'); } catch (e) { /* file:// */ }
  }

  function renderBar() {
    const link = (v, label) => h('button', { class: 'link', 'aria-current': S.view === v ? 'page' : null, onclick: () => setView(v) }, label);
    $('#bar').replaceChildren(
      h('button', { class: 'brand', onclick: () => setView('home') }, t('app')),
      h('span', { class: 'grow' }),
      FEAT.records ? link('log', t('records')) : null, link('about', t('about')));
    document.documentElement.lang = S.lang;
    document.title = t('app') + (S.lang === 'en' ? ' | Hong Kong trips' : '｜' + (S.lang === 'zh-Hans' ? '香港出门路线' : '香港出門路線'));
  }
  function render() {
    renderBar();
    const app = $('#app');
    if (!S.net) return;
    const v = S.view;
    app.replaceChildren(...(v === 'go' ? viewGo() : v === 'trip' ? viewTrip() : v === 'log' ? viewLog() : v === 'about' ? viewAbout() : viewHome()));
    if (v === 'go') renderNow();
  }

  // ---- home
  function placeButton(which) {
    const p = S[which];
    return h('button', { class: 'place', id: 'pick-' + which, onclick: () => openPicker(which) },
      h('span', { class: 'tag' }, t(which)),
      h('span', { class: 'val' + (p ? '' : ' empty') }, p ? placeLabel(p) : t('choose_' + which)));
  }
  function viewHome() {
    const out = [];
    if (S.trip) out.push(h('div', { class: 'notice rowx' }, h('span', { style: 'flex:1' }, t('resume_trip')), h('button', { class: 'btn slim', onclick: () => setView('trip') }, t('resume'))));
    const whenRow = h('div', { class: 'when' },
      h('div', { class: 'seg', role: 'group' },
        h('button', { 'aria-pressed': String(S.when.mode === 'now'), onclick: () => { S.when.mode = 'now'; render(); } }, t('depart_now')),
        h('button', { 'aria-pressed': String(S.when.mode === 'at'), onclick: () => { S.when.mode = 'at'; if (!S.when.time) S.when.time = clock(HKTR.hkTime().minute + 10); render(); } }, t('depart_at'))),
      S.when.mode === 'at' ? [
        h('select', { id: 'when-day', 'aria-label': t('depart_at'), onchange: (e) => { S.when.day = Number(e.target.value); } },
          [0, 1].map((d) => h('option', { value: d, selected: S.when.day === d }, t(d ? 'tomorrow' : 'today')))),
        h('input', { id: 'when-time', type: 'time', value: S.when.time, 'aria-label': t('depart_at'), onchange: (e) => { S.when.time = e.target.value; } }),
      ] : null);
    out.push(h('section', { class: 'card stack' },
      h('div', { class: 'od' },
        h('div', { class: 'fields' }, placeButton('from'), placeButton('to')),
        h('button', { class: 'iconbtn', title: t('swap'), 'aria-label': t('swap'), onclick: () => { const a = S.from; S.from = S.to || { kind: 'gps' }; S.to = a && a.kind !== 'gps' ? a : S.to && a ? a : null; render(); } }, '⇅')),
      whenRow,
      S.msg ? h('div', { class: 'notice err', role: 'alert' }, S.msg) : null,
      h('button', { class: 'btn', id: 'find', disabled: S.busy, onclick: () => runPlan(false) }, S.busy ? t('computing') : t('find'))));
    const savable = !FEAT.savedPlaces ? [] : [S.from, S.to].filter((p) => p && p.kind !== 'gps' && !store.get('places', []).some((x) => samePlace(Object.assign({ kind: 'pt' }, x), Object.assign({}, p, { kind: 'pt' }))));
    if (savable.length) {
      out.push(h('div', { class: 'chips' }, savable.map((p) => h('button', { class: 'chip', onclick: () => savePlaceForm(p) }, '☆ ' + t('save_place') + '：' + placeLabel(p)))));
    }
    const recent = store.get('recent', []);
    if (FEAT.recent) out.push(h('section', { class: 'card' }, h('h2', { style: 'margin:0 0 4px' }, t('recent')),
      recent.length ? h('ul', { class: 'list' }, recent.map((x) => h('li', null, h('button', { class: 'item', onclick: () => { S.from = x.from; S.to = x.to; S.when.mode = 'now'; runPlan(false); } },
        h('span', { class: 't' }, h('b', null, placeLabel(x.from) + ' → ' + placeLabel(x.to)))))))
        : h('p', { class: 'sub' }, t('no_recent'))));
    out.push(h('p', { class: 'foot' }, t('tagline')));
    return out;
  }
  function savePlaceForm(p) {
    const input = h('input', { type: 'text', id: 'place-name', value: placeLabel(p), 'aria-label': t('place_name') });
    const box = h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('div', { class: 'in' }, h('b', { style: 'flex:1' }, t('place_name')), h('button', { onclick: () => box.remove() }, t('cancel')))),
      h('div', { class: 'sheet-body' }, h('div', { class: 'stack', style: 'padding-top:12px' }, input,
        h('button', { class: 'btn', onclick: () => {
          const label = input.value.trim() || placeLabel(p);
          store.set('places', store.get('places', []).concat([{ label, lat: p.lat, lng: p.lng }]).slice(-20));
          box.remove(); toast(t('saved_ok')); render();
        } }, t('ok')))));
    document.body.append(box);
    input.focus();
  }

  // ---- place picker
  function closePicker() { const s = $('#picker'); if (s) s.remove(); S.pick = null; }
  function openPicker(which) {
    S.pick = which;
    const body = h('div');
    const input = h('input', { type: 'search', id: 'q', placeholder: t('search_ph'), autocomplete: 'off', enterkeyhint: 'search', 'aria-label': t('search_ph') });
    const choose = (p) => { S[which] = p; S.msg = null; closePicker(); render(); };
    const item = (title, sub, onclick, right) => h('li', null, h('div', { class: 'rowx' }, h('button', { class: 'item', onclick }, h('span', { class: 't' }, h('b', null, title), sub ? h('span', null, sub) : null)), right || null));
    let online = null, timer = null;
    const draw = () => {
      const q = input.value.trim();
      const out = [];
      if (!q) {
        const list = [item('◎ ' + t('my_location'), null, () => choose({ kind: 'gps' }))];
        const saved = FEAT.savedPlaces ? store.get('places', []) : [];
        saved.forEach((x, i) => list.push(item('★ ' + x.label, null, () => choose({ kind: 'pt', lat: x.lat, lng: x.lng, label: x.label }),
          h('button', { class: 'x', 'aria-label': t('remove'), onclick: () => { saved.splice(i, 1); store.set('places', saved); draw(); } }, '✕'))));
        out.push(h('ul', { class: 'list' }, list), h('p', { class: 'sub', style: 'padding-top:12px' }, t('search_hint')));
      } else {
        const r = searchLocal(q);
        if (r.landmarks.length) out.push(h('ul', { class: 'list' }, r.landmarks.map((e) => item(nm(e.zh, e.en), S.lang === 'en' ? e.zh : titleCase(e.en), () => choose({ kind: 'pt', lat: e.lat, lng: e.lng, zh: e.zh, en: e.en })))));
        if (r.stations.length) out.push(h('div', { class: 'grp' }, t('stations')), h('ul', { class: 'list' }, r.stations.map((e) => item(nm(e.zh, e.en) + t('station_suffix'), S.lang === 'en' ? e.zh : titleCase(e.en), () => choose({ kind: 'pt', lat: e.lat, lng: e.lng, zh: e.zh + '站', en: e.en + ' Station' })))));
        out.push(h('div', { class: 'grp' }, t('addresses')));
        if (online && online.q === q && !online.pending) {
          out.push(online.items.length ? h('ul', { class: 'list' }, online.items.map((p) => item(placeLabel(p), p.sub || null, () => choose(p)))) : h('p', { class: 'sub' }, online.failed ? t('online_failed') : t('no_match')));
        } else out.push(h('p', { class: 'sub' }, t('searching')));
        if (r.stops.length) out.push(h('div', { class: 'grp' }, t('stops')), h('ul', { class: 'list' }, r.stops.map((e) => item(nm(e.zh, e.en), routesAtGroup(e), () => choose({ kind: 'pt', lat: e.lat, lng: e.lng, zh: e.zh, en: e.en })))));
        if (!(online && online.q === q)) {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            if (input.value.trim() !== q || q.length < 2) return;
            online = { q, items: [], pending: true };
            try { online.items = await searchOnline(q); } catch (e) { online.failed = true; }
            online.pending = false;
            if (input.value.trim() === q) draw();
          }, 550);
        }
      }
      body.replaceChildren(...out);
    };
    input.addEventListener('input', draw);
    const sheet = h('div', { class: 'sheet', id: 'picker', role: 'dialog', 'aria-label': t('choose_' + which) },
      h('div', { class: 'sheet-head' }, h('div', { class: 'in' }, input, h('button', { onclick: closePicker }, t('cancel')))),
      h('div', { class: 'sheet-body' }, body));
    document.body.append(sheet);
    draw();
    input.focus();
  }

  // ---- results
  function viewGo() {
    const P = S.plan;
    if (!P) return viewHome();
    const whenText = P.when.mode === 'now' ? t('depart_now') : t(P.when.day ? 'tomorrow' : 'today') + ' ' + clock(P.depart.minute);
    const out = [
      h('div', { class: 'rowx' }, h('div', { style: 'flex:1;min-width:0' }, h('b', null, placeLabel(P.from) + ' → ' + placeLabel(P.to)), h('div', { class: 'sub' }, whenText)),
        h('button', { class: 'btn ghost slim', id: 'edit', onclick: () => setView('home') }, t('edit'))),
      h('section', { id: 'now', class: 'stack' }),
      h('h2', null, t('all_title')), h('p', { class: 'sub' }, t('all_sub')),
    ];
    const names = P.results.map(nameText);
    const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i));
    P.results.forEach((it, i) => out.push(optionCard(it, dupes, i)));
    out.push(h('div', { class: 'legend' }, [['s-walk', 'walk'], ['s-wait', 'wait'], ['s-ride', 'ride'], ['s-red', 'red'], ['s-dwell', 'dwell'], ['s-rail', 'rail']].map(([c, k]) =>
      h('span', null, h('i', { class: c }), LEGEND[S.lang === 'en' ? 'en' : S.lang === 'zh-Hant' ? 'hant' : 'hans'][k]))));
    if (P.excluded.length) {
      let shown = 8;
      const list = h('div');
      const draw = () => {
        list.replaceChildren(...P.excluded.slice(0, shown).map(([it, by]) => h('div', { class: 'exc' },
          h('div', { class: 'rowx wrap' }, nameEl(it, null), h('span', { class: 'muted num' }, t('mins', { n: n0(it.robust) }) + ' · $' + money(it.fare) + ' · ' + (it.transfers ? t('transfers', { n: it.transfers }) : t('direct')))),
          by ? h('div', { class: 'why' }, t('beaten_by', { name: nameText(by), t: n0(by.robust), f: money(by.fare) })) : null, flagItems(it))),
          shown < Math.min(P.excluded.length, 40) ? h('button', { class: 'btn ghost slim', style: 'margin-top:8px', onclick: () => { shown += 16; draw(); } }, t('show_more')) : null);
      };
      draw();
      out.push(h('section', { class: 'card' }, h('details', null, h('summary', null, t('excluded_title', { n: P.excluded.length })), h('p', { class: 'sub' }, t('excluded_sub')), list)));
    }
    out.push(h('p', { class: 'foot' }, t('foot_1')), h('p', { class: 'foot' }, t('foot_2')));
    return out;
  }
  const LEGEND = {
    hans: { walk: '步行', wait: '候车和转线', ride: '行车', red: '等红灯', dwell: '停站', rail: '港铁' },
    hant: { walk: '步行', wait: '候車和轉線', ride: '行車', red: '等紅燈', dwell: '停站', rail: '港鐵' },
    en: { walk: 'walk', wait: 'wait / interchange', ride: 'ride', red: 'red lights', dwell: 'at stops', rail: 'MTR' },
  };
  function optionCard(it, dupes, i) {
    const steps = h('ol', { class: 'steps' }, stepItems(it));
    const lights = it.signals + it.crossings;
    return h('article', { class: 'card opt', 'data-opt': i },
      nameEl(it, dupes),
      h('div', { class: 'metrics' },
        h('span', null, t('avg') + ' ', h('b', null, n0(it.robust)), ' ' + t('mins', { n: '' }).trim()),
        h('span', null, t('worst') + ' ', h('b', null, n0(it.worst)), ' ' + t('mins', { n: '' }).trim()),
        h('span', null, h('b', null, '$' + money(it.fare) + (it.fare_estimated ? '*' : '')), it.kind === 'taxi' ? '' : ' ' + t('per_person')),
        it.kind === 'transit' ? h('span', null, it.transfers ? t('transfers', { n: it.transfers }) : t('direct')) : null,
        it.walk >= 0.5 ? h('span', null, t('walk_total', { n: n0(it.walk) })) : null,
        lights >= 0.5 ? h('span', null, t('lights', { n: n0(lights), m: n1(it.red_wait) })) : null),
      segBar(it), flagItems(it),
      h('details', null, h('summary', null, t('details')), steps),
      it.kind === 'transit' ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost slim', onclick: () => startTrip(it) }, t('start_log'))) : null);
  }
  function renderNow() {
    const box = $('#now');
    if (!box || !S.now) return;
    const N = S.now, rows = N.rows, out = [];
    const best = rows[0];
    if (best) {
      const f = best.sim.first || {};
      const fixedTime = ['live', 'live_corrected', 'timetable', 'timetable_full'].includes(f.how);
      const kids = [h('div', { class: 'k' }, N.live ? h('span', { class: 'pulse' }) : null, N.live ? t('now_title') : t('depart_at') + ' ' + clock(N.at.minute))];
      kids.push(h('div', { class: 'take' }, best.it.kind === 'walk' ? null : t('now_take'), nameEl(best.it, null)));
      if (f.kind) {
        const where = f.kind === 'mtr' ? t('walk_to_station', { stop: stationName(f.station) + t('station_suffix'), n: n0(f.walk) }) : t('walk_to', { stop: stopName(S.net.R[f.ri].s[f.pos]), n: n0(f.walk) });
        kids.push(h('div', null, where), h('div', null, howText(best.sim, N.at)));
      } else kids.push(h('div', null, howText(best.sim, N.at)));
      kids.push(h('div', { class: 'arrive' }, h('span', { class: 'big', id: 'eta' }, clock(best.arrive)), h('span', { class: 'muted' }, t('worst_at', { t: clock(best.worst) })),
        N.live && fixedTime ? h('span', { class: 'pill' + (f.wait_now < 1.5 ? ' hot' : '') }, f.wait_now < 1.5 ? t('leave_now') : t('leave_in', { n: Math.floor(f.wait_now) })) : null));
      if (f.kind === 'gmb_terminus' && N.live && !String(f.how).startsWith('live')) {
        const cur = S.state[f.route] || '';
        kids.push(h('div', { class: 'small muted' }, t('state_q', { route: f.route })), h('div', { class: 'chips' }, [['', 'state_unknown'], ['just_left', 'state_just_left'], ['loading', 'state_loading']].map(([v, k]) =>
          h('button', { class: 'chip', 'aria-pressed': String(cur === v), onclick: () => { if (v) S.state[f.route] = v; else delete S.state[f.route]; computeNow(); renderNow(); } }, t(k)))));
      }
      kids.push(h('div', { class: 'actions' }, best.it.kind === 'transit' ? h('button', { class: 'btn slim', id: 'log-best', onclick: () => startTrip(best.it) }, t('start_log')) : null));
      out.push(h('div', { class: 'hero' }, kids));
    }
    const others = rows.slice(1, 10);
    if (others.length || S.plan.taxi) {
      const list = others.map((r) => {
        const diff = r.arrive - best.arrive;
        return h('div', { class: 'alt' }, nameEl(r.it, null), h('span', { class: 'at' }, clock(r.arrive)),
          h('span', { class: 'how' }, howText(r.sim, N.at)), h('span', { class: 'd' }, diff < 1 ? t('same_time') : t('later_by', { n: n0(diff) })));
      });
      const tx = S.plan.taxi;
      if (tx) list.push(h('div', { class: 'alt' }, nameEl(tx, null), h('span', { class: 'at' }, clock(N.at.minute + tx.total)),
        h('span', { class: 'how' }, t('how_taxi', { n: n0(S.net.C.TAXI_HAIL_MIN) })), h('span', { class: 'd' }, '$' + n0(tx.taxi.total))));
      out.push(h('div', { class: 'card' }, h('div', { class: 'sub' }, t('others_now')), list));
    }
    if (N.live) {
      const src = S.liveSources;
      const bits = [];
      if (!navigator.onLine) bits.push(h('span', { class: 'bad' }, t('offline_note')));
      else if (S.liveAt) {
        bits.push(h('span', null, t('live_at', { t: new Date(S.liveAt + 8 * 3600e3).toISOString().slice(11, 19) })));
        for (const k of ['kmb', 'ctb', 'gmb']) if (src && src[k]) bits.push(h('span', { class: src[k].ok ? '' : 'bad', 'data-src': k, 'data-ok': src[k].ok }, t('src_' + k) + ' ' + (src[k].ok ? '✓' : t('src_fail'))));
      } else bits.push(h('span', null, t('searching')));
      bits.push(h('button', { class: 'chip', onclick: refreshLive }, t('refresh')));
      out.push(h('div', { class: 'status' }, bits));
    } else out.push(h('div', { class: 'status' }, t('live_none')));
    box.replaceChildren(...out);
  }

  // ------------------------------------------------------------------ trip log
  function startTrip(it) {
    const now = HKTR.hkTime();
    const sim = S.planner.simulate(it.legs, now, S.plan.when.mode === 'now' ? S.live : null, S.state) || it;
    const net = S.net, C = net.C;
    const base = now.dayStartMs;
    const at = (minute) => Math.round(base + minute * 60000);
    const events = [{ k: 'leave', pred: at(now.minute) }];
    const legs = [];
    sim.steps.forEach((s) => {
      if (s.type === 'ride') {
        const r = net.R[s.ri], n = legs.length;
        legs.push({ mode: r.m, co: r.co, route: r.n, bound: r.b, st: r.st, gtfs: r.g, dest: r.d[0], from: net.stopId(r, s.i), to: net.stopId(r, s.j), i: s.i, j: s.j,
          kind: s.kind, pred: { wait: +s.wait.toFixed(2), wait_exp: +s.wait_exp.toFixed(2), wait_worst: +s.wait_worst.toFixed(2), how: s.how, ride: +(s.run + s.red + s.dwell).toFixed(2) } });
        events.push({ k: 'stop', n, ri: s.ri, pos: s.i, pred: at(s.board - s.wait) }, { k: 'board', n, ri: s.ri, pred: at(s.board) });
        if (s.kind === 'gmb_terminus') events.push({ k: 'depart', n, pred: at(s.board) });
        events.push({ k: 'alight', n, ri: s.ri, pos: s.j, pred: at(s.alight) });
      } else if (s.type === 'rail') {
        const n = legs.length;
        legs.push({ mode: 'mtr', a: s.a, b: s.b, lines: s.legs.map((l) => l[0]), pred: { wait: +s.wait.toFixed(2), ride: +s.ride.toFixed(2), transfer: +s.transfer.toFixed(2) } });
        events.push({ k: 'gate_in', n, a: s.a, pred: at(s.enter) }, { k: 'train', n, pred: at(s.enter + C.MTR_ACCESS_MIN + net.mtrHeadway(s.legs[0][0], 1) / 2) }, { k: 'gate_out', n, b: s.b, pred: at(s.exit) });
      }
    });
    events.push({ k: 'arrive', pred: at(now.minute + sim.total) });
    S.trip = { v: 1, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name: nameText(sim), names: sim.names, date: now.date, dow: now.dow,
      pred: { robust: +sim.robust.toFixed(2), worst: +sim.worst.toFixed(2), total: +sim.total.toFixed(2), fare: +sim.fare.toFixed(1) },
      legs, events, passed_full: 0, hasMid: legs.some((l) => l.kind === 'gmb_mid'), comment: '' };
    store.set('trip', S.trip);
    setView('trip');
  }
  function evLabel(e) {
    const net = S.net;
    switch (e.k) {
      case 'stop': return t('ev_stop', { a: stopName(net.R[e.ri].s[e.pos]) });
      case 'board': return t('ev_board', { label: routeLabel(net.R[e.ri]) });
      case 'alight': return t('ev_alight', { b: stopName(net.R[e.ri].s[e.pos]) });
      case 'gate_in': return t('ev_gate_in', { a: stationName(e.a) });
      case 'gate_out': return t('ev_gate_out', { b: stationName(e.b) });
      default: return t('ev_' + e.k);
    }
  }
  function viewTrip() {
    const T = S.trip;
    if (!T) return viewHome();
    const save = () => { store.set('trip', T); render(); };
    const nextIdx = T.events.findIndex((e) => !e.t && !e.skip);
    const rows = T.events.map((e, i) => {
      const isNext = i === nextIdx;
      let right;
      if (e.t) {
        right = e.editing
          ? h('input', { type: 'time', step: 1, value: new Date(e.t + 8 * 3600e3).toISOString().slice(11, 19), 'aria-label': evLabel(e),
            onchange: (ev) => { const [hh, mm, ss] = ev.target.value.split(':').map(Number); const day = HKTR.hkTime(e.t).dayStartMs; e.t = day + ((hh * 60 + mm) * 60 + (ss || 0)) * 1000; e.editing = false; save(); },
            onblur: () => { e.editing = false; save(); } })
          : h('button', { class: 'time', title: t('edit'), onclick: () => { e.editing = true; render(); } }, new Date(e.t + 8 * 3600e3).toISOString().slice(11, 19));
      } else if (e.skip) right = h('button', { class: 'chip', onclick: () => { e.skip = false; save(); } }, t('undo'));
      else right = h('button', { class: isNext ? 'btn slim' : 'chip', 'data-ev': e.k, onclick: () => {
        if (e.k !== 'leave' && !T.events[0].t) return toast(t('need_leave'));
        e.t = Date.now(); T.events.forEach((x, j) => { if (j < i && !x.t) x.skip = true; }); save();
      } }, t('tap_now'));
      return h('div', { class: 'ev' + (e.t || e.skip ? ' done' : '') + (isNext ? ' next' : '') },
        h('span', { class: 'lab' }, evLabel(e)), right,
        h('span', { class: 'meta' }, t('predicted', { t: clockMs(e.pred) }),
          !e.t && !e.skip && e.k !== 'leave' && e.k !== 'arrive' ? [' · ', h('button', { class: 'x', style: 'padding:0;font-size:12.5px;text-decoration:underline', onclick: () => { e.skip = true; save(); } }, t('skip'))] : null));
    });
    const leave = T.events[0].t, arrive = T.events[T.events.length - 1].t;
    const out = [h('div', { class: 'rowx' }, h('h2', { style: 'flex:1;margin:0' }, t('log_title')), h('button', { class: 'btn ghost slim', onclick: () => setView(S.plan ? 'go' : 'home') }, t('back'))),
      h('p', { class: 'sub' }, t('log_intro')),
      h('section', { class: 'card' }, h('div', { style: 'padding-bottom:8px' }, h('b', null, T.name)), rows)];
    if (T.hasMid) {
      out.push(h('section', { class: 'card counter' }, h('span', { style: 'flex:1' }, t('passed_full')),
        h('button', { class: 'iconbtn', 'aria-label': '−', onclick: () => { T.passed_full = Math.max(0, T.passed_full - 1); save(); } }, '−'),
        h('b', { class: 'num' }, t('times', { n: T.passed_full })),
        h('button', { class: 'iconbtn', 'aria-label': '+', onclick: () => { T.passed_full += 1; save(); } }, '+')));
    }
    if (leave && arrive) {
      const actual = (arrive - leave) / 60000, P = T.pred;
      const verdict = actual > P.worst + 0.5 ? t('sum_over', { n: n0(actual - P.worst) }) : actual > P.robust + 2 ? t('sum_slower', { n: n0(actual - P.robust) })
        : actual < P.robust - 2 ? t('sum_faster', { n: n0(P.robust - actual) }) : t('sum_within');
      const ta = h('textarea', { id: 'comment', placeholder: t('comment_ph'), 'aria-label': t('comment_ph') });
      ta.value = T.comment || '';
      ta.addEventListener('input', () => { T.comment = ta.value; store.set('trip', T); });
      out.push(h('section', { class: 'card stack' }, h('b', null, t('sum_title')),
        h('div', null, t('sum_actual', { n: n0(actual) }) + (S.lang === 'en' ? '. ' : '。') + t('sum_pred', { a: n0(P.robust), w: n0(P.worst) }) + (S.lang === 'en' ? '. ' : '。') + verdict + (S.lang === 'en' ? '.' : '。')),
        ta, h('button', { class: 'btn', id: 'submit', onclick: finishTrip }, t('submit'))));
    }
    out.push(h('button', { class: 'btn ghost', onclick: () => {
      if (!T.confirmDiscard) { T.confirmDiscard = true; toast(t('discard_q')); return render(); }
      S.trip = null; store.set('trip', null); setView(S.plan ? 'go' : 'home');
    } }, S.trip.confirmDiscard ? t('discard') + ' ✓' : t('discard')));
    return out;
  }
  function tripRecord(T) {
    const ev = {};
    T.events.forEach((e) => { if (e.t) ev[e.k + (e.n === undefined ? '' : '_' + e.n)] = new Date(e.t + 8 * 3600e3).toISOString().slice(11, 19); });
    const leave = T.events[0].t, arrive = T.events[T.events.length - 1].t;
    return { type: 'trip', v: 1, app: CONFIG.version, built: S.net.built, lang: S.lang, id: T.id, date: T.date, dow: T.dow, name: T.name,
      legs: T.legs, pred: T.pred, events: ev, passed_full: T.passed_full, actual_min: leave && arrive ? +((arrive - leave) / 60000).toFixed(2) : null,
      comment: (T.comment || '').slice(0, 500) };
  }
  async function upload(rec) {
    const F = CONFIG.feedback || {};
    if (!F.formAction || !F.entry) return false;
    const body = new URLSearchParams();
    body.set(F.entry, JSON.stringify(rec));
    await fetch(F.formAction, { method: 'POST', mode: 'no-cors', body });
    return true;
  }
  async function finishTrip() {
    const rec = tripRecord(S.trip);
    let synced = false;
    try { synced = await upload(rec); } catch (e) { synced = false; }
    if (FEAT.records) {
      const all = store.get('records', []);
      all.unshift({ rec, synced });
      store.set('records', all.slice(0, 200));
    } else if (!synced) {      // not shown anywhere; sent next time the page opens
      store.set('outbox', store.get('outbox', []).concat([rec]).slice(-50));
    }
    S.trip = null; store.set('trip', null);
    toast(synced ? t('submitted') : FEAT.records ? t('saved_local') : t('send_later'));
    setView(FEAT.records ? 'log' : S.plan ? 'go' : 'home');
  }
  /** With the features off: send anything left in the outbox, and clear what earlier
   * versions kept on the phone (records, saved places, recent trips). */
  async function tidyStorage() {
    if (!FEAT.records) {
      const old = store.get('records', []).filter((x) => !x.synced).map((x) => x.rec);
      if (old.length) store.set('outbox', store.get('outbox', []).concat(old).slice(-50));
      store.set('records', null);
    }
    if (!FEAT.savedPlaces) store.set('places', null);
    if (!FEAT.recent) { store.set('recent', null); store.set('last', null); }
    const box = store.get('outbox', []);
    if (!box.length) return;
    const left = [];
    for (const rec of box) { try { if (!(await upload(rec))) left.push(rec); } catch (e) { left.push(rec); } }
    store.set('outbox', left.length ? left : null);
  }

  // ------------------------------------------------------------------ records and about
  function viewLog() {
    const all = store.get('records', []);
    const hasEndpoint = !!(CONFIG.feedback && CONFIG.feedback.formAction);
    const out = [h('h2', null, t('records'))];
    if (S.trip) out.push(h('div', { class: 'notice rowx' }, h('span', { style: 'flex:1' }, t('resume_trip')), h('button', { class: 'btn slim', onclick: () => setView('trip') }, t('resume'))));
    if (!all.length) { out.push(h('section', { class: 'card' }, h('p', { class: 'sub' }, t('records_empty')))); return out; }
    out.push(h('section', { class: 'card' }, h('ul', { class: 'list' }, all.map((x) => h('li', null, h('div', { class: 'item' }, h('span', { class: 't' },
      h('b', null, x.rec.name), h('span', null, x.rec.date.slice(4, 6) + '-' + x.rec.date.slice(6) + ' · ' + (x.rec.actual_min === null ? '—' : t('sum_actual', { n: n0(x.rec.actual_min) })) + ' · ' + t('sum_pred', { a: n0(x.rec.pred.robust), w: n0(x.rec.pred.worst) }))),
      h('span', { class: 'small ' + (x.synced ? '' : 'muted') }, x.synced ? t('rec_sync') : t('rec_local'))))))));
    const pending = all.filter((x) => !x.synced);
    if (hasEndpoint && pending.length) out.push(h('button', { class: 'btn', onclick: async () => {
      for (const x of pending) { try { x.synced = await upload(x.rec); } catch (e) { /* stays pending */ } }
      store.set('records', all); toast(t('submitted')); render();
    } }, t('upload_now')));
    if (!hasEndpoint) out.push(h('p', { class: 'sub' }, t('copy_hint')));
    out.push(h('button', { class: 'btn ghost', id: 'copy', onclick: async () => {
      const text = JSON.stringify(all.map((x) => x.rec));
      try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch (e) {
        const ta = h('textarea', { readonly: true }); ta.value = text; $('#app').append(ta); ta.select();
      }
    } }, t('copy_all')));
    return out;
  }
  function viewAbout() {
    const langBtn = (code, label) => h('button', { class: 'chip', 'aria-pressed': String(S.lang === code), onclick: () => { S.lang = code; store.set('lang', code); S.idx = null; render(); } }, label);
    const ta = h('textarea', { id: 'fb', placeholder: t('fb_ph'), 'aria-label': t('fb_ph') });
    const sec = (title, ...body) => h('section', { class: 'card prose' }, h('h2', { style: 'margin:0 0 6px' }, title), body);
    return [
      h('section', { class: 'card stack' }, h('b', null, t('lang')), h('div', { class: 'langs' }, langBtn('zh-Hans', '简体'), langBtn('zh-Hant', '繁體'), langBtn('en', 'English'))),
      sec(t('about_what_t'), h('p', null, t('about_what'))),
      sec(t('about_diff_t'), h('ul', null, [1, 2, 3, 4].map((i) => h('li', null, t('about_diff_' + i))))),
      sec(t('about_limit_t'), h('p', null, t('about_limit'))),
      sec(t('about_data_t'), h('p', null, t('about_data')), h('p', { class: 'muted small' }, t('about_built', { t: (S.net.built || '').replace('T', ' ').slice(0, 16) }) + ' · v' + CONFIG.version)),
      sec(t('about_privacy_t'), h('p', null, t('about_privacy'))),
      h('section', { class: 'card stack' }, h('b', null, t('fb_title')), ta, h('button', { class: 'btn', onclick: async () => {
        const text = ta.value.trim();
        if (!text) return;
        let ok = false;
        try { ok = await upload({ type: 'comment', v: 1, app: CONFIG.version, lang: S.lang, at: new Date().toISOString(), text: text.slice(0, 2000) }); } catch (e) { ok = false; }
        if (ok) { ta.value = ''; toast(t('fb_sent')); } else toast(t('fb_no_endpoint'));
      } }, t('fb_send'))),
    ];
  }

  // ------------------------------------------------------------------ start
  function parsePlace(v) {
    if (!v) return null;
    if (v === 'gps') return { kind: 'gps' };
    const parts = v.split(',');
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if (!isFinite(lat) || !isFinite(lng) || !inHK(lat, lng)) return null;
    return { kind: 'pt', lat, lng, label: decodeURIComponent(parts.slice(2).join(',')) || lat.toFixed(4) + ',' + lng.toFixed(4) };
  }
  async function boot() {
    const q = new URLSearchParams(location.search);
    const nav = (navigator.language || 'zh-Hans').toLowerCase();
    S.lang = q.get('lang') || store.get('lang', null) || (nav.startsWith('zh') ? (/(tw|hk|mo|hant)/.test(nav) ? 'zh-Hant' : 'zh-Hans') : 'en');
    if (!window.I18N[S.lang]) S.lang = 'zh-Hans';
    $('#boot').textContent = t('loading_data');
    renderBar();
    S.trip = store.get('trip', null);
    try {
      const r = await fetch('data/net.json?v=' + encodeURIComponent(CONFIG.dataVersion || CONFIG.version));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.net = new HKTR.Net(await r.json());
    } catch (e) {
      $('#app').replaceChildren(h('div', { class: 'notice err', role: 'alert' }, t('load_failed')));
      return;
    }
    const last = FEAT.recent ? store.get('last', null) : null;
    tidyStorage();
    const from = parsePlace(q.get('from')), to = parsePlace(q.get('to'));
    if (from && to) { S.from = from; S.to = to; } else if (last) { S.from = last.from || S.from; S.to = last.to || null; }
    const v = location.hash.slice(1);
    S.view = (v === 'log' && FEAT.records) || v === 'about' ? v : v === 'trip' && S.trip ? 'trip' : 'home';
    render();
    if (from && to && S.view === 'home') runPlan(false);
  }
  boot();
})();
