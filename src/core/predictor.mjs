
/* ---------- Базовые предсказатели ---------- */

function globalPredict(h) {
  if (!h.length) return 0.5;
  return h.reduce((a, b) => a + b, 0) / h.length;
}

function recentPredict(h) {
  const n = Math.min(10, h.length);
  if (!n) return 0.5;
  const s = h.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

function markovNPredict(h, n) {
  if (h.length < n + 1) return 0.5;
  const key = h.slice(-n).join('');
  let ones = 0, total = 0;

  for (let i = n; i < h.length; i++) {
    if (h.slice(i - n, i).join('') === key) {
      total++;
      if (h[i] === 1) ones++;
    }
  }

  if (total === 0) return 0.5;
  return (ones + 1) / (total + 2);
}

function oppositePredict(h) {
  if (!h.length) return 0.5;
  return h[h.length - 1] === 0 ? 0.85 : 0.15;
}

function streakPredict(h) {
  if (!h.length) return 0.5;
  const last = h[h.length - 1];
  let len = 1;

  for (let i = h.length - 2; i >= 0 && h[i] === last; i--) {
    len++;
  }

  const conf = Math.min(0.5 + 0.08 * len, 0.9);
  return last === 1 ? conf : 1 - conf;
}

function patternStats(h, maxLen = 6, minCount = 5) {
  const rows = [];
  const upper = Math.min(maxLen, h.length - 1);

  for (let len = upper; len >= 1; len--) {
    const key = h.slice(-len).join('');
    let ones = 0, total = 0;

    for (let i = len; i < h.length; i++) {
      if (h.slice(i - len, i).join('') === key) {
        total++;
        if (h[i] === 1) ones++;
      }
    }

    const usable = total >= minCount;
    rows.push({
      len,
      key,
      total,
      ones,
      p1: total ? (ones + 1) / (total + 2) : null,
      usable,
    });
  }

  const chosen = rows.find(r => r.usable) || null;
  const prob1 = chosen ? chosen.p1 : 0.5;
  return { prob1, chosen, rows };
}

function patternPredict(h) {
  return patternStats(h).prob1;
}

function ewmaPredict(h, halfLife) {
  if (!h.length) return 0.5;

  const alpha = 1 - Math.pow(0.5, 1 / halfLife);
  let p = 0.5;

  for (let i = 0; i < h.length; i++) {
    p += alpha * (h[i] - p);
  }

  return p;
}

function runLengthPredict(h) {
  if (!h.length) return 0.5;

  const last = h[h.length - 1];

  let len = 1;
  for (let i = h.length - 2; i >= 0 && h[i] === last; i--) {
    len++;
  }

  const bin = Math.min(len, 8);

  let cont = 0;
  let total = 0;
  let run = 1;

  for (let i = 0; i < h.length - 1; i++) {
    if (i === 0) {
      run = 1;
    } else {
      run = (h[i] === h[i - 1]) ? run + 1 : 1;
    }

    const b = Math.min(run, 8);

    if (b === bin) {
      total++;
      if (h[i + 1] === h[i]) cont++;
    }
  }

  if (total < 5) return 0.5;

  const pContinue = (cont + 1) / (total + 2);
  return last === 1 ? pContinue : 1 - pContinue;
}

function responsePredict(h, preds) {
  const n = h.length;

  if (n < 20 || !preds || preds.length < n) return 0.5;

  const lastPred = preds[n - 1];
  const lastActual = h[n - 1];

  if (lastPred !== 0 && lastPred !== 1) return 0.5;

  let ones = 0;
  let total = 0;

  for (let i = 0; i < n - 1; i++) {
    const p = preds[i];
    if (p !== 0 && p !== 1) continue;

    if (p === lastPred && h[i] === lastActual) {
      total++;
      if (h[i + 1] === 1) ones++;
    }
  }

  if (total < 8) return 0.5;

  return (ones + 1) / (total + 2);
}

/* ---------- Сессии ---------- */

const SESSION_MIN_GAP_MS = 30_000;
const SESSION_GAP_FACTOR = 6;
const SESSION_BASELINE_N = 20;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function detectSessionBoundaries(moveTimes) {
  const boundaries = new Set([0]);
  const recentDeltas = [];

  for (let i = 1; i < moveTimes.length; i++) {
    const prevT = moveTimes[i - 1];
    const curT = moveTimes[i];

    if (prevT == null || curT == null) continue;

    const dt = curT - prevT;
    const baseline = recentDeltas.length >= 5 ? median(recentDeltas) : null;
    const gap = baseline != null
      ? Math.max(SESSION_MIN_GAP_MS, SESSION_GAP_FACTOR * baseline)
      : SESSION_MIN_GAP_MS;

    if (dt > gap) {
      boundaries.add(i);
      recentDeltas.length = 0;
    } else {
      recentDeltas.push(dt);
      if (recentDeltas.length > SESSION_BASELINE_N) recentDeltas.shift();
    }
  }

  return boundaries;
}

function currentSessionSlice(moves, boundaries) {
  let start = moves.length - 1;
  while (start > 0 && !boundaries.has(start)) start--;
  return moves.slice(start);
}

/* ---------- PPM ---------- */

const ETA = 0.3;
const FIXED_SHARE = 0.02; // Возврат веса отстающим моделям: 2% от массы
const WEIGHT_CAP = 5; // Строгий потолок при сумме весов 16
const APP_VERSION = "2.3.2";
const SCHEMA_VERSION = 2.1;
const PPM_MAX_DEPTH = 4;
const PPM_ESCAPE = 1;       // метод A: константная escape-вероятность
const PPM_TEMP_EDGE = 2.0;  // сжатие к 0.5 на краях диапазона
const PPM_TEMP_MID = 1.5;   // сжатие к 0.5 в середине диапазона
const STORAGE_KEY = 'guessGameState_v1';
const QUARANTINE_KEY = STORAGE_KEY + '_quarantine';
const DIAGNOSTIC_STRIDE = 50;  // снимки 16 экспертов: каждый 50-й ход + последний

function ppmInit() {
  return { counts: Array.from({ length: PPM_MAX_DEPTH + 1 }, () => new Map()) };
}

function ppmCtxKey(history, endIdx, d) {
  if (d === 0) return '';
  const start = endIdx - d;
  if (start < 0) return null;
  return history.slice(start, endIdx).join('');
}

function ppmUpdate(ppm, history, endIdx) {
  const v = history[endIdx];
  const maxD = Math.min(PPM_MAX_DEPTH, endIdx);

  for (let d = 0; d <= maxD; d++) {
    const key = ppmCtxKey(history, endIdx, d);
    if (key === null) continue;

    let c = ppm.counts[d].get(key);
    if (!c) {
      c = { ones: 0, total: 0, sawOne: false, sawZero: false, distinct: 0 };
      ppm.counts[d].set(key, c);
    }

    c.total++;

    if (v === 1) {
      c.ones++;
      if (!c.sawOne) {
        c.sawOne = true;
        c.distinct++;
      }
    } else {
      if (!c.sawZero) {
        c.sawZero = true;
        c.distinct++;
      }
    }
  }
}

// Проход по уровням контекстов от d=0 к глубине. Возвращает итоговую
// вероятность и поуровневые строки для панели диагностики.
// Итеративная свёртка даёт тот же порядок операций, что и прежняя рекурсия:
// p(d) = p_here(d) + p_escape(d) * p(d-1), база p(-1) = 0.5.
function ppmTrace(ppm, history, idx) {
  const maxD = Math.min(PPM_MAX_DEPTH, idx);
  const rows = [];
  let acc = 0.5;

  for (let d = 0; d <= maxD; d++) {
    const key = ppmCtxKey(history, idx, d);
    const c = key === null ? undefined : ppm.counts[d].get(key);

    if (!c || c.total === 0) {
      rows.push({ d, key, total: 0, ones: 0, distinct: 0, pHere: null, pe: null, pAfter: null });
      continue;
    }

    const denom = c.total + PPM_ESCAPE;
    const pHere = c.ones / denom;
    const pe = PPM_ESCAPE / denom;
    acc = pHere + pe * acc;

    rows.push({ d, key, total: c.total, ones: c.ones, distinct: c.distinct, pHere, pe, pAfter: acc });
  }

  return { p: acc, rows };
}

function ppmPredictFrom(ppm, history, idx) {
  if (!ppm || !ppm.counts) return 0.5;

  const p = ppmTrace(ppm, history, idx).p;

  if (p > 0.8 || p < 0.2) {
    return 0.5 + (p - 0.5) / PPM_TEMP_EDGE;
  }

  return 0.5 + (p - 0.5) / PPM_TEMP_MID;
}

function ppmSerialize(ppm) {
  if (!ppm || !ppm.counts) return null;
  return ppm.counts.map(m => Array.from(m.entries()));
}

function ppmDeserialize(arr) {
  if (!Array.isArray(arr)) return null;

  const counts = arr.map(entries => {
    const safeEntries = Array.isArray(entries) ? entries : [];
    return new Map(safeEntries.map(([k, v]) => {
      return [String(k), {
        ones: Number(v?.ones) || 0,
        total: Number(v?.total) || 0,
        sawOne: !!v?.sawOne,
        sawZero: !!v?.sawZero,
        distinct: Number(v?.distinct) || 0,
      }];
    }));
  });

  while (counts.length < PPM_MAX_DEPTH + 1) counts.push(new Map());

  return { counts };
}

/* ---------- CTW-подобный предсказатель ---------- */

const CTW_MAX_DEPTH = 5;
const CTW_ALPHA = 0.5;
const CTW_K = 15;
const CTW_ADV_ALPHA = 0.05;
const CTW_ADV_SCALE = 4;
const CTW_LOG_PRIOR = Math.log(0.85);

function ctwInit() {
  return { nodes: Array.from({ length: CTW_MAX_DEPTH + 1 }, () => new Map()) };
}

function ctwCtxKey(history, endIdx, d) {
  if (d === 0) return '';
  const start = endIdx - d;
  if (start < 0) return null;
  return history.slice(start, endIdx).join('');
}

function ctwPredictFrom(ctw, history, idx) {
  if (!ctw || !ctw.nodes) return 0.5;

  const maxD = Math.min(CTW_MAX_DEPTH, idx);
  const logs = [];
  const probs = [];
  let maxLog = -Infinity;

  for (let d = 0; d <= maxD; d++) {
    const key = ctwCtxKey(history, idx, d);
    if (key === null) continue;

    const node = ctw.nodes[d].get(key);

    const total = node ? node.total : 0;
    const ones = node ? node.ones : 0;
    const adv = node ? node.adv : 0;

    const p = (ones + CTW_ALPHA) / (total + 2 * CTW_ALPHA);

    // Для нулевого контекста разрешаем работать даже без данных.
    // Для длинных контекстов требуем надёжность.
    const rel = d === 0 ? 1 : total / (total + CTW_K);

    if (rel <= 0) continue;

    const logW =
      Math.log(rel + 1e-12) +
      d * CTW_LOG_PRIOR +
      CTW_ADV_SCALE * adv;

    logs.push(logW);
    probs.push(p);

    if (logW > maxLog) maxLog = logW;
  }

  if (!logs.length) return 0.5;

  let sum = 0;
  for (const lw of logs) {
    sum += Math.exp(lw - maxLog);
  }

  let mix = 0;
  for (let i = 0; i < logs.length; i++) {
    mix += probs[i] * Math.exp(logs[i] - maxLog) / sum;
  }

  return Math.min(0.98, Math.max(0.02, mix));
}

function ctwLearnUpdate(ctw, history, idx, actual) {
  if (!ctw || !ctw.nodes) return;

  const maxD = Math.min(CTW_MAX_DEPTH, idx);

  for (let d = 0; d <= maxD; d++) {
    const key = ctwCtxKey(history, idx, d);
    if (key === null) continue;

    let node = ctw.nodes[d].get(key);

    if (!node) {
      node = { ones: 0, total: 0, adv: 0 };
      ctw.nodes[d].set(key, node);
    }

    const p = (node.ones + CTW_ALPHA) / (node.total + 2 * CTW_ALPHA);
    const pActual = actual === 1 ? p : 1 - p;

    // advantage относительно случайного прогноза 0.5
    const adv = Math.log(Math.max(1e-6, pActual)) - Math.log(0.5);

    node.adv = node.total === 0
      ? adv
      : (1 - CTW_ADV_ALPHA) * node.adv + CTW_ADV_ALPHA * adv;

    node.adv = Math.max(-10, Math.min(0.69, node.adv));

    node.total++;
    if (actual === 1) node.ones++;
  }
}

function ctwSerialize(ctw) {
  if (!ctw || !ctw.nodes) return null;
  return ctw.nodes.map(m => Array.from(m.entries()));
}

function ctwDeserialize(arr) {
  if (!Array.isArray(arr)) return null;

  const nodes = arr.map(entries => {
    const safeEntries = Array.isArray(entries) ? entries : [];
    return new Map(safeEntries.map(([k, v]) => {
      return [String(k), {
        ones: Number(v?.ones) || 0,
        total: Number(v?.total) || 0,
        adv: Number(v?.adv) || 0,
      }];
    }));
  });

  while (nodes.length < CTW_MAX_DEPTH + 1) nodes.push(new Map());

  return { nodes };
}

/* ---------- SGD-мета-модель ---------- */

const SGD_BASE_ORDER = [
  'global',
  'recent10',
  'markov1',
  'markov2',
  'markov3',
  'opposite',
  'streak',
  'pattern',
  'ppm',
  'anti',
  'response',
  'runLength',
  'ewma20',
  'ewma50',
  'ctw',
];

// bias + base probs + lastActual + lastPred + lastHit + sessionLen
const SGD_FEATURE_COUNT = SGD_BASE_ORDER.length + 1 + 4;

const SGD_LR = 0.05;
const SGD_L2 = 0.0005;
const SGD_LR_DECAY = 500;

function sgdMetaInit() {
  return {
    w: new Array(SGD_FEATURE_COUNT).fill(0),
    t: 0,
  };
}

function sigmoid(z) {
  if (z > 35) return 1;
  if (z < -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

function dotSGD(w, x) {
  let z = 0;
  for (let i = 0; i < w.length; i++) {
    z += w[i] * x[i];
  }
  return z;
}

function makeSgdFeatures(baseProbs, globalHistory, ctx) {
  const n = globalHistory.length;
  const preds = ctx?.predictions || [];

  const feats = [1];

  for (const name of SGD_BASE_ORDER) {
    const p = baseProbs?.[name];
    feats.push(Number.isFinite(p) ? p : 0.5);
  }

  const lastActual = n ? globalHistory[n - 1] : 0.5;

  let lastPred = 0.5;
  if (ctx?.lastPrediction === 0 || ctx?.lastPrediction === 1) {
    lastPred = ctx.lastPrediction;
  } else if (n && (preds[n - 1] === 0 || preds[n - 1] === 1)) {
    lastPred = preds[n - 1];
  }

  let lastHit = 0.5;
  if (n && (preds[n - 1] === 0 || preds[n - 1] === 1)) {
    lastHit = preds[n - 1] === globalHistory[n - 1] ? 1 : 0;
  }

  const sessionLen = Math.min(1, (ctx?.sessionHistory?.length || 0) / 100);

  feats.push(lastActual, lastPred, lastHit, sessionLen);

  return feats;
}

function sgdMetaPredict(model, features) {
  if (!model || !Array.isArray(model.w) || model.w.length !== features.length) {
    return 0.5;
  }

  const z = dotSGD(model.w, features);
  const p = sigmoid(z);

  return Math.min(0.98, Math.max(0.02, p));
}

function sgdMetaLearn(model, features, actual) {
  if (!model || !Array.isArray(model.w) || model.w.length !== features.length) {
    return;
  }

  const z = dotSGD(model.w, features);
  const p = sigmoid(z);
  const y = actual === 1 ? 1 : 0;

  const lr = SGD_LR / (1 + model.t / SGD_LR_DECAY);
  const grad = p - y;

  for (let i = 0; i < model.w.length; i++) {
    model.w[i] -= lr * (grad * features[i] + SGD_L2 * model.w[i]);
  }

  model.t++;
}

/* ---------- Инкрементальная статистика ---------- */
// В оперативной памяти, не в JSON: воспроизводится по history при загрузке.
function fastInit() {
  return {
    total: 0, ones: 0, recent: [], recentOnes: 0,
    ewma20: 0.5, ewma50: 0.5, run: 0,
    runs: Array.from({ length: 9 }, () => ({ total: 0, cont: 0 })),
    contexts: Array.from({ length: 7 }, () => new Map()),
    response: new Map(),
  };
}

function fastUpdate(f, history, bit, idx = history.length, predictions = null) {
  if (idx > 0) {
    const last = history[idx - 1];
    const prevPred = predictions?.[idx - 1];
    if (validBit(prevPred)) {
      const key = `${prevPred}${last}`;
      let c = f.response.get(key);
      if (!c) { c = { total: 0, ones: 0 }; f.response.set(key, c); }
      c.total++;
      if (bit === 1) c.ones++;
    }
    const bin = Math.min(f.run, 8);
    f.runs[bin].total++;
    if (last === bit) f.runs[bin].cont++;
    f.run = last === bit ? f.run + 1 : 1;
  } else {
    f.run = 1;
  }
  for (let d = 1; d <= 6 && d <= idx; d++) {
    const key = history.slice(idx - d, idx).join('');
    let c = f.contexts[d].get(key);
    if (!c) { c = { total: 0, ones: 0 }; f.contexts[d].set(key, c); }
    c.total++;
    if (bit === 1) c.ones++;
  }
  f.total++;
  f.ones += bit;
  f.recent.push(bit);
  f.recentOnes += bit;
  if (f.recent.length > 10) f.recentOnes -= f.recent.shift();
  f.ewma20 += (1 - Math.pow(0.5, 1 / 20)) * (bit - f.ewma20);
  f.ewma50 += (1 - Math.pow(0.5, 1 / 50)) * (bit - f.ewma50);
}

function buildFast(history, predictions = null) {
  const f = fastInit();
  for (let i = 0; i < history.length; i++) fastUpdate(f, history, history[i], i, predictions);
  return f;
}

function fastMarkov(h, d, f) {
  if (!f || f.total !== h.length) return markovNPredict(h, d);
  if (h.length < d + 1) return 0.5;
  const c = f.contexts[d].get(h.slice(-d).join(''));
  return c ? (c.ones + 1) / (c.total + 2) : 0.5;
}

function fastPattern(h, f, maxLen = 6, minCount = 5) {
  if (!f || f.total !== h.length) return patternPredict(h);
  for (let d = Math.min(maxLen, h.length - 1); d >= 1; d--) {
    const c = f.contexts[d].get(h.slice(-d).join(''));
    if (c && c.total >= minCount) return (c.ones + 1) / (c.total + 2);
  }
  return 0.5;
}

function fastResponse(h, preds, f) {
  if (!f || f.total !== h.length) return responsePredict(h, preds);
  if (h.length < 20 || !preds || preds.length < h.length) return 0.5;
  const lastPred = preds[h.length - 1];
  if (!validBit(lastPred)) return 0.5;
  const c = f.response.get(`${lastPred}${h[h.length - 1]}`);
  return c && c.total >= 8 ? (c.ones + 1) / (c.total + 2) : 0.5;
}

function fastStreak(h, f) {
  if (!f || f.total !== h.length) return streakPredict(h);
  if (!h.length) return 0.5;
  const conf = Math.min(0.5 + 0.08 * f.run, 0.9);
  return h[h.length - 1] === 1 ? conf : 1 - conf;
}

function fastRunLength(h, f) {
  if (!f || f.total !== h.length) return runLengthPredict(h);
  if (!h.length) return 0.5;
  const c = f.runs[Math.min(f.run, 8)];
  if (c.total < 5) return 0.5;
  const p = (c.cont + 1) / (c.total + 2);
  return h[h.length - 1] === 1 ? p : 1 - p;
}

function sessionTrackerInit() {
  return { last: null, recentDeltas: [], start: 0, count: 0 };
}

function projectedSessionStart(tracker, time) {
  if (tracker.last == null || time == null) return tracker.start;
  const dt = time - tracker.last;
  if (dt < 0) return tracker.start;
  const baseline = tracker.recentDeltas.length >= 5 ? median(tracker.recentDeltas) : null;
  const gap = baseline == null ? SESSION_MIN_GAP_MS
    : Math.max(SESSION_MIN_GAP_MS, SESSION_GAP_FACTOR * baseline);
  return dt > gap ? tracker.count : tracker.start;
}

function commitSessionTime(tracker, time) {
  if (tracker.last != null && time != null) {
    const dt = time - tracker.last;
    const start = projectedSessionStart(tracker, time);
    if (start === tracker.count) {
      tracker.start = start;
      tracker.recentDeltas = [];
    } else if (dt >= 0) {
      tracker.recentDeltas.push(dt);
      if (tracker.recentDeltas.length > SESSION_BASELINE_N) tracker.recentDeltas.shift();
    }
  }
  tracker.last = time == null ? null : time;
  tracker.count++;
}

function buildSessionTracker(times) {
  const tracker = sessionTrackerInit();
  for (const t of times) commitSessionTime(tracker, t);
  return tracker;
}

/* ---------- Список предсказателей ---------- */

const PREDICTORS = [
  { name: 'global', fn: (sessionHistory, globalHistory, ctx) => ctx?.fast?.total === globalHistory.length ?
    (globalHistory.length ? ctx.fast.ones / globalHistory.length : 0.5) : globalPredict(globalHistory) },
  { name: 'recent10', fn: (sessionHistory, globalHistory, ctx) => ctx?.fast?.total === globalHistory.length ?
    (ctx.fast.recent.length ? ctx.fast.recentOnes / ctx.fast.recent.length : 0.5) : recentPredict(globalHistory) },
  { name: 'markov1', fn: (sessionHistory, globalHistory, ctx) => fastMarkov(globalHistory, 1, ctx?.fast) },
  { name: 'markov2', fn: (sessionHistory, globalHistory, ctx) => fastMarkov(globalHistory, 2, ctx?.fast) },
  { name: 'markov3', fn: (sessionHistory, globalHistory, ctx) => fastMarkov(sessionHistory, 3, ctx?.sessionFast) },
  { name: 'opposite', fn: (sessionHistory) => oppositePredict(sessionHistory) },
  { name: 'streak', fn: (sessionHistory, globalHistory, ctx) => fastStreak(sessionHistory, ctx?.sessionFast) },
  { name: 'pattern', fn: (sessionHistory, globalHistory, ctx) => fastPattern(globalHistory, ctx?.fast) },
  { name: 'ppm', fn: (sessionHistory, globalHistory, ctx) => ctx?.ppm ? ppmPredictFrom(ctx.ppm, globalHistory, globalHistory.length) : 0.5 },
  { name: 'anti', fn: (sessionHistory, globalHistory, ctx) => antiPredict(ctx) },
  { name: 'response', fn: (sessionHistory, globalHistory, ctx) => fastResponse(globalHistory, ctx?.predictions, ctx?.fast) },
  { name: 'runLength', fn: (sessionHistory, globalHistory, ctx) => fastRunLength(globalHistory, ctx?.fast) },
  { name: 'ewma20', fn: (sessionHistory, globalHistory, ctx) => ctx?.fast?.total === globalHistory.length ? ctx.fast.ewma20 : ewmaPredict(globalHistory, 20) },
  { name: 'ewma50', fn: (sessionHistory, globalHistory, ctx) => ctx?.fast?.total === globalHistory.length ? ctx.fast.ewma50 : ewmaPredict(globalHistory, 50) },
  { name: 'ctw', fn: (sessionHistory, globalHistory, ctx) => ctx?.ctw ? ctwPredictFrom(ctx.ctw, globalHistory, globalHistory.length) : 0.5 },
  { name: 'sgdMeta', fn: (sessionHistory, globalHistory, ctx) => ctx?.baseProbs && ctx?.sgd ?
    sgdMetaPredict(ctx.sgd, makeSgdFeatures(ctx.baseProbs, globalHistory, ctx)) : 0.5 },
];

/* ---------- Состояние ---------- */
function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION, algorithmVersion: APP_VERSION,
    history: [], moveTimes: [], predictions: [], forecastLog: [],
    weights: Object.fromEntries(PREDICTORS.map(p => [p.name, 1])),
    correct: 0, total: 0, startedAt: Date.now(),
    ppm: ppmInit(), ctw: ctwInit(), sgd: sgdMetaInit(),
    lastPrediction: null, blindMode: false,
  };
}



// Нормирование при жёстком верхнем пределе. В отличие от версии 2.0
// повторная нормировка НЕ может поднять вес выше потолка.
function normalizeWeights(weights, target = PREDICTORS.length, cap = WEIGHT_CAP, names = PREDICTORS.map(p => p.name)) {
  const n = names.length;
  let values = names.map(k => Number.isFinite(weights[k]) && weights[k] > 0 ? weights[k] : 0);
  if (!(values.reduce((a, b) => a + b, 0) > 0)) values = values.map(() => 1);
  let remaining = names.map((_, i) => i), budget = target;
  const result = new Array(n).fill(0);
  while (remaining.length) {
    const sum = remaining.reduce((a, i) => a + values[i], 0);
    const scale = sum > 0 ? budget / sum : 0;
    const over = remaining.filter(i => (sum > 0 ? values[i] * scale : budget / remaining.length) > cap);
    if (!over.length) {
      for (const i of remaining) result[i] = sum > 0 ? values[i] * scale : budget / remaining.length;
      break;
    }
    for (const i of over) { result[i] = cap; budget -= cap; }
    remaining = remaining.filter(i => !over.includes(i));
  }
  names.forEach((k, i) => weights[k] = result[i]);
  return weights;
}

function validNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function validBit(x) { return x === 0 || x === 1; }
function validateNodes(raw, depth, kind, expectedN) {
  if (raw == null) return;
  if (!Array.isArray(raw) || raw.length !== depth + 1) throw new Error(`${kind}: неверное число уровней`);
  for (let d = 0; d <= depth; d++) {
    if (!Array.isArray(raw[d])) throw new Error(`${kind}: уровень ${d} не массив`);
    const seen = new Set();
    for (const entry of raw[d]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
          entry[0].length !== d || /[^01]/.test(entry[0]) || seen.has(entry[0]))
        throw new Error(`${kind}: некорректный контекст на уровне ${d}`);
      seen.add(entry[0]);
      const v = entry[1];
      if (!v || !Number.isSafeInteger(v.total) || !Number.isSafeInteger(v.ones) ||
          v.total < 0 || v.ones < 0 || v.ones > v.total ||
          (kind === 'ctw' && !validNum(v.adv)) ||
          (kind === 'ppm' && (!Number.isSafeInteger(v.distinct) || v.distinct < 0 || v.distinct > 2 ||
          typeof v.sawOne !== 'boolean' || typeof v.sawZero !== 'boolean')))
        throw new Error(`${kind}: повреждённые счётчики`);
    }
  }
  if (expectedN > 0) {
    const root = raw[0].find(([k]) => k === '');
    if (!root || root[1].total !== expectedN) throw new Error(`${kind}: данные не совпадают с history`);
  }
}

function validatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('JSON не является объектом');
  if (validNum(p.schemaVersion) && p.schemaVersion > SCHEMA_VERSION) throw new Error('Формат JSON новее этой версии программы');
  if (!Array.isArray(p.history) || !p.history.every(validBit)) throw new Error('history содержит не 0/1');
  const n = p.history.length;
  if (n > 1000000) throw new Error('Максимум 1 000 000 ходов');
  if (p.moveTimes != null && (!Array.isArray(p.moveTimes) || p.moveTimes.length > n ||
      !p.moveTimes.every(t => t === null || (validNum(t) && t >= 0))))
    throw new Error('moveTimes повреждён');
  if (p.predictions != null && (!Array.isArray(p.predictions) || p.predictions.length > n ||
      !p.predictions.every(g => g === null || validBit(g))))
    throw new Error('predictions повреждён');
  if (p.weights != null && (!p.weights || typeof p.weights !== 'object' || Array.isArray(p.weights) ||
      !Object.values(p.weights).every(w => validNum(w) && w >= 0)))
    throw new Error('weights повреждён');
  if (p.total != null && (!Number.isSafeInteger(p.total) || p.total < 0 || p.total > n))
    throw new Error('total некорректен');
  if (p.correct != null && (!Number.isSafeInteger(p.correct) || p.correct < 0 ||
      p.correct > (p.total ?? n))) throw new Error('correct некорректен');
  if (p.startedAt != null && (!validNum(p.startedAt) || p.startedAt < 0))
    throw new Error('startedAt некорректен');
  if (p.sgd != null && (!p.sgd || !Array.isArray(p.sgd.w) ||
      p.sgd.w.length !== SGD_FEATURE_COUNT || !p.sgd.w.every(validNum) ||
      !Number.isSafeInteger(p.sgd.t) || p.sgd.t < 0))
    throw new Error('sgd повреждён');
  validateNodes(p.ppm, PPM_MAX_DEPTH, 'ppm', n);
  validateNodes(p.ctw, CTW_MAX_DEPTH, 'ctw', n);
  if (p.forecastLog != null) {
    if (!Array.isArray(p.forecastLog) || p.forecastLog.length !== n)
      throw new Error('forecastLog не совпадает по длине с history');
    for (let i = 0; i < n; i++) {
      const r = p.forecastLog[i];
      if (r === null) continue;
      if (!r || typeof r !== 'object' || Array.isArray(r) ||
          (r.guess !== null && !validBit(r.guess)) ||
          (r.p1 !== null && (!validNum(r.p1) || r.p1 < 0 || r.p1 > 1)) ||
          (r.visible !== null && typeof r.visible !== 'boolean') ||
          (r.predictedAt !== null && (!validNum(r.predictedAt) || r.predictedAt < 0)) ||
          (r.answeredAt != null && (!validNum(r.answeredAt) || r.answeredAt < 0)) ||
          (r.version != null && typeof r.version !== 'string') ||
          (r.source != null && !['live', 'legacy', 'simulated'].includes(r.source)))
        throw new Error(`forecastLog[${i}] повреждён`);
      if (r.guess !== (p.predictions?.length === n ? p.predictions[i] : r.guess))
        throw new Error(`forecastLog[${i}] не совпадает с predictions`);
      if (r.expertProbs != null && (!r.expertProbs || typeof r.expertProbs !== 'object' ||
          !Object.values(r.expertProbs).every(v => validNum(v) && v >= 0 && v <= 1)))
        throw new Error(`forecastLog[${i}].expertProbs повреждён`);
      if (r.expertWeights != null && (!r.expertWeights || typeof r.expertWeights !== 'object' ||
          !Object.values(r.expertWeights).every(v => validNum(v) && v >= 0)))
        throw new Error(`forecastLog[${i}].expertWeights повреждён`);
    }
  }
  return true;
}

