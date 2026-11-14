let state = emptyState();
let loadWarning = '';
function detectAntiPlay(lookback = 30) {
  const h = state.history.slice(-lookback);
  const p = state.predictions.slice(-lookback);

  let both1 = 0, both0 = 0, pred1act0 = 0, pred0act1 = 0;

  for (let i = 0; i < h.length; i++) {
    if (p[i] == null) continue;

    if (p[i] === 1 && h[i] === 1) both1++;
    else if (p[i] === 0 && h[i] === 0) both0++;
    else if (p[i] === 1 && h[i] === 0) pred1act0++;
    else if (p[i] === 0 && h[i] === 1) pred0act1++;
  }

  const total = both1 + both0 + pred1act0 + pred0act1;

  if (total < 10) {
    return { anti: false, agree: null, total };
  }

  const agree = (both1 + both0) / total;
  const corr = (both1 + both0 - pred1act0 - pred0act1) / total;

  return { anti: agree < 0.4, agree, corr, total };
}

// В localStorage храним ВСЕ реальные ходы, вероятности, время, прогнозы и
// метаданные; подробные 16+16 чисел — каждый 50-й ход и последний.
// В RAM во время текущего запуска полный журнал не изменяется. После
// перезагрузки прореженные диагностические снимки не восстанавливаются.
function compactForStorage(payload) {
  if (!Array.isArray(payload.forecastLog)) return payload;
  const last = payload.forecastLog.length - 1;
  return {
    ...payload,
    forecastLog: payload.forecastLog.map((r, i) => {
      if (!r || i % DIAGNOSTIC_STRIDE === 0 || i === last) return r;
      const { expertProbs, expertWeights, ...essential } = r;
      return essential;
    }),
  };
}

// Никогда не затираем повреждённый JSON, не сохранив его сырую копию.
// Карантин версионируется: второй инцидент не уничтожает первый.
function protectCorruptRecord(raw) {
  for (let i = 0; i < 1000; i++) {
    const key = i === 0 ? QUARANTINE_KEY : `${QUARANTINE_KEY}_${i}`;
    const stored = localStorage.getItem(key);
    if (stored === raw) return key; // идентичная копия уже сохранена
    if (stored === null) {
      localStorage.setItem(key, raw); // ошибка квоты ПРОБРАСЫВАЕТСЯ
      if (localStorage.getItem(key) !== raw) throw new Error('Карантин не подтверждён');
      return key;
    }
  }
  throw new Error('Исчерпаны ключи карантина: сохранение заблокировано');
}

function writeWithBackup(payload) {
  const data = JSON.stringify(payload);
  const previous = localStorage.getItem(STORAGE_KEY);
  if (previous && previous !== data) {
    let healthy = false;
    try { validatePayload(JSON.parse(previous)); healthy = true; }
    catch (e) { console.warn('Основная запись повреждена; необходим карантин:', e); }
    if (healthy) {
      // Если резерв не удалось обновить — основную запись не трогаем.
      localStorage.setItem(STORAGE_KEY + '_backup', previous);
    } else {
      // Если нет места или карантин занят и новый не создаётся — НЕ стираем raw.
      protectCorruptRecord(previous);
    }
  }
  localStorage.setItem(STORAGE_KEY, data);
}

function load() {
  let primary;
  try { primary = localStorage.getItem(STORAGE_KEY); }
  catch (e) {
    state = emptyState();
    loadWarning = 'Хранилище браузера недоступно: ' + e.message + '. Играйте только с экспортом JSON.';
    return;
  }
  if (!primary) { state = emptyState(); return; }
  try { state = restoreState(JSON.parse(primary)); }
  catch (err) {
    const backup = localStorage.getItem(STORAGE_KEY + '_backup');
    if (backup) {
      try {
        state = restoreState(JSON.parse(backup));
        loadWarning = `Основная запись повреждена (${err.message}). Использована резервная копия. Скачайте сырой архив перед продолжением.`;
        return;
      } catch (e) { console.error('Резервная копия также повреждена:', e); }
    }
    state = emptyState();
    loadWarning = `Данные не загружены: ${err.message}. Исходная запись сохранена; скачайте сырой архив.`;
  }
}

function save() {
  // Состояние в RAM всегда полно, компактной становится только запись в storage.
  writeWithBackup(compactForStorage(serializable(state)));
}

let lastSavedTotal = 0;
let saveError = '';

function persistOrMarkUnsaved() {
  try {
    save();
    lastSavedTotal = state.total;
    saveError = '';
    renderPersistenceNotice();
    return true;
  } catch (err) {
    saveError = String(err?.message || err);
    renderPersistenceNotice();
    return false;
  }
}

function renderPersistenceNotice() {
  const panel = document.getElementById('persistenceNotice');
  if (!panel) return;
  const shown = Boolean(saveError || loadWarning);
  panel.classList.toggle('hidden', !shown);
  if (!shown) return;
  const delta = Math.max(0, state.total - lastSavedTotal);
  document.getElementById('persistenceStatus').textContent = saveError
    ? `⚠ Не удалось сохранить. Ходов после последней успешной записи: ${delta}`
    : '⚠ Обнаружена проблема прежнего сохранения';
  document.getElementById('persistenceDetail').textContent = saveError
    ? `Данные продолжают храниться в памяти этой вкладки. Не закрывайте её до экспорта JSON! Причина: ${saveError}`
    : loadWarning;
}

function downloadJsonObject(obj, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], {type:'application/json'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadStorageRecovery() {
  const rawEntries = {};
  const keys = [STORAGE_KEY, STORAGE_KEY + '_backup', QUARANTINE_KEY];
  for (let i = 1; i < 1000; i++) {
    const k = `${QUARANTINE_KEY}_${i}`;
    if (localStorage.getItem(k) !== null) keys.push(k);
    // При реальном использовании число инцидентов невелико.
    // Не прерываем поиск при дыре в нумерации (ключ мог быть удалён вручную).
  }
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null) rawEntries[key] = value;
  }
  return {
    format: 'GuessGameStorageRecovery', version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    note: 'Сырые строки localStorage для ручного восстановления; НЕ импортировать как обычное сохранение.',
    entries: rawEntries,
  };
}


