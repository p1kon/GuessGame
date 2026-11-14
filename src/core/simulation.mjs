import { PredictorEngine, emptyState } from './predictor.mjs';
import { VirtualPlayer } from './virtual-player.mjs';
/* ---------- Независимый симулятор ---------- */
class SimulationRunner {
  constructor({ params, turns, sessionSize, startState, initialBit=0,
      alternateStart=false, aggregator='baseline', goalSchedule=[] }) {
    if (!Number.isSafeInteger(turns) || turns<1 || turns>10000)
      throw new Error('Количество ходов должно быть 1–10000');
    if (!Number.isSafeInteger(sessionSize) || sessionSize<1 || sessionSize>10000)
      throw new Error('Длина сессии должна быть 1–10000');
    this.params = { ...params };
    this.turns = turns;
    this.sessionSize = sessionSize;
    this.initialBit = initialBit;
    this.alternateStart = alternateStart;
    this.aggregator=aggregator;
    this.goalSchedule=goalSchedule.map(x=>({...x})).sort((a,b)=>a.at-b.at);
    for(const event of this.goalSchedule) {
      if (!Number.isSafeInteger(event.at) || event.at<1 || event.at>turns ||
          !Number.isFinite(event.g) || event.g<-1 || event.g>1)
        throw new Error('Неверное внешнее переключение G');
    }
    this.predictor = new PredictorEngine(startState || emptyState(),aggregator);
    this.initialPredictorCount = this.predictor.state.history.length;
    const priorTimes = this.predictor.state.moveTimes.filter(x => x !== null);
    const prevTime = priorTimes.length ? priorTimes.at(-1) : 0;
    this.virtualTime = Math.max(Date.UTC(2026,0,1), prevTime + 3_600_000);
    this.player = new VirtualPlayer(params, initialBit);
    this.history = [];
    this.weightTrace = [];
    this.correct = 0;
    this.brier = 0;
    this.timeStepMs = 2000;
    this.sessionPauseMs = 600000;
  }
  step() {
    const t = this.history.length;
    if (t >= this.turns) return null;
    if (t > 0) {
      if (t % this.sessionSize === 0) {
        this.virtualTime += this.sessionPauseMs;
        const nextBit = this.alternateStart ? (this.initialBit ^ (this.player.sessionIndex+1)%2) : this.initialBit;
        this.player.beginSession(nextBit);
      } else this.virtualTime += this.timeStepMs;
    }
    // Изменение цели — ВНЕШНЕЕ воздействие, механизм ИНР не изменяется.
    const scheduled=this.goalSchedule.find(x=>x.at===t+1);
    if (scheduled) this.player.p.G=scheduled.g;
    // ВАЖНО: текущий бит фиксируется ДО получения прогноза.
    const decision = this.player.choose();
    const prediction = this.predictor.predict(this.virtualTime, false);
    this.predictor.update(decision.bit, prediction, {
      source:'simulated', answeredAt:this.virtualTime+1000
    });
    const row = this.player.feedback(prediction.guess);
    const hit = prediction.guess === decision.bit;
    this.correct += Number(hit);
    this.brier += (prediction.prob1-decision.bit)**2;
    const log = {
      t:t+1, session:row.session+1, time:this.virtualTime,
      bit:decision.bit, guess:prediction.guess, p1:prediction.prob1, hit,
      goal:this.player.p.G, goalChanged:!!(scheduled && t>0),
      prevBit:row.prevBit, runBefore:row.runBefore, runAfter:row.runAfter,
      f:row.f, q:row.q, Ieff:row.Ieff, Seff:row.Seff, agency:row.agency,
      threat:row.threat, prolong:row.prolong, novelty:row.novelty,
      alternation:row.alternation, automatic:row.automatic,
      reflexive:row.reflexive, exploration:row.exploration,
      impulse:row.impulse, reward:row.reward,
      rGoal:row.rGoal, rInsight:row.rInsight,
      Vbefore:row.Vbefore, Abefore:row.Abefore,
      Vafter:row.Vafter, Aafter:row.Aafter,
    };
    this.history.push(log);
    if (t===0 || scheduled || (t+1)%10===0 || t+1===this.turns)
      this.weightTrace.push({t:t+1, weights:this.predictor.effectiveWeights(),
        aggregation:this.predictor.aggregatorStatus()});
    return log;
  }
  summary() {
    const h=this.history;
    const sessions=h.length ? h.at(-1).session : 0;
    const repeated=h.filter(r=>r.prevBit!==null);
    const repeats=repeated.filter(r=>r.bit===r.prevBit).length;
    const breaks=h.filter(r=>r.prevBit!==null && r.bit!==r.prevBit).length;
    const runs={ '1':0, '2':0, '3':0, '4+':0 };
    // Сессионные серии: каждая первая запись новой сессии открывает новую.
    for (let idx=0;idx<h.length;idx++) {
      const r=h[idx], next=h[idx+1];
      if (!next || next.session!==r.session || next.bit!==r.bit) {
        const bucket=r.runAfter>=4?'4+':String(r.runAfter);
        runs[bucket]++;
      }
    }
    return { n:h.length, hits:this.correct, accuracy:h.length?this.correct/h.length:0,
      brier:h.length?this.brier/h.length:0, sessions, repetitions:repeated.length?
        repeats/repeated.length:null, runs, breaks,
      initialPredictorCount:this.initialPredictorCount,
      meanV:h.length?h.reduce((a,r)=>a+r.Vafter,0)/h.length:0,
      meanA:h.length?h.reduce((a,r)=>a+r.Aafter,0)/h.length:0,
      parameters:this.params, aggregator:this.aggregator,
      last50:rollingAccuracy(h,50), last100:rollingAccuracy(h,100),
      transitions:measureTransitions(h,this.goalSchedule) };
  }
  export() {
    return { format:'GuessGameExperiment', version:'2.3.2-INR-0.2',
      model:'INR-v0.2-frozen', predictor:'16-experts-v2.3',
      config: { params:this.params, turns:this.turns, sessionSize:this.sessionSize,
        initialBit:this.initialBit, alternateStart:this.alternateStart,
        timeStepMs:this.timeStepMs, sessionPauseMs:this.sessionPauseMs,
        aggregator:this.aggregator, goalSchedule:this.goalSchedule },
      summary:this.summary(), turns:this.history.slice(), weightTrace:this.weightTrace,
      note:'Симуляция, не реальные человеческие ходы; не импортировать в ручную историю.' };
  }
}