function aligned(src, n) {
  const arr = Array.isArray(src) ? src.slice() : [];
  return [...Array(Math.max(0, n - arr.length)).fill(null), ...arr].slice(-n || undefined);
}

function hydrateState(p) {
  validatePayload(p);
  const n = p.history.length;
  const next = emptyState();
  next.history = p.history.slice();
  next.moveTimes = aligned(p.moveTimes, n);
  next.predictions = aligned(p.predictions, n);
  next.correct = p.correct ?? next.predictions.reduce((k, v, i) => k + (v === next.history[i]), 0);
  next.total = p.total ?? n;
  next.startedAt = p.startedAt ?? Date.now();
  next.lastPrediction = (p.lastPrediction === 0 || p.lastPrediction === 1)
    ? p.lastPrediction : (n ? next.predictions[n-1] : null);
  next.blindMode = !!p.blindMode;
  next.weights = {};
  for (const pred of PREDICTORS) next.weights[pred.name] = p.weights?.[pred.name] ?? 1;
  normalizeWeights(next.weights);
  next.ppm = p.ppm ? ppmDeserialize(p.ppm) : ppmInit();
  if (!p.ppm) for (let i = 0; i < n; i++) ppmUpdate(next.ppm, next.history, i);
  next.ctw = p.ctw ? ctwDeserialize(p.ctw) : ctwInit();
  if (!p.ctw) for (let i = 0; i < n; i++) ctwLearnUpdate(next.ctw, next.history, i, next.history[i]);
  next.sgd = p.sgd ? { w: p.sgd.w.slice(), t: p.sgd.t } : sgdMetaInit();
  if (p.forecastLog) {
    next.forecastLog = p.forecastLog.map(r => r ? { ...r } : null);
  } else {
    next.forecastLog = next.history.map((_, i) => ({
      guess: next.predictions[i], p1: null,
      predictedAt: next.moveTimes[i], answeredAt: null,
      visible: null, version: null, source: 'legacy',
    }));
  }
  return next;
}