// Ручная игра использует ТОТ ЖЕ экземпляр ядра, но сохраняет его после хода.
let manualEngine = null;
function predict(at = Date.now()) {
  return manualEngine.predict(at, !state.blindMode);
}
function update(actual, snapshot) {
  // Сначала завершается ход в памяти. Сбой storage не блокирует очередной ход.
  manualEngine.update(actual, snapshot, { source: 'live' });
  persistOrMarkUnsaved();
}

/* ---------- UI ---------- */

let currentGuess = null;
let currentProb = null;
let currentForecast = null;
let clearTimer = null;

const guessDisplay = document.getElementById('guessDisplay');
const feedback = document.getElementById('feedback');
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const btnGuess = document.getElementById('btnGuess');
const btnReset = document.getElementById('btnReset');
const stats = document.getElementById('stats');

btnGuess.addEventListener('click', () => {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  const forecast = predict();
  const { guess, prob1 } = forecast;
  currentForecast = forecast;

  currentGuess = guess;
  currentProb = prob1;

  feedback.textContent = '';

  if (state.blindMode) {
    guessDisplay.textContent = '?';
    feedback.textContent = 'Предсказание скрыто — подтвердите ваш ход';
  } else {
    guessDisplay.textContent = guess;
    feedback.textContent = `P(1) = ${prob1.toFixed(3)}`;
  }

  step1.classList.add('hidden');
  step2.classList.remove('hidden');
});

function roundEnd(actual) {
  if (currentGuess === null) return;

  const modelGuess = currentGuess;
  const modelProb = currentProb;
  const hit = modelGuess === actual;

  try {
    update(actual, currentForecast);
  } catch (e) {
    alert('Не удалось завершить ход в модели: ' + e.message);
    return;
  }

  guessDisplay.textContent = modelGuess;

  if (state.blindMode) {
    feedback.textContent =
      `Модель: ${modelGuess} · вы: ${actual} → ${hit ? '✅' : '❌'} (P(1) было ${modelProb.toFixed(2)})`;
  } else {
    feedback.textContent = `${hit ? '✅' : '❌'} (P(1) было ${modelProb.toFixed(2)})`;
  }

  currentGuess = null;
  currentProb = null;
  currentForecast = null;

  step1.classList.remove('hidden');
  step2.classList.add('hidden');

  renderStats();

  if (clearTimer) clearTimeout(clearTimer);

  clearTimer = setTimeout(() => {
    if (currentGuess === null) {
      feedback.textContent = '';
      guessDisplay.textContent = '?';
      clearTimer = null;
    }
  }, 1500);
}

const btnZero = document.getElementById('btnZero');
const btnOne = document.getElementById('btnOne');

btnZero.addEventListener('click', () => roundEnd(0));
btnOne.addEventListener('click', () => roundEnd(1));

btnReset.addEventListener('click', () => {
  if (!confirm('Сбросить всю статистику? Сначала рекомендуется экспортировать JSON.\nНесохранённые ходы будут утрачены.')) return;
  // Транзакционный сброс: пока запись не удалась, текущее состояние не меняем.
  const next = emptyState();
  try { writeWithBackup(compactForStorage(serializable(next))); }
  catch (e) {
    saveError = 'Сброс не выполнен: ' + e.message;
    renderPersistenceNotice();
    alert('Сброс отменён. Текущая история сохранена в памяти. ' + e.message);
    return;
  }
  state = next;
  manualEngine = new PredictorEngine(state);
  loadWarning = '';
  saveError = '';
  lastSavedTotal = 0;
  currentGuess = null; currentProb = null; currentForecast = null;
  if (clearTimer) clearTimeout(clearTimer);
  step1.classList.remove('hidden');
  step2.classList.add('hidden');
  chkBlind.checked = false;
  renderStats();
  renderPersistenceNotice();
  document.getElementById('benchmarkPanel').textContent = '';
  guessDisplay.textContent = '?';
  feedback.textContent = '';
});

const chkBlind = document.getElementById('chkBlind');

chkBlind.addEventListener('change', () => {
  if (currentForecast) {
    chkBlind.checked = state.blindMode;
    alert('Закончите текущий ход перед сменой режима.');
    return;
  }
  state.blindMode = chkBlind.checked;
  persistOrMarkUnsaved();
  renderStats();
});

/* ---------- Панели ---------- */

function renderPeriodPanel() {
  let panel = document.getElementById('periodPanel');

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'periodPanel';
    panel.className = 'stats';
    document.getElementById('patternPanel').after(panel);
  }

  const h = state.history;

  if (h.length < 35) {
    panel.innerHTML = '<div style="color:#888">period: нужно ≥35 ходов.</div>';
    return;
  }

  const W = Math.min(h.length, 80);
  const tail = h.slice(-W);
  const rows = [];
  const MIN_ABS = 0.12;

  let num = 0, den = 0, voteNum = 0;

  for (let lag = 1; lag <= 8; lag++) {
    const n = tail.length - lag;
    const x = tail.slice(0, n), y = tail.slice(lag);

    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;

    let s = 0, dx = 0, dy = 0;

    for (let i = 0; i < n; i++) {
      const a = x[i] - mx, b = y[i] - my;
      s += a * b;
      dx += a * a;
      dy += b * b;
    }

    const corr = (dx > 0 && dy > 0) ? s / Math.sqrt(dx * dy) : 0;
    const usable = Math.abs(corr) >= MIN_ABS;
    const voice = h[h.length - lag];
    const pL = usable ? 0.5 + 0.5 * corr * (2 * voice - 1) : null;
    const vote = usable ? (pL > 0.5 ? 1 : 0) : null;
    const wL = usable ? Math.abs(corr) : 0;

    if (usable) {
      num += pL * wL;
      voteNum += vote * wL;
      den += wL;
    }

    rows.push({ lag, corr, usable, voice, pL, vote, wL });
  }

  const p1 = den > 0 ? 0.5 * (voteNum / den) + 0.5 * (num / den) : 0.5;
  const dir = p1 >= 0.5 ? '1' : '0';

  let html = '<div><b>period: смесь лагов</b></div>';

  html += `<div style="margin:6px 0">P(1) = <b>${p1.toFixed(3)}</b> (${dir}) · `
        + `vote = ${den ? (voteNum / den).toFixed(3) : '—'} · `
        + `avg = ${den ? (num / den).toFixed(3) : '—'} · `
        + `активных лагов: ${rows.filter(r => r.usable).length}</div>`;

  html += '<table><tr style="color:#888"><td>lag</td><td>corr</td><td>голос</td><td>p_L</td><td>vote</td><td>w</td></tr>';

  for (const r of rows) {
    const style = r.usable ? 'font-weight:bold' : 'color:#aaa';
    const p = r.pL === null ? '—' : r.pL.toFixed(3);
    const v = r.vote === null ? '—' : r.vote;

    html += `<tr style="${style}"><td>${r.lag}</td><td>${r.corr.toFixed(3)}</td>`
          + `<td>${r.voice}</td><td>${p}</td><td>${v}</td><td>${r.wL.toFixed(3)}</td></tr>`;
  }

  html += '</table>';
  html += '<div style="color:#888;margin-top:6px">Жирным — активные лаги (|corr| ≥ 0.12), '
        + 'серым — ниже порога (игнорируются).</div>';

  panel.innerHTML = html;
}

