#!/usr/bin/env node
/**
 * verify_equivalence.js — регрессионный харнесс для GuessGame.
 *
 * Извлекает ядро (без UI) из HTML-файла, исполняет его в изолированном
 * контексте Node и прогоняет одинаковые сценарии на двух версиях файла,
 * сравнивая результаты побитово (JSON с сортировкой ключей).
 *
 * Использование: node verify_equivalence.js <оригинал.html> <рефактор.html> [private-state.json]
 * Без private-state.json используется явно синтетическая история.
 * Выход: PASS/FAIL по каждому тесту; при FAIL — первый различающийся путь.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const UI_MARKER = '/* ---------- UI ---------- */';
const SCRIPT_OPEN = '<script>';
const SCRIPT_CLOSE = '</' + 'script>';

function extractCore(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const a = html.indexOf(SCRIPT_OPEN);
  const b = html.indexOf(SCRIPT_CLOSE, a);
  if (a < 0 || b < 0) throw new Error('Не найден <script> в ' + htmlPath);
  let code = html.slice(a + SCRIPT_OPEN.length, b);
  const ui = code.indexOf(UI_MARKER);
  if (ui < 0) throw new Error('Не найден маркер UI в ' + htmlPath);
  return code.slice(0, ui);
}

function makeSandbox() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(String(k), String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    result: {},
  };
  vm.createContext(sandbox);
  return sandbox;
}

function loadCore(htmlPath) {
  const sandbox = makeSandbox();
  // class-декларации не попадают в global контекста — экспортируем явно.
  const shim = ';this.__api = { PredictorEngine, SimulationRunner, VirtualPlayer,' +
    ' MultiRateHedge, emptyState, restoreState, hydrateState, replay,' +
    ' validatePayload, AGGREGATORS, PREDICTORS };';
  vm.runInContext(extractCore(htmlPath) + shim, sandbox, { filename: path.basename(htmlPath) });
  return sandbox;
}

/* Стабильная сериализация: ключи сортируются, Map сериализуется. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (Object.prototype.toString.call(v) === '[object Map]') return stable(Array.from(v.entries()));
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function firstDiff(a, b, p = '', out = { path: null }) {
  const sa = stable(a), sb = stable(b);
  if (sa === sb) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.path = p + '  (' + String(sa).slice(0, 80) + ' != ' + String(sb).slice(0, 80) + ')';
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.path = p + '.length ' + a.length + ' != ' + b.length; return out; }
    for (let i = 0; i < a.length; i++) {
      firstDiff(a[i], b[i], p + '[' + i + ']', out);
      if (out.path) return out;
    }
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    firstDiff(a[k], b[k], p + '.' + k, out);
    if (out.path) return out;
  }
  return out;
}

/* Снимок состояния движка без ссылок на Map-поля (через exportState). */
function engineFingerprint(eng) {
  const st = eng.exportState();
  delete st.algorithmVersion;
  return st;
}

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

/* ---------------- Сценарии ---------------- */

test('T1. Загрузка истории и экспорт полного состояния', (A, B) => {
  const raw = INPUT_STATE;
  const run = (sb) => {
    const st = sb.restoreState(JSON.parse(JSON.stringify(raw)));
    const eng = new sb.__api.PredictorEngine(st);
    return { state: eng.exportState(), fastTotal: eng.fast.total,
             trackerStart: eng.tracker.start };
  };
  const a = run(A), b = run(B);
  // algorithmVersion — метаданные, исключаем из сравнения
  delete a.state.algorithmVersion; delete b.state.algorithmVersion;
  return [a, b];
});

test('T2. 32 ручных хода поверх legacy-истории (снимки прогнозов, веса, SGD)', (A, B) => {
  const raw = INPUT_STATE;
  const run = (sb) => {
    const eng = new sb.__api.PredictorEngine(sb.restoreState(JSON.parse(JSON.stringify(raw))));
    // Детерминированный фрагмент: продолжение реальной истории + альтернанс
    const bits = raw.history.slice(-16).concat(raw.history.slice(-8).reverse(),
                                              [0, 1, 0, 1, 1, 0, 0, 1]);
    const steps = [];
    let t0 = 1700000000000;
    bits.forEach((bit, i) => {
      const at = t0 + i * 5000;
      const snap = eng.predict(at, false);
      eng.update(bit, snap, { source: 'live', answeredAt: at + 1000 });
      steps.push({ guess: snap.guess, prob1: snap.prob1,
                   probs: snap.probs, features: snap.features,
                   after: engineFingerprint(eng) });
    });
    return steps;
  };
  return [run(A), run(B)];
});

test('T3. replay() с benchmark по всей истории (measureLast 500)', (A, B) => {
  const raw = INPUT_STATE;
  const run = (sb) => {
    const r = sb.replay(raw.history, raw.moveTimes,
                        { collectBenchmark: true, measureLast: 500 });
    const bm = {};
    for (const [k, v] of Object.entries(r.benchmark.models))
      bm[k] = { n: v.n, hits: v.hits, brier: v.brier, log: v.log };
    return { correct: r.correct, weights: r.weights, sgd: r.sgd,
             predictions: r.predictions, benchmark: bm };
  };
  return [run(A), run(B)];
});