// Точка входа для импорта: валидирует и восстанавливает состояние.
// Производные структуры (быстрые счётчики, трекер сессий) каждый
// PredictorEngine строит сам в конструкторе.
function restoreState(p) {
  return hydrateState(p);
}

function serializable(st) {
  return {
    ...st, schemaVersion: SCHEMA_VERSION, algorithmVersion: APP_VERSION,
    ppm: st.ppm?.counts ? ppmSerialize(st.ppm) : st.ppm,
    ctw: st.ctw?.nodes ? ctwSerialize(st.ctw) : st.ctw,
  };
}

/* ---------- Ансамбль ---------- */

function antiPredict(ctx) {
  if (ctx?.lastPrediction == null) return 0.5;
  return ctx.lastPrediction === 1 ? 0.35 : 0.65;
}

function computeBaseProbs(sessionHistory, globalHistory, ctx) {
  const baseProbs = {};

  for (const p of PREDICTORS) {
    if (p.name === 'sgdMeta') continue;

    let prob = p.fn(sessionHistory, globalHistory, ctx);

    if (!Number.isFinite(prob)) prob = 0.5;
    prob = Math.min(0.999, Math.max(0.001, prob));

    baseProbs[p.name] = prob;
  }

  return baseProbs;
}

function computeProbsAndFeatures(history, ctx) {
  const sessionHistory = ctx?.sessionHistory ?? history;
  const baseProbs = computeBaseProbs(sessionHistory, history, ctx);
  const features = makeSgdFeatures(baseProbs, history, { ...ctx, sessionHistory });
  const probs = { ...baseProbs, sgdMeta: sgdMetaPredict(ctx?.sgd, features) };
  return { probs, features };
}

