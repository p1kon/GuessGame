import { validBit } from './predictor.mjs';
/* ---------- Виртуальный игрок ИНР v0.2 ---------- */
// Только восемь прежних настраиваемых параметров. Ни генератора случайных чисел, ни
// предварительного выбора длины серии, ни доступа к текущему прогнозу.
const VP_DEFAULTS = Object.freeze({ I:0.7, S:0.8, M:5, C:0.65,
  G:-1, Q:0.5, E:0.6, D:0.7 });
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

class VirtualPlayer {
  constructor(params = {}, initialBit = 0) {
    this.p = { ...VP_DEFAULTS, ...params };
    for (const name of ['I','S','C','Q','E','D']) {
      if (!Number.isFinite(this.p[name]) || this.p[name] < 0 || this.p[name] > 1)
        throw new Error('Некорректный параметр '+name);
    }
    if (!Number.isInteger(this.p.M) || this.p.M < 1 || this.p.M > 20)
      throw new Error('M должно быть в пределах 1–20');
    if (!Number.isFinite(this.p.G) || this.p.G < -1 || this.p.G > 1)
      throw new Error('G должно быть в пределах −1…+1');
    if (!validBit(initialBit)) throw new Error('Начальный бит должен быть 0 или 1');
    this.initialBit = initialBit;
    this.allTurns = 0;
    this.sessionIndex = -1;
    this.beginSession(initialBit);
  }
  beginSession(initialBit = this.initialBit) {
    if (!validBit(initialBit)) throw new Error('Начальный бит должен быть 0 или 1');
    if (this.pending) throw new Error('Нельзя начать сессию с незавершённым ходом');
    this.sessionIndex++;
    this.session = [];
    this.lastBit = null;
    this.runLength = 0;
    this.V = 0;
    this.A = 0;
    this.pending = null;
    this.firstBit = initialBit;
  }
  recentRepeats() {
    const transitions = this.session.filter(row => row.prevBit !== null).slice(-this.p.M);
    if (!transitions.length) return 0.5;
    return transitions.filter(row => row.bit === row.prevBit).length / transitions.length;
  }
  // Различает нули/единицы и длину серии, но допускает осторожный перенос
  // сведений между похожими контекстами. Доступны только прошлые прогнозы.
  estimateContinuation(k, bit) {
    if (bit === null) return 0.5;
    const recent = this.session.slice(-this.p.M);
    let weight = 0, votes = 0;
    recent.forEach((row, index) => {
      if (row.prevBit === null) return;
      const bitSimilarity = row.prevBit === bit ? 1 : 0.15;
      const lenSimilarity = 1 / (1 + Math.abs(Math.min(row.runBefore, 5) - Math.min(k, 5)));
      const recency = 0.5 + 0.5 * (index + 1) / recent.length;
      const w = bitSimilarity * lenSimilarity * recency;
      votes += w * Number(row.guess === row.prevBit);
      weight += w;
    });
    return (0.5 + votes) / (1 + weight);
  }
  // Частые успешные угадывания компьютера вызывают попытку временно уйти
  // в чередование. Оценка намеренно ограничена последними 3–5 эпизодами.
  perceivedThreat() {
    const recent = this.session.slice(-Math.min(this.p.M, 5));
    if (!recent.length) return 0;
    let sum=0, denominator=0;
    recent.forEach((r,index) => {
      const w = 0.5 + 0.5*(index+1)/recent.length;
      sum += w*Number(r.hit);
      denominator += w;
    });
    const hitRate=sum/denominator;
    return clamp((hitRate-0.45)/0.45,0,1)*Math.max(0,-this.p.G);
  }
  // Познавательный интерес относится к тому, какой вариант реже
  // ПРОБОВАЛИ в подобном контексте; он не дублирует долю повторений f.
  exploreNovelty(k, bit) {
    if (bit === null) return 0;
    let continued=0, switched=0;
    for (const row of this.session.slice(-this.p.M)) {
      if (row.prevBit === null) continue;
      const w=(row.prevBit===bit ? 1 : 0.2) /
        (1+Math.abs(Math.min(k,4)-Math.min(row.runBefore,4)));
      if (row.bit===row.prevBit) continued+=w;
      else switched+=w;
    }
    // Положительное значение означает «продолжение уже исследовали чаще».
    return (continued-switched)/(1+continued+switched);
  }
  choose() {
    if (this.pending) throw new Error('Нужно завершить предыдущий ход игрока');
    const p=this.p, k=this.runLength, f=this.recentRepeats();
    const q=this.estimateContinuation(k,this.lastBit);
    const threat=this.perceivedThreat();
    const Cbase=clamp(p.C*(1+0.5*this.A-0.25*Math.abs(this.V)),0,1);
    const agency=Cbase===0 ? 0 : Cbase/(Cbase+0.15);
    const oppose=Math.max(0,-p.G);
    // Если компьютер, как кажется игроку, ждёт окончания серии,
    // сознательный контроль временно снижает насыщение (возможны 4+).
    const prolong=oppose*agency*(1-q);
    // Частые попадания компьютера усиливают импульс переключения:
    // возможно короткое чередование вместо привычных серий.
    const Ieff=clamp(p.I+0.30*this.V-0.28*this.A-0.95*threat*agency+
      0.18*prolong,0,1);
    const Seff=clamp(p.S*(1+0.35*this.A+0.65*threat*agency-
      1.15*prolong-0.15*this.V),0.06,1);
    const novelty=this.exploreNovelty(k,this.lastBit);
    const automatic=this.lastBit===null ? 0 :
      2*Ieff-2*Seff*(k-1)+0.4*p.S*(1-2*f);
    const reflexive=this.lastBit===null ? 0 :
      2.5*agency*p.G*(2*q-1);
    const exploration=this.lastBit===null ? 0 :
      -1.8*agency*p.Q*novelty;
    const alternation=this.lastBit===null ? 0 :
      -0.95*threat*agency*(k===1 ? 1 : 0.35);
    const impulse=automatic+reflexive+exploration+alternation;
    const bit=this.lastBit===null ? this.firstBit :
      (impulse>=0 ? this.lastBit : 1-this.lastBit);
    const pExpectedBit1=this.lastBit===null ? 0.5 :
      this.lastBit===1 ? q : 1-q;
    this.pending={
      bit, prevBit:this.lastBit, runBefore:k, f, q,
      Ieff, Seff, Ceff:Cbase, agency, threat, prolong, novelty,
      automatic, reflexive, exploration, alternation, impulse,
      Vbefore:this.V, Abefore:this.A, pExpectedBit1,
    };
    return {...this.pending};
  }
  feedback(guess) {
    if (!this.pending || !validBit(guess)) throw new Error('Нет ожидающего подтверждения хода');
    const d=this.pending;
    const hit=guess===d.bit;
    const rGoal=this.p.G*(2*Number(hit)-1);
    const rInsight=clamp(1-4*(d.pExpectedBit1-guess)**2,-1,1);
    const reward=(1-this.p.Q)*rGoal+this.p.Q*rInsight;
    const past=this.session.slice(-this.p.M);
    const expected=past.length ? past.reduce((sum,r)=>sum+r.reward,0)/past.length : 0;
    if (this.p.E===0) {this.V=0; this.A=0;}
    else {
      this.V=clamp(this.p.D*this.V+(1-this.p.D)*this.p.E*reward,-1,1);
      this.A=clamp(this.p.D*this.A+(1-this.p.D)*this.p.E*Math.abs(reward-expected),0,1);
    }
    this.runLength=d.prevBit===d.bit ? this.runLength+1 : 1;
    this.lastBit=d.bit;
    const record={...d, guess, hit, reward, rGoal, rInsight,
      Vafter:this.V, Aafter:this.A, runAfter:this.runLength,
      session:this.sessionIndex};
    this.session.push(record);
    if (this.session.length>this.p.M) this.session.shift();
    this.pending=null;
    this.allTurns++;
    return record;
  }
  snapshot() {
    return {V:this.V,A:this.A,runLength:this.runLength,
      lastBit:this.lastBit,session:this.sessionIndex,recent:this.session.slice()};
  }
}


export { VirtualPlayer, VP_DEFAULTS };