/* ---------- Метрики лаборатории ---------- */
function rollingAccuracy(logs,window) {
  const tail=logs.slice(-Math.min(window,logs.length));
  return tail.length?tail.reduce((s,r)=>s+Number(r.hit),0)/tail.length:null;
}
function segmentHitRate(logs,startInclusive,endExclusive) {
  const xs=logs.slice(startInclusive,endExclusive);
  return xs.length?xs.reduce((s,r)=>s+Number(r.hit),0)/xs.length:null;
}
function measureTransitions(logs,events,window=50) {
  return events.filter(e=>e.at>1 && e.at<=logs.length).map(e=>{
    const start=e.at-1;
    const before=segmentHitRate(logs,Math.max(0,start-window),start);
    const after=segmentHitRate(logs,start,Math.min(logs.length,start+window));
    // Восстановление: скользящие 50 ходов >= точности до переключения - 5 п.п.
    // Используем только точки после заполнения полного окна.
    let recovered=null;
    const nextEvent=events.filter(other=>other.at>e.at).sort((a,b)=>a.at-b.at)[0];
    const episodeEnd=nextEvent?Math.min(logs.length,nextEvent.at-1):logs.length;
    if (before!==null && start>=window) {
      for(let end=start+window;end<=episodeEnd;end++){
        const acc=segmentHitRate(logs,end-window,end);
        if(acc>=before-0.05) {recovered=end-start; break;}
      }
    }
    return {at:e.at,g:e.g,window,preAccuracy:before,
      postAccuracy:after,drop:before!==null&&after!==null?before-after:null,
      recoveryMoves:recovered,postErrors:logs.slice(start,start+window).filter(r=>!r.hit).length};
  });
}
const LAB_AGG_KEYS=Object.freeze(['baseline','slow','fast','multi']);
const BENCHMARK_PRESETS=Object.freeze([
  {id:'anti',name:'Противодействие',stage:'dev',delta:{G:-1}},
  {id:'neutral',name:'Нейтральная игра',stage:'dev',delta:{G:0}},
  {id:'cooperate',name:'Игра за компьютер',stage:'dev',delta:{G:1}},
  {id:'shortMemory',name:'Короткая память',stage:'dev',delta:{G:-1,M:3}},
  {id:'noEmotion',name:'Без эмоций',stage:'dev',delta:{G:-1,E:0}},
  {id:'switchGoal',name:'Внешняя смена цели',stage:'dev',delta:{G:0},goalSwitch:true},
  {id:'heldoutA',name:'Резерв: иной характер',stage:'audit',delta:{I:0.65,S:0.9,M:7,C:0.4,Q:0.85,E:0.3,D:0.45,G:-1}},
  {id:'heldoutB',name:'Резерв: переключения',stage:'audit',delta:{I:0.8,S:0.55,M:13,C:0.6,Q:0.25,E:0.85,D:0.9,G:1},goalSwitch:true}
]);
function goalSwitchEvents(turns,initialG=0) {
  const block=Math.max(1,Math.floor(turns/3));
  return [{at:1,g:initialG},{at:block+1,g:-1},{at:2*block+1,g:0}]
    .filter((e,i,arr)=>e.at<=turns && arr.findIndex(x=>x.at===e.at)===i);
}


export { SimulationRunner, rollingAccuracy, segmentHitRate, measureTransitions, LAB_AGG_KEYS, BENCHMARK_PRESETS, goalSwitchEvents };