function combineProbs(probs, weights, excluded = null) {
  let num = 0, den = 0;
  for (const p of PREDICTORS) {
    if (p.name === excluded) continue;
    const w = weights[p.name] ?? 1;
    num += (probs[p.name] ?? 0.5) * w;
    den += w;
  }
  return den > 0 ? Math.max(0.001, Math.min(0.999, num / den)) : 0.5;
}

function predictFrom(history, weights, ctx = {}, exclude = null) {
  const { probs, features } = computeProbsAndFeatures(history, ctx);
  const prob1 = combineProbs(probs, weights, exclude);
  return { guess: prob1 >= 0.5 ? 1 : 0, prob1, probs, features };
}

// Принимает именно сохранённый СНИМОК прогноза, а не пересчитывает его
// после того, как пользователь уже увидел число.
function applyUpdate(weights, actual, snapshot, exclude = null) {
  const nw = {};
  const eligible = PREDICTORS.filter(p => p.name !== exclude);
  const names = eligible.map(p => p.name);
  for (const p of eligible) {
    const prob = snapshot.probs[p.name] ?? 0.5;
    const loss = actual === 1 ? 1 - prob : prob;
    nw[p.name] = (weights[p.name] ?? 1) * Math.exp(-ETA * loss);
  }
  normalizeWeights(nw, eligible.length, WEIGHT_CAP, names);
  // Fixed-Share: небольшой ненулевой вес каждому участвующему эксперту.
  for (const p of eligible) {
    nw[p.name] = (1 - FIXED_SHARE) * nw[p.name] + FIXED_SHARE;
  }
  normalizeWeights(nw, eligible.length, WEIGHT_CAP, names);
  return nw;
}