function renderPpmPanel() {
  let panel = document.getElementById('ppmPanel');

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'ppmPanel';
    panel.className = 'stats';

    const periodPanel = document.getElementById('periodPanel');
    const patternPanel = document.getElementById('patternPanel');

    if (periodPanel) periodPanel.after(panel);
    else if (patternPanel) patternPanel.after(panel);
  }

  const h = state.history;
  const ppm = state.ppm;

  if (!ppm || !ppm.counts || h.length < 7) {
    panel.innerHTML = '<div style="color:#888">ppm: нужно ≥7 ходов.</div>';
    return;
  }

  const idx = h.length;
  const { rows } = ppmTrace(ppm, h, idx);
  const maxD = Math.min(PPM_MAX_DEPTH, idx);

  const p1 = ppmPredictFrom(ppm, h, idx);
  const dir = p1 >= 0.5 ? '1' : '0';

  let html = '<div><b>ppm: текущий контекст</b></div>';

  html += `<div style="margin:6px 0">P(1) = <b>${p1.toFixed(3)}</b> (${dir}) · глубина ${maxD}</div>`;
  html += '<table><tr style="color:#888"><td>d</td><td>ctx</td><td>n</td><td>1</td><td>dist</td><td>p_here</td><td>esc</td><td>p_after</td></tr>';

  for (const r of rows) {
    if (r.total === 0) {
      html += `<tr style="color:#aaa"><td>${r.d}</td><td><code>${r.key || '(пусто)'}</code></td><td>0</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
    } else {
      html += `<tr><td>${r.d}</td><td><code>${r.key || '(пусто)'}</code></td>`
            + `<td>${r.total}</td><td>${r.ones}</td><td>${r.distinct}</td>`
            + `<td>${r.pHere.toFixed(3)}</td><td>${r.pe.toFixed(3)}</td><td>${r.pAfter.toFixed(3)}</td></tr>`;
    }
  }

  html += '</table>';
  html += '<div style="color:#888;margin-top:6px">d — длина контекста, p_here — P(1) по этому контексту, '
        + 'esc — escape-вероятность (метод A, =1), p_after — итог с учётом более коротких.</div>';

  panel.innerHTML = html;
}

function renderPatternPanel() {
  const panel = document.getElementById('patternPanel');
  const h = state.history;

  if (h.length < 3) {
    panel.innerHTML = '<div style="color:#888">Мало данных — pattern пока не на что опираться.</div>';
    return;
  }

  const { chosen, rows } = patternStats(h);

  let html = '<div><b>pattern: на что опирается сейчас</b></div>';

  if (chosen) {
    const dir = chosen.p1 >= 0.5 ? '→ 1' : '→ 0';

    html += `<div style="margin:6px 0">Хвост <code>${chosen.key}</code> `
          + `(длина ${chosen.len}) встречался <b>${chosen.total}</b> раз; `
          + `после него единиц: ${chosen.ones}/${chosen.total}, `
          + `P(1) = <b>${chosen.p1.toFixed(3)}</b> ${dir}</div>`;
  } else {
    html += '<div style="margin:6px 0;color:#888">Ни один суффикс не набрал ≥ 5 наблюдений → P(1) = 0.5</div>';
  }

  html += '<table style="margin-top:8px">'
        + '<tr style="color:#888"><td>len</td><td>хвост</td><td>встреч</td><td>единиц</td><td>P(1)</td></tr>';

  for (const r of rows) {
    const style = r.usable ? 'font-weight:bold' : 'color:#aaa';
    const p1 = r.p1 === null ? '—' : r.p1.toFixed(3);

    html += `<tr style="${style}"><td>${r.len}</td><td><code>${r.key}</code></td>`
          + `<td>${r.total}</td><td>${r.ones}</td><td>${p1}</td></tr>`;
  }

  html += '</table>';
  html += '<div style="color:#888;margin-top:6px">Жирным — строка, которую pattern использует; '
        + 'серым — отброшено порогом или перекрыто более длинным контекстом.</div>';

  panel.innerHTML = html;
}

function renderSessionPanel() {
  let panel = document.getElementById('sessionPanel');

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'sessionPanel';
    panel.className = 'stats';

    const patternPanel = document.getElementById('patternPanel');
    if (patternPanel) patternPanel.after(panel);
  }

  const boundaries = detectSessionBoundaries(state.moveTimes);
  const sessionHistory = currentSessionSlice(state.history, boundaries);

  const real = state.moveTimes.filter(x => x !== null).length;
  const nulls = state.moveTimes.length - real;

  let html = '<div><b>Сессии</b></div>';
  html += `<div style="margin:6px 0">Текущая: <b>${sessionHistory.length}</b> ходов</div>`;
  html += `<div style="color:#888">Legacy: ${nulls} · с временем: ${real} · границ: ${boundaries.size}</div>`;

  panel.innerHTML = html;
}

function renderAntiPanel() {
  let panel = document.getElementById('antiPanel');

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'antiPanel';
    panel.className = 'stats';

    const sessionPanel = document.getElementById('sessionPanel');
    if (sessionPanel) sessionPanel.after(panel);
  }

  const r = detectAntiPlay(30);

  if (r.total < 10) {
    panel.innerHTML = '<div style="color:#888">детектор «против»: нужно ≥10 предсказаний.</div>';
    return;
  }

  const pct = (r.agree * 100).toFixed(1);
  const corr = (r.corr >= 0 ? '+' : '') + r.corr.toFixed(2);

  const status = r.anti
    ? '<span style="color:#d33;font-weight:bold">⚠ ИГРАЕТ ПРОТИВ</span>'
    : (r.agree < 0.5
      ? '<span style="color:#d93">на грани (частично против)</span>'
      : '<span style="color:#393">играет «за» (нормально)</span>');

  panel.innerHTML = `<div><b>детектор «игры против»</b> (последние ${r.total} ходов)</div>`
    + `<div style="margin:6px 0">Согласие: <b>${pct}%</b> · corr: <b>${corr}</b> · ${status}</div>`
    + `<div style="color:#888">antiPredict вес: ${state.weights.anti?.toFixed(3) ?? '—'}</div>`;
}

function renderStats() {
  const acc = state.total ? (state.correct / state.total * 100).toFixed(1) : '—';

  let html = state.blindMode
    ? '<div style="color:#666;margin-bottom:6px">🔒 Слепой режим — предсказание скрыто до подтверждения</div>'
    : '';

  if (loadWarning) html += `<div style="color:#b44;margin-bottom:8px">⚠ ${loadWarning.replaceAll('<','&lt;')}</div>`;
  html += `<div><b>Ходов:</b> ${state.total} &nbsp; <b>Точность (историческая):</b> ${acc}%</div>`;
  const logged = state.forecastLog.filter(r => r && r.p1 != null && r.source === 'live');
  const scored = logged.length;
  if (scored) {
    // Берём только записи с вероятностью; старые ходы не подменяем повторным прогоном.
    const verified = benchmarkAccumulator();
    let blind = benchmarkAccumulator(), visible = benchmarkAccumulator();
    state.forecastLog.forEach((r, i) => {
      if (!r || r.p1 == null || r.source !== 'live') return;
      benchmarkAdd(verified, r.p1, state.history[i]);
      benchmarkAdd(r.visible ? visible : blind, r.p1, state.history[i]);
    });
    const fmt = a => a.n ? `${(a.hits / a.n * 100).toFixed(1)}% (${a.n}), Brier ${(a.brier / a.n).toFixed(3)}` : 'нет данных';
    html += `<div style="margin-top:6px">Проверяемые прогнозы (фактические): <b>${fmt(verified)}</b></div>`;
    html += `<div style="color:#888">Слепой: ${fmt(blind)} · видимый: ${fmt(visible)}</div>`;
  }
  const historicCount = state.forecastLog.filter(r => r && r.p1 == null).length;
  if (historicCount) html += `<div style="color:#888">Legacy без P(1): ${historicCount} (исторические прогнозы не заменялись)</div>`;
  html += '<div style="margin-top:8px"><b>Веса предсказателей:</b></div><table>';

  const entries = Object.entries(state.weights).sort((a, b) => b[1] - a[1]);

  for (const [name, w] of entries) {
    html += `<tr><td>${name}</td><td style="text-align:right">${w.toFixed(3)}</td></tr>`;
  }

  html += '</table>';

  stats.innerHTML = html;

  renderPatternPanel();
  // renderPeriodPanel();
  renderPpmPanel();
  renderSessionPanel();
  renderAntiPanel();
}

/* ---------- Проверка моделей ---------- */
function formatBench(m) {
  return m.n ? `${(100 * m.hits / m.n).toFixed(1)}% · ${(m.brier / m.n).toFixed(3)} · ${(m.log / m.n).toFixed(3)}` : '—';
}

let benchmarkRunning = false;
const btnBenchmark = document.getElementById('btnBenchmark');

function renderBenchmark() {
  const panel = document.getElementById('benchmarkPanel');
  // Повторный клик во время пересчёта абляций запускал вторую цепочку
  // setTimeout с чередующейся записью в одну панель.
  if (benchmarkRunning) return;
  if (!state.history.length) { panel.textContent = 'Сначала сыграйте хотя бы один ход.'; return; }
  benchmarkRunning = true;
  btnBenchmark.disabled = true;
  const finish = () => { benchmarkRunning = false; btnBenchmark.disabled = false; };
  panel.textContent = 'Вычисляю последовательное тестирование…';
  // setTimeout даёт браузеру отрисовать уведомление до вычислений.
  setTimeout(() => {
    try {
      // Отдельный снимок: ручные ходы могут продолжаться во время асинхронных абляций.
      const benchmarkHistory = state.history.slice();
      const benchmarkTimes = state.moveTimes.slice();
      const measureLast = Math.min(500, benchmarkHistory.length);
      const result = replay(benchmarkHistory, benchmarkTimes, {
        collectBenchmark: true, measureLast,
      });
      const b = result.benchmark;
      let html = `<b>Walk-forward: последние ${benchmarkHistory.length - b.measureStart} ходов</b>`;
      html += '<div style="color:#888;margin:6px 0">Историческая симуляция v2.2 на реальных ответах; прогнозы пересчитаны и НЕ являются реально показанными. В видимом режиме поведение человека могло зависеть от исходных предсказаний.</div>';
      html += '<div style="color:#888">Метрики: точность % · Brier (меньше лучше) · LogLoss (меньше лучше).</div>';
      html += '<table><tr><td><b>Модель</b></td><td style="text-align:right"><b>Метрики</b></td></tr>';
      const order = ['ensemble', ...PREDICTORS.map(p => p.name), 'always0', 'always1'];
      const labels = { ensemble: 'Ансамбль 2.2', always0: 'Всегда 0', always1: 'Всегда 1' };
      for (const name of order) {
        html += `<tr><td>${labels[name] || name}</td><td style="text-align:right">${formatBench(b.models[name])}</td></tr>`;
      }
      html += '</table>';
      html += '<div style="margin-top:10px"><b>Абляция (отдельное обучение без голоса эксперта)</b></div>';
      html += '<div style="color:#888">Каждый ансамбль обучается заново на той же истории; остальные эксперты и их прогнозы могут меняться из-за реакции на собственные прошлые ответы.</div>';
      panel.innerHTML = html;
      const names = PREDICTORS.map(p => p.name);
      const metrics = [];
      const startRun = () => {
        if (!names.length) {
          let tab = '<table><tr><td><b>Убран эксперт</b></td><td style="text-align:right"><b>Точность · Brier · LogLoss</b></td></tr>';
          for (const [name, score] of metrics) {
            tab += `<tr><td>${name}</td><td style="text-align:right">${formatBench(score)}</td></tr>`;
          }
          tab += '</table>';
          panel.innerHTML = html + tab;
          finish();
          return;
        }
        const name = names.shift();
        const without = replay(benchmarkHistory, benchmarkTimes, {
          exclude: name, collectScore: true, measureLast,
        });
        metrics.push([name, without.score]);
        panel.innerHTML = html + `<div style="color:#888">Пересчёт абляций: ${metrics.length} из ${PREDICTORS.length}</div>`;
        setTimeout(startRun, 0);
      };
      startRun();
    } catch (err) {
      panel.textContent = 'Ошибка тестирования: ' + err.message;
      finish();
    }
  }, 10);
}
btnBenchmark.addEventListener('click', renderBenchmark);

/* ---------- Экспорт / импорт ---------- */
const btnExport = document.getElementById('btnExport');
const btnImport = document.getElementById('btnImport');
const fileInput = document.getElementById('fileInput');

btnExport.addEventListener('click', () => {
  try {
    // Экспорт текущего состояния, а не потенциально повреждённого primary storage.
    const data = JSON.stringify(serializable(state));
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `guessGameState_${APP_VERSION}_${date}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { alert('Ошибка экспорта: ' + e.message); }
});

