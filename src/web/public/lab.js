import { SimulationRunner } from '/core/index.mjs';
const $ = id => document.getElementById(id);
let experiment;
$('lab-form').addEventListener('submit', async event => {
  event.preventDefault(); $('lab-run').disabled = true; $('lab-export').hidden = true;
  try {
    const data = new FormData(event.target), params = {};
    for (const key of ['I', 'S', 'M', 'C', 'G', 'Q', 'E', 'D']) params[key] = Number(data.get(key));
    const runner = new SimulationRunner({ params, turns: Number(data.get('turns')), sessionSize: Number(data.get('sessionSize')),
      initialBit: 0, alternateStart: false, aggregator: data.get('aggregator'), goalSchedule: [] });
    while (runner.history.length < runner.turns) {
      for (let i = 0; i < 50 && runner.step() !== null; i++) {}
      $('lab-status').textContent = `Выполнено ${runner.history.length} из ${runner.turns} ходов…`;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    experiment = runner.export(); const summary = runner.summary();
    $('lab-result').replaceChildren();
    const table = document.createElement('table');
    for (const [name, value] of [['Ходов', summary.n], ['Угадано', summary.hits], ['Точность', (summary.accuracy * 100).toFixed(2) + '%'], ['Brier', summary.brier.toFixed(5)], ['Сессий', summary.sessions]]) {
      const row = table.insertRow(); row.insertCell().textContent = name; row.insertCell().textContent = value;
    }
    $('lab-result').append(table); $('lab-status').textContent = 'Симуляция завершена. Личная история не изменена.'; $('lab-export').hidden = false;
  } catch (error) { $('lab-status').textContent = error.message; }
  finally { $('lab-run').disabled = false; }
});
$('lab-export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(experiment, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'GuessGame_simulation.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