function benchmarkAccumulator() { return { hits: 0, brier: 0, log: 0, n: 0 }; }
function benchmarkAdd(acc, p, actual) {
  if (!Number.isFinite(p)) return;
  const x = Math.min(1 - 1e-9, Math.max(1e-9, p));
  acc.n++;
  acc.hits += (x >= 0.5 ? 1 : 0) === actual ? 1 : 0;
  acc.brier += (x - actual) ** 2;
  acc.log -= actual ? Math.log(x) : Math.log(1 - x);
}

// Replay только для построения МОДЕЛИ и тестирования на прошлых данных.
// Его прогнозы нельзя выдавать за ранее показанные человеку.
function replay(history, moveTimes = [], opts = {}) {
  const weights = Object.fromEntries(PREDICTORS.filter(p => p.name !== opts.exclude).map(p => [p.name, 1]));
  const prefix = [];
  const prefixPredictions = [];
  const modelPpm = ppmInit(), modelCtw = ctwInit(), modelSgd = sgdMetaInit();
  const modelFast = fastInit(), tracker = sessionTrackerInit();
  let modelSessionFast = fastInit();
  let correct = 0, lastPrediction = null;
  const measureStart = Math.max(0, history.length - (opts.measureLast ?? 500));
  const bench = opts.collectBenchmark ? { measureStart, models: {} } : null;
  const score = opts.collectScore ? benchmarkAccumulator() : null;
  if (bench) {
    for (const p of ['ensemble', 'always0', 'always1', ...PREDICTORS.map(p => p.name)]) bench.models[p] = benchmarkAccumulator();
  }
  for (let i = 0; i < history.length; i++) {
    const time = Array.isArray(moveTimes) ? moveTimes[i] ?? null : null;
    const start = projectedSessionStart(tracker, time);
    if (start === i && i > 0) modelSessionFast = fastInit();
    const sessionHistory = prefix.slice(start);
    const ctx = {
      ppm: modelPpm, ctw: modelCtw, sgd: modelSgd, fast: modelFast, sessionFast: modelSessionFast,
      sessionHistory, lastPrediction,
      predictions: prefixPredictions,
    };
    const snapshot = predictFrom(prefix, weights, ctx, opts.exclude);
    const actual = history[i];
    if (score && i >= measureStart) benchmarkAdd(score, snapshot.prob1, actual);
    if (bench && i >= measureStart) {
      benchmarkAdd(bench.models.ensemble, snapshot.prob1, actual);
      benchmarkAdd(bench.models.always0, 0.001, actual);
      benchmarkAdd(bench.models.always1, 0.999, actual);
      for (const [name, acc] of Object.entries(bench.models)) {
        if (name !== 'ensemble' && name !== 'always0' && name !== 'always1')
          benchmarkAdd(acc, snapshot.probs[name], actual);
      }
    }
    const newWeights = applyUpdate(weights, actual, snapshot, opts.exclude);
    Object.assign(weights, newWeights);
    sgdMetaLearn(modelSgd, snapshot.features, actual);
    ctwLearnUpdate(modelCtw, prefix, i, actual);
    fastUpdate(modelFast, prefix, actual, i, prefixPredictions);
    fastUpdate(modelSessionFast, sessionHistory, actual);
    prefix.push(actual);
    commitSessionTime(tracker, time);
    const seenGuess = Array.isArray(opts.historicalPredictions)
      ? (opts.historicalPredictions[i] ?? null) : snapshot.guess;
    prefixPredictions.push(seenGuess);
    ppmUpdate(modelPpm, prefix, i);
    if (snapshot.guess === actual) correct++;
    lastPrediction = seenGuess;
  }
  return {
    weights, correct, total: history.length, ppm: modelPpm, ctw: modelCtw,
    sgd: modelSgd, predictions: prefixPredictions, lastPrediction,
    benchmark: bench, score,
  };
}