btnImport.addEventListener('click', () => {
  if (currentForecast) { alert('Сначала завершите текущий ход.'); return; }
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      validatePayload(parsed);
      const n = parsed.history.length;
      const cur = state.history;
      const isDup = n >= 10 && cur.length >= n &&
        (parsed.history.every((x, i) => x === cur[i]) ||
         parsed.history.every((x, i) => x === cur[cur.length - n + i]));
      const hint = isDup ? '\n⚠ Данные похожи на уже импортированные. append создаст дубликаты.\n' : '';
      const mode = prompt(`Импорт: ${n} ходов.${hint}\nВведите append (добавить) или replace (заменить).`,
        isDup ? 'replace' : 'append');
      if (mode == null) return;
      const m = mode.trim().toLowerCase();
      if (m !== 'append' && m !== 'replace') {
        alert('Ожидалось append или replace, ничего не изменено.'); return;
      }
      if (m === 'append' && isDup && !confirm('История содержит вероятные дубликаты. Всё равно добавить?')) return;
      if (!confirm(m === 'replace'
          ? 'Заменить текущую историю? Предыдущее состояние попадёт в _backup. Рекомендуется экспорт.'
          : 'Добавить историю? Внутренняя модель пересчитается, исторические прогнозы сохранятся без подмены.')) return;
      let next;
      if (m === 'replace') {
        next = restoreState(parsed);
      } else {
        const imported = restoreState(parsed);
        const combined = cur.concat(imported.history);
        if (combined.length > 1000000) throw new Error('Слишком длинная объединённая история');
        const combinedTimes = state.moveTimes.concat(imported.moveTimes);
        const result = replay(combined, combinedTimes, {
          historicalPredictions: state.predictions.concat(imported.predictions),
        });
        next = emptyState();
        next.history = combined;
        next.moveTimes = combinedTimes;
        next.predictions = state.predictions.concat(imported.predictions);
        next.forecastLog = state.forecastLog.concat(imported.forecastLog);
        next.weights = result.weights;
        next.ppm = result.ppm;
        next.ctw = result.ctw;
        next.sgd = result.sgd;
        next.startedAt = state.startedAt;
        next.blindMode = state.blindMode;
        next.total = state.total + imported.total;
        next.correct = state.correct + imported.correct;
        next.lastPrediction = next.predictions.length ? next.predictions.at(-1) : null;
        // Для реактивных экспертов при последующих ходах используются РЕАЛЬНО
        // сохранённые прогнозы. В replay при пересчёте использовались модельные.
        // Статистический статус этого ограничения явно описан в README.
      }
      const snapshot = serializable(next);
      validatePayload(snapshot);
      writeWithBackup(compactForStorage(snapshot));
      location.reload();
    } catch (e) {
      alert('Импорт отменён: ' + e.message + '\nТекущее сохранение не изменено.');
    }
  };
  reader.onerror = () => alert('Не удалось прочитать файл.');
  reader.readAsText(file);
  fileInput.value = '';
});