test('T4. Абляция replay exclude=ppm', (A, B) => {
  const raw = INPUT_STATE;
  const run = (sb) => {
    const r = sb.replay(raw.history, raw.moveTimes,
                        { exclude: 'ppm', collectScore: true, measureLast: 500 });
    return { correct: r.correct, weights: r.weights, score: r.score };
  };
  return [run(A), run(B)];
});

const CONTROL = { I: 0.9, S: 0.7, M: 10, C: 0.25, Q: 0.5, E: 0.6, D: 0.7, G: -1 };

test('T5. Эталонная симуляция 600 ходов, baseline (контрольные параметры README)', (A, B) => {
  const run = (sb) => {
    const r = new sb.__api.SimulationRunner({ params: { ...CONTROL }, turns: 600,
      sessionSize: 100, startState: null, initialBit: 0, alternateStart: false,
      aggregator: 'baseline', goalSchedule: [] });
    while (r.step() !== null) {}
    if (r.summary().hits !== 413 || r.summary().n !== 600)
      throw new Error('Контрольный результат должен быть 413/600');
    const ex = r.export();
    delete ex.version; // метка версии приложения меняется в 2.3.1 намеренно
    return { history: r.history, weightTrace: r.weightTrace, summary: r.summary(),
             export: ex };
  };
  return [run(A), run(B)];
});

test('T6. Симуляция 300 ходов, multi + внешняя смена G', (A, B) => {
  const run = (sb) => {
    const r = new sb.__api.SimulationRunner({ params: { ...CONTROL, G: 0 }, turns: 300,
      sessionSize: 100, startState: null, initialBit: 1, alternateStart: true,
      aggregator: 'multi', goalSchedule: [{ at: 1, g: 0 }, { at: 101, g: -1 }, { at: 201, g: 0 }] });
    while (r.step() !== null) {}
    return { history: r.history, weightTrace: r.weightTrace, summary: r.summary() };
  };
  return [run(A), run(B)];
});

test('T7. Симуляция 200 ходов, fast-агрегатор, старт из обученной копии', (A, B) => {
  const raw = INPUT_STATE;
  const run = (sb) => {
    const startState = sb.__api.hydrateState(JSON.parse(JSON.stringify(
      new sb.__api.PredictorEngine(sb.restoreState(JSON.parse(JSON.stringify(raw)))).exportState())));
    const r = new sb.__api.SimulationRunner({ params: { ...CONTROL }, turns: 200,
      sessionSize: 50, startState, initialBit: 0, alternateStart: false,
      aggregator: 'fast', goalSchedule: [] });
    while (r.step() !== null) {}
    return { history: r.history, summary: r.summary(),
             initialCount: r.initialPredictorCount };
  };
  return [run(A), run(B)];
});

/* ---------------- Запуск ---------------- */

const [, , OLD_FILE, NEW_FILE, JSON_PATH_ARG] = process.argv;
if (!OLD_FILE || !NEW_FILE) {
  console.error('Использование: node verify_equivalence.js <old.html> <new.html> [state.json]');
  process.exit(2);
}

const A = loadCore(OLD_FILE);
const B = loadCore(NEW_FILE);
const INPUT_STATE = JSON_PATH_ARG ? JSON.parse(fs.readFileSync(JSON_PATH_ARG, 'utf8')) : (() => {
  const engine = new A.__api.PredictorEngine();
  for (let i = 0; i < 1200; i++) {
    const at = 1700000000000 + i * 5000 + Math.floor(i / 100) * 600000;
    engine.update((i * 7 + Math.floor(i / 5)) % 2, engine.predict(at, false),
      { answeredAt: at + 1000, source: 'simulated' });
  }
  return JSON.parse(JSON.stringify(engine.exportState()));
})();
console.log(JSON_PATH_ARG ? 'Вход: приватный JSON (содержимое не выводится)' :
  'Вход: синтетическая история, НЕ реальные человеческие данные');

let failed = 0;
for (const t of TESTS) {
  try {
    const [ra, rb] = t.fn(A, B);
    const sa = stable(ra), sb2 = stable(rb);
    if (sa === sb2) {
      console.log('PASS  ' + t.name + '  (' + sa.length + ' байт)');
    } else {
      failed++;
      const d = firstDiff(ra, rb);
      console.log('FAIL  ' + t.name);
      console.log('      первое различие: ' + (d.path || '(структура)'));
    }
  } catch (e) {
    failed++;
    console.log('ERROR ' + t.name + ': ' + e.stack.split('\n').slice(0, 3).join(' | '));
  }
}
console.log(failed ? '\nИТОГ: ' + failed + ' тест(ов) провалено' : '\nИТОГ: все тесты пройдены, поведение идентично');
process.exit(failed ? 1 : 0);