/* ---------- Экспериментальные агрегаторы: ядро экспертов не меняется ---------- */
// Альтернативы используют те же вероятности 16 экспертов и то же обучение
// CTW/PPM/SGD. Различается только управление весами и их смешивание.
const AGGREGATORS = Object.freeze({
  baseline: { label: 'Fixed-Share Hedge 2.2', rates: null },
  slow: { label: 'Медленный Hedge', rates: [{ eta: 0.08, share: 0.01 }] },
  fast: { label: 'Быстрый Hedge', rates: [{ eta: 0.90, share: 0.06 }] },
  multi: { label: 'Три скорости + мета-веса', rates: [
    { eta: 0.08, share: 0.01 }, { eta: 0.30, share: 0.02 }, { eta: 0.90, share: 0.06 }
  ] },
});

// Обучение внешних мета-весов в режиме «три скорости» (документация, §7.2).
const OUTER_HEDGE_ETA = 0.7;
const OUTER_HEDGE_SHARE = 0.025;

function rateWeightsUpdate(weights, probs, actual, eta, share) {
  const result = {};
  for (const p of PREDICTORS) {
    const prob = probs[p.name] ?? 0.5;
    const loss = actual === 1 ? 1 - prob : prob;
    result[p.name] = (weights[p.name] ?? 1) * Math.exp(-eta * loss);
  }
  normalizeWeights(result);
  for (const p of PREDICTORS) result[p.name] = (1 - share) * result[p.name] + share;
  return normalizeWeights(result);
}