document.getElementById('btnRetrySave').addEventListener('click', () => {
  if (persistOrMarkUnsaved()) {
    loadWarning = ''; renderPersistenceNotice();
    alert('Текущее состояние успешно сохранено.');
  } else {
    alert('Запись по-прежнему невозможна. Экспортируйте ручную историю в JSON.');
  }
});
const exportStorageRaw = () => {
  try {
    downloadJsonObject(downloadStorageRecovery(), `GuessGame_storage_recovery_${APP_VERSION}.json`);
  } catch (e) { alert('Не удалось извлечь сырые данные: ' + e.message); }
};
document.getElementById('btnRecovery').addEventListener('click', exportStorageRaw);
document.getElementById('btnRecoveryAlways').addEventListener('click', exportStorageRaw);

/* ---------- UI лаборатории ---------- */
const tabManual = document.getElementById('tabManual');
const tabLab = document.getElementById('tabLab');
const labStatus = document.getElementById('labStatus');
const labResults = document.getElementById('labResults');
let activeLabJob = null;
let labLastExperiment = null;
let labLastComparison = null;
let labLastSuite = null;

function setView(lab) {
  document.getElementById('manualView').classList.toggle('hidden', lab);
  document.getElementById('labView').classList.toggle('hidden', !lab);
  tabManual.classList.toggle('primary', !lab);
  tabLab.classList.toggle('primary', lab);
  tabManual.setAttribute('aria-pressed', String(!lab));
  tabLab.setAttribute('aria-pressed', String(lab));
}
tabManual.addEventListener('click', () => setView(false));
tabLab.addEventListener('click', () => setView(true));

