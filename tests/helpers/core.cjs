'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadCore(file = path.resolve(__dirname, '../../GuessGame_v2.3.2.html')) {
  const html = fs.readFileSync(file, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.indexOf('/* ---------- UI ---------- */', start);
  if (start < 0 || end < 0) throw new Error('Core markers missing');
  const storage = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(String(key), String(value)),
      removeItem: key => storage.delete(key),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(start + 8, end) + `
    ;this.api = { PredictorEngine, VirtualPlayer, SimulationRunner, PREDICTORS,
      AGGREGATORS, hydrateState, restoreState, emptyState, validatePayload,
      compactForStorage, writeWithBackup, STORAGE_KEY, QUARANTINE_KEY };
  `, sandbox, { filename: file });
  return { api: sandbox.api, sandbox, storage };
}
module.exports = { loadCore };