class MultiRateHedge {
  constructor(mode, initialWeights) {
    if (!AGGREGATORS[mode] || mode === 'baseline')
      throw new Error('Неизвестный экспериментальный агрегатор: ' + mode);
    this.mode = mode;
    this.rates = AGGREGATORS[mode].rates.map(config => ({
      ...config, weights: normalizeWeights({ ...initialWeights })
    }));
    this.outer = this.rates.map(() => 1 / this.rates.length);
  }
  predict(probs) {
    const rateProbs = this.rates.map(rate => combineProbs(probs, rate.weights));
    const prob1 = rateProbs.reduce((sum, p, i) => sum + p * this.outer[i], 0);
    return { prob1, guess: prob1 >= 0.5 ? 1 : 0,
      rateProbs, outerBefore: this.outer.slice() };
  }
  update(actual, probs, before) {
    // Внешние веса учатся на прогнозах, сделанных ДО раскрытия ответа.
    if (!before || !Array.isArray(before.rateProbs) ||
        before.rateProbs.length !== this.rates.length) throw new Error('Нет снимка агрегатора');
    const raw = this.outer.map((w, i) => {
      const p = before.rateProbs[i];
      return w * Math.exp(-OUTER_HEDGE_ETA * (actual === 1 ? 1 - p : p));
    });
    const sum = raw.reduce((a, b) => a + b, 0);
    this.outer = raw.map(w =>
      (1 - OUTER_HEDGE_SHARE) * (sum > 0 ? w / sum : 1 / raw.length) + OUTER_HEDGE_SHARE / raw.length);
    this.rates.forEach(rate => {
      rate.weights = rateWeightsUpdate(rate.weights, probs, actual, rate.eta, rate.share);
    });
  }
  effectiveWeights() {
    const mix = {};
    for (const p of PREDICTORS) mix[p.name] = this.rates.reduce(
      (sum, r, i) => sum + this.outer[i] * r.weights[p.name], 0);
    return mix;
  }
  describe() {
    return { mode: this.mode, outer: this.outer.slice(),
      rates: this.rates.map(r => ({ eta: r.eta, share: r.share })) };
  }
}

/* ---------- Вычислительное ядро (общее для UI и лаборатории) ---------- */
// У ядра нет зависимости от DOM/localStorage/глобального state.
// Сохранение — ответственность клиента (ручной интерфейс либо лаборатория).
class PredictorEngine {
  constructor(initialState = null, aggregator = 'baseline') {
    if (!AGGREGATORS[aggregator]) throw new Error('Неизвестный агрегатор');
    this.state = initialState || emptyState();
    this.aggregatorMode = aggregator;
    this.experimental = aggregator === 'baseline' ? null :
      new MultiRateHedge(aggregator, this.state.weights);
    this.fast = buildFast(this.state.history, this.state.predictions);
    this.tracker = buildSessionTracker(this.state.moveTimes);
    this.sessionFast = buildFast(this.state.history.slice(this.tracker.start));
  }
  predict(at = Date.now(), visible = true) {
    const st = this.state;
    const start = projectedSessionStart(this.tracker, at);
    const ctx = {
      ppm: st.ppm, ctw: st.ctw, sgd: st.sgd, fast: this.fast,
      sessionFast: start === st.history.length ? fastInit() : this.sessionFast,
      sessionHistory: st.history.slice(start),
      lastPrediction: st.lastPrediction, predictions: st.predictions,
    };
    const base = predictFrom(st.history, st.weights, ctx);
    const candidate = this.experimental ? this.experimental.predict(base.probs) : null;
    return { ...base, ...(candidate ? {
      prob1: candidate.prob1, guess: candidate.guess,
      rateProbs: candidate.rateProbs, outerBefore: candidate.outerBefore
    } : {}), aggregator: this.aggregatorMode,
      predictedAt: at, visible, historyLength: st.history.length,
      version: APP_VERSION, weights: { ...st.weights },
      newSession: start === st.history.length && st.history.length > 0 };
  }
  update(actual, snapshot, options = {}) {
    const st = this.state;
    if (!validBit(actual)) throw new Error('Допустимы только 0 и 1');
    if (!snapshot || snapshot.historyLength !== st.history.length ||
        !validBit(snapshot.guess) || !validNum(snapshot.prob1) || !snapshot.probs ||
        !Array.isArray(snapshot.features)) throw new Error('Прогноз устарел либо повреждён');
    const nextWeights = applyUpdate(st.weights, actual, snapshot);
    if (this.experimental) this.experimental.update(actual,snapshot.probs,snapshot);
    sgdMetaLearn(st.sgd, snapshot.features, actual);
    ctwLearnUpdate(st.ctw, st.history, st.history.length, actual);
    fastUpdate(this.fast, st.history, actual, st.history.length, st.predictions);
    if (snapshot.newSession) this.sessionFast = fastInit();
    const start = snapshot.newSession ? st.history.length : this.tracker.start;
    fastUpdate(this.sessionFast, st.history.slice(start), actual);
    st.weights = nextWeights;
    st.history.push(actual);
    st.moveTimes.push(snapshot.predictedAt);
    st.predictions.push(snapshot.guess);
    st.forecastLog.push({
      guess: snapshot.guess, p1: snapshot.prob1,
      predictedAt: snapshot.predictedAt,
      answeredAt: options.answeredAt ?? Date.now(),
      visible: snapshot.visible, version: APP_VERSION,
      source: options.source || 'live',
      aggregator: this.aggregatorMode,
      expertProbs: { ...snapshot.probs }, expertWeights: { ...snapshot.weights },
    });
    commitSessionTime(this.tracker, snapshot.predictedAt);
    st.lastPrediction = snapshot.guess;
    st.total++;
    if (actual === snapshot.guess) st.correct++;
    ppmUpdate(st.ppm, st.history, st.history.length - 1);
    return snapshot.guess === actual;
  }
  exportState() { return serializable(this.state); }
  effectiveWeights() {
    return this.experimental ? this.experimental.effectiveWeights() : { ...this.state.weights };
  }
  aggregatorStatus() {
    return this.experimental ? this.experimental.describe() : { mode: 'baseline' };
  }
}


export { PredictorEngine, MultiRateHedge, PREDICTORS, AGGREGATORS, APP_VERSION, SCHEMA_VERSION, emptyState, restoreState, hydrateState, validatePayload, serializable, replay, validBit };