for (const name of ['I','S','M','C','Q','E','D','G']) {
  const input = document.getElementById('cfg'+name);
  const output = document.getElementById('value'+name);
  input.addEventListener('input', () => {
    output.textContent = name==='M'?input.value:Number(input.value).toFixed(2);
  });
}
function labConfig() {
  const params = { G:Number(document.getElementById('cfgG').value) };
  for (const name of ['I','S','M','C','Q','E','D'])
    params[name] = Number(document.getElementById('cfg'+name).value);
  const turns = Number(document.getElementById('labTurns').value);
  const sessionSize = Number(document.getElementById('labSessionSize').value);
  const bitSetting = document.getElementById('labInitialBit').value;
  const source = document.getElementById('labPredictorStart').value;
  if (!Number.isSafeInteger(turns) || turns<1 || turns>10000 ||
      !Number.isSafeInteger(sessionSize) || sessionSize<1 || sessionSize>10000)
    throw new Error('Укажите целые числа: ходов 1–10000, длина сессии 1–10000');
  return { params, turns, sessionSize, source,
    aggregator:document.getElementById('labAggregator').value,
    initialBit:bitSetting==='1'?1:0, alternateStart:bitSetting==='alternate' };
}
function makeLabRunner(cfg) {
  // Состояние из реальной игры только КОПИРУЕТСЯ (не передаём Map по ссылке).
  const startState = cfg.source==='trained'
    ? hydrateState(JSON.parse(JSON.stringify(manualEngine.exportState())))
    : emptyState();
  return new SimulationRunner({ ...cfg, startState });
}
function labBusy(busy) {
  for (const id of ['labRun','labCompare','labCompareAggregators','labBattery','labAudit'])
    document.getElementById(id).disabled=busy;
  document.getElementById('labCancel').disabled=!busy;
}
function labLineChart(data, key, minY, maxY, title) {
  if (!data.length) return '';
  const width=480,height=125,left=24,right=9,top=16,bottom=20;
  const stride=Math.max(1,Math.ceil(data.length/280));
  const sampled=data.filter((_,i)=>i%stride===0 || i===data.length-1);
  const plotWidth=width-left-right, plotHeight=height-top-bottom;
  const points=sampled.map(row=>{
    const x=left+(row.t-1)/Math.max(1,data.length-1)*plotWidth;
    const y=top+(maxY-row[key])/(maxY-minY)*plotHeight;
    return x.toFixed(2)+','+y.toFixed(2);
  }).join(' ');
  return `<svg class="labchart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
    <line x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}" stroke="#aaa"/>
    <line x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}" stroke="#aaa"/>
    <line x1="${left}" y1="${top+plotHeight/2}" x2="${width-right}" y2="${top+plotHeight/2}" stroke="#ccc" stroke-dasharray="3 3"/>
    <polyline points="${points}" fill="none" stroke="#327bb2" stroke-width="1.8" stroke-linejoin="round"/>
    <text x="${left+2}" y="12" font-size="11" fill="#444">${title}</text>
    <text x="2" y="${top+4}" font-size="10" fill="#777">${maxY}</text>
    <text x="2" y="${height-bottom+2}" font-size="10" fill="#777">${minY}</text>
    <text x="${width-right-48}" y="${height-4}" font-size="10" fill="#777">ход ${data.length}</text></svg>`;
}
function labTrend(logs, window=50) {
  let hits=0;
  return logs.map((r,i)=>{
    hits+=Number(r.hit);
    if (i>=window) hits-=Number(logs[i-window].hit);
    return { t:r.t, accuracy:hits/Math.min(window,i+1) };
  });
}
function labWeightChart(runner) {
  const trace=runner.weightTrace;
  if (!trace.length) return '';
  const final=trace.at(-1).weights;
  const names=Object.entries(final).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n])=>n);
  const colors=['#2679ba','#ca743d','#32976c','#975bb5','#697e84'];
  const W=480,H=140,x0=30,y0=12,width=440,height=102;
  const ymax=Math.max(1,...trace.flatMap(r=>names.map(n=>r.weights[n]||0)))*1.06;
  const lines=names.map((name,j)=>{
    const points=trace.map(r=>{
      const x=x0+(r.t-1)/Math.max(1,runner.history.length-1)*width;
      const y=y0+height*(1-(r.weights[name]||0)/ymax);
      return x.toFixed(1)+','+y.toFixed(1);
    }).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${colors[j]}" stroke-width="1.5"/>`;
  }).join('');
  const legend=names.map((n,i)=>`<span style="color:${colors[i]};margin-right:12px">● ${n}</span>`).join('');
  return `<svg class="labchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Динамика пяти ведущих весов экспертов"><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0+height}" stroke="#aaa"/><line x1="${x0}" y1="${y0+height}" x2="${x0+width}" y2="${y0+height}" stroke="#aaa"/>${lines}<text x="2" y="18" fill="#666" font-size="10">${ymax.toFixed(1)}</text></svg><div style="font-size:11px">${legend}</div>`;
}
const percentage=x=>x===null || !Number.isFinite(x)?'—':(x*100).toFixed(1)+'%';
function labTransitionTable(transitions) {
  if (!transitions.length) return '';
  let html='<div class="labbox"><b>Изменения установки G</b><table><tr><th>Ход</th><th>Новое G</th><th>До / после 50</th><th>Просадка</th><th>Восстановление</th></tr>';
  for (const x of transitions) html+=`<tr><td>${x.at}</td><td>${x.g}</td><td>${percentage(x.preAccuracy)} / ${percentage(x.postAccuracy)}</td><td>${x.drop===null?'—':(100*x.drop).toFixed(1)+' п.п.'}</td><td>${x.recoveryMoves===null?'Не зафиксировано':x.recoveryMoves+' ходов'}</td></tr>`;
  return html+'</table><p style="font-size:11px;color:#666">Восстановление: первая полностью заполненная 50-ходовая скользящая точность не ниже исходной более чем на 5 п.п. «Не зафиксировано» не означает невозможность восстановления.</p></div>';
}
function labSummaryTable(runner) {
  const sum=runner.summary(), window=Number(document.getElementById('labWindow').value);
  return `<div class="labbox"><div class="labmetrics">
    <div class="labmetric"><strong>${percentage(sum.accuracy)}</strong>угадано</div>
    <div class="labmetric"><strong>${sum.hits} / ${sum.n}</strong>совпадения</div>
    <div class="labmetric"><strong>${sum.brier.toFixed(3)}</strong>Brier</div>
    <div class="labmetric"><strong>${percentage(rollingAccuracy(runner.history,window))}</strong>последние ${window}</div>
    </div><p>Агрегатор: <b>${AGGREGATORS[runner.aggregator].label}</b> · Сессий: ${sum.sessions} · Начальных ходов модели: ${sum.initialPredictorCount}</p>
    <p>Повторы внутри сессий: <b>${sum.repetitions===null?'—':(100*sum.repetitions).toFixed(1)+'%'}</b> · Средние V/A: ${sum.meanV.toFixed(3)} / ${sum.meanA.toFixed(3)}</p>
    <div>Серии: 1 — ${sum.runs['1']}, 2 — ${sum.runs['2']}, 3 — ${sum.runs['3']}, 4+ — ${sum.runs['4+']}</div></div>`;
}
function labRenderSingle(runner, incomplete=false) {
  const rows=runner.history,last=rows.slice(-10).reverse();
  const window=Number(document.getElementById('labWindow').value);
  let html=labSummaryTable(runner);
  html+='<div class="labbox"><b>Локальная точность</b>'+labLineChart(labTrend(rows,window),'accuracy',0,1,'Скользящее окно '+window)+'</div>';
  html+=labTransitionTable(runner.summary().transitions);
  html+='<div class="labbox"><b>История весов ведущих экспертов</b>'+labWeightChart(runner)+'</div>';
  if(runner.aggregator==='multi') {
    const out=runner.predictor.aggregatorStatus();
    html+='<div class="labbox"><b>Мета-веса скоростей</b><p>'+out.rates.map((r,i)=>`η=${r.eta}: ${(out.outer[i]*100).toFixed(1)}%`).join(' · ')+'</p></div>';
  }
  html+='<div class="labbox"><b>Эмоциональное состояние</b>'+labLineChart(rows.map(r=>({t:r.t,value:r.Vafter})),'value',-1,1,'Валентность V')+labLineChart(rows.map(r=>({t:r.t,value:r.Aafter})),'value',0,1,'Активация A')+'</div>';
  html+='<div class="labbox"><b>Автоматический механизм ИНР</b>'+labLineChart(rows.map(r=>({t:r.t,value:r.Ieff})),'value',0,1,'Инерция I*')+labLineChart(rows.map(r=>({t:r.t,value:r.Seff})),'value',0,1,'Насыщение S*')+'</div>';
  html+='<div class="labbox"><b>Последние 10 ходов</b><table><tr><th>№</th><th>Бит</th><th>Прогноз</th><th>Результат</th><th>V / A</th></tr>';
  for(const row of last) html+=`<tr><td>${row.t}</td><td>${row.bit}</td><td>${row.guess}</td><td>${row.hit?'✓':'×'}</td><td>${row.Vafter.toFixed(2)} / ${row.Aafter.toFixed(2)}</td></tr>`;
  html+='</table></div>';
  labResults.innerHTML=(incomplete?'<p>Эксперимент остановлен досрочно.</p>':'')+html;
}
function labRenderCompare(runs, caption, labelMode = 'goal') {
  const labelFor = run => labelMode === 'aggregators'
    ? AGGREGATORS[run.aggregator].label
    : 'G = ' + run.params.G;
  const shortLabelFor = run => labelMode === 'aggregators'
    ? AGGREGATORS[run.aggregator].label
    : 'G=' + run.params.G;
  let html=`<div class="labbox"><b>${caption}</b><table><tr><th>Условия</th><th>Точность</th><th>Последние 50</th><th>Brier</th><th>Повторы</th></tr>`;
  for (const run of runs){
    const m=run.summary();
    html+=`<tr><td>${labelFor(run)}</td><td>${percentage(m.accuracy)}</td><td>${percentage(m.last50)}</td><td>${m.brier.toFixed(3)}</td><td>${percentage(m.repetitions)}</td></tr>`;
  }
  html+='</table><p style="font-size:11px;color:#666">Независимые замкнутые игры: прогнозы влияют на последующие решения ИНР, поэтому последовательности игроков могут различаться. Это сравнение режимов игры, не парный тест на одинаковой последовательности.</p></div>';
  for(const run of runs){
    html+=`<div class="labbox"><b>${shortLabelFor(run)}</b>${labLineChart(labTrend(run.history),'accuracy',0,1,'Точность на последних 50')} ${labTransitionTable(run.summary().transitions)}</div>`;
  }
  labResults.innerHTML=html;
}
function labRenderBattery(results,stage) {
  const scenarios=[...new Set(results.map(x=>x.scenario.id))];
  let html=`<div class="labbox"><b>${stage==='dev'?'Батарея разработки':'Резервная контрольная батарея'}</b>
    <p>Каждая строка: собственный виртуальный игрок и предсказатель. Сравнение по точности и Brier на отдельных траекториях; эти числа нельзя трактовать как независимые повторения.</p>
    <table><tr><th>Сценарий</th><th>Агрегатор</th><th>Общая точность</th><th>Последние 50</th><th>Brier</th><th>Просадка при смене G</th></tr>`;
  for(const item of results){
    const m=item.runner.summary();
    const drop=m.transitions.find(t=>t.drop!==null);
    html+=`<tr><td>${item.scenario.name}</td><td>${AGGREGATORS[item.runner.aggregator].label}</td><td>${percentage(m.accuracy)}</td><td>${percentage(m.last50)}</td><td>${m.brier.toFixed(3)}</td><td>${drop?(100*drop.drop).toFixed(1)+' п.п.':'—'}</td></tr>`;
  }
  html+='</table></div><div class="labbox"><b>Сводные показатели по сценариям</b><table><tr><th>Агрегатор</th><th>Взвешенная точность</th><th>Средний Brier</th><th>Сценариев</th></tr>';
  for(const agg of LAB_AGG_KEYS){
    const chosen=results.filter(r=>r.runner.aggregator===agg);
    if(!chosen.length) continue;
    const n=chosen.reduce((s,r)=>s+r.runner.history.length,0);
    const hits=chosen.reduce((s,r)=>s+r.runner.correct,0);
    const sq=chosen.reduce((s,r)=>s+r.runner.brier,0);
    html+=`<tr><td>${AGGREGATORS[agg].label}</td><td>${percentage(n?hits/n:null)}</td><td>${n?(sq/n).toFixed(3):'—'}</td><td>${chosen.length}</td></tr>`;
  }
  html+='</table><p style="font-size:11px;color:#666">Сводка — описательная, не оценка статистической значимости. Сценарии разработок и резерва должны оцениваться отдельно.</p></div>';
  labResults.innerHTML=html;
}
function labExportFile(obj, filename) {
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1200);
}
function labPlans(mode,cfg) {
  if ((mode==='battery'||mode==='audit') && cfg.turns>2000)
    throw new Error('Для пакетной батареи задайте не более 2000 ходов на сценарий. Одиночный режим допускает 10 000.');
  if(mode==='single') return [{cfg,scenario:null}];
  if(mode==='goal') return [-1,0,1].map(g=>({cfg:{...cfg,params:{...cfg.params,G:g}},scenario:null}));
  if(mode==='aggregators') return LAB_AGG_KEYS.map(aggregator=>({cfg:{...cfg,aggregator},scenario:null}));
  const stage=mode==='battery'?'dev':'audit';
  return BENCHMARK_PRESETS.filter(s=>s.stage===stage).flatMap(scenario=>
    LAB_AGG_KEYS.map(aggregator=>{
      const params={...cfg.params,...scenario.delta};
      const goalSchedule=scenario.goalSwitch?goalSwitchEvents(cfg.turns,params.G):[];
      return {scenario,cfg:{...cfg,params,aggregator,goalSchedule}};
    }));
}
function startLabJob(mode='single') {
  if(activeLabJob)return;
  try{
    const cfg=labConfig(),plans=labPlans(mode,cfg);
    // Для больших прогонов создаём один экземпляр за раз, без удержания
    // ненужных больших копий истории до выполнения сценария.
    const job={mode,plans,index:0,done:[],current:null,cancelled:false};
    activeLabJob=job;
    labLastExperiment=null;labLastComparison=null;labLastSuite=null;
    document.getElementById('labExport').disabled=true;
    labResults.innerHTML='';labBusy(true);
    labStatus.textContent=`Начало: ${plans.length} независимых прогонов…`;
    const work=()=>{
      try{
        if(activeLabJob!==job)return;
        if(job.cancelled){
          labStatus.textContent='Остановлено. Неполный результат не выдаётся за полный эксперимент.';
          if(job.current && mode==='single')labRenderSingle(job.current,true);
          activeLabJob=null;labBusy(false);return;
        }
        if(!job.current)job.current=makeLabRunner(job.plans[job.index].cfg);
        const run=job.current;
        const count=Math.min(60,run.turns-run.history.length);
        for(let j=0;j<count;j++)run.step();
        labStatus.textContent=`Прогон ${job.index+1}/${plans.length} · ${run.history.length}/${run.turns} ходов`;
        if(run.history.length===run.turns){
          job.done.push({scenario:job.plans[job.index].scenario,runner:run});
          job.current=null;job.index++;
          if(job.index===plans.length){
            if(mode==='single'){
              labLastExperiment=job.done[0].runner;labRenderSingle(labLastExperiment);
            }else if(mode==='goal'||mode==='aggregators'){
              labLastComparison=job.done.map(x=>x.runner);
              labRenderCompare(labLastComparison,
                mode==='goal'?'Сравнение целей G':'Сравнение агрегаторов',
                mode==='goal'?'goal':'aggregators');
            }else{
              labLastSuite={stage:mode==='battery'?'dev':'audit',results:job.done};
              labRenderBattery(job.done,labLastSuite.stage);
            }
            document.getElementById('labExport').disabled=false;
            labStatus.textContent='Готово. Все виртуальные ходы изолированы от ручной истории.';
            activeLabJob=null;labBusy(false);return;
          }
        }
        setTimeout(work,0);
      }catch(e){labStatus.textContent='Ошибка эксперимента: '+e.message;activeLabJob=null;labBusy(false);}
    };
    setTimeout(work,0);
  }catch(e){labStatus.textContent='Невозможно запустить: '+e.message;}
}
document.getElementById('labRun').addEventListener('click',()=>startLabJob('single'));
document.getElementById('labCompare').addEventListener('click',()=>startLabJob('goal'));
document.getElementById('labCompareAggregators').addEventListener('click',()=>startLabJob('aggregators'));
document.getElementById('labBattery').addEventListener('click',()=>startLabJob('battery'));
document.getElementById('labAudit').addEventListener('click',()=>startLabJob('audit'));
document.getElementById('labCancel').addEventListener('click',()=>{if(activeLabJob)activeLabJob.cancelled=true;});
document.getElementById('labExport').addEventListener('click',()=>{
  if(labLastExperiment)labExportFile(labLastExperiment.export(),`GuessGame_v${APP_VERSION}_single.json`);
  else if(labLastComparison)labExportFile({format:'GuessGameExperimentComparison',version:APP_VERSION,
      experiments:labLastComparison.map(r=>r.export())},`GuessGame_v${APP_VERSION}_comparison.json`);
  else if(labLastSuite)labExportFile({format:'GuessGameBenchmarkSuite',version:APP_VERSION,
      stage:labLastSuite.stage, model:'INR-v0.2-frozen',
      experiments:labLastSuite.results.map(x=>({scenario:x.scenario.id,experiment:x.runner.export()}))},
      `GuessGame_v${APP_VERSION}_`+labLastSuite.stage+'_suite.json');
});

/* ---------- Старт ---------- */

load();
manualEngine = new PredictorEngine(state);
lastSavedTotal = state.total;
document.getElementById('chkBlind').checked = state.blindMode;
renderStats();
renderPersistenceNotice();
