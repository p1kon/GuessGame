import { GameService } from '../src/service/game-service.mjs';
const game = new GameService(process.env.TELEGRAM_DB_PATH || 'private/telegram.sqlite');
try {
  let turns = 0;
  for (const participant of game.repository.all('SELECT id FROM participants')) {
    const saved = game.getState(participant.id);
    if (JSON.stringify(saved) !== JSON.stringify(game.replayEngine(participant.id).exportState())) throw new Error('REPLAY_MISMATCH');
    turns += saved.total;
  }
  console.log(JSON.stringify({ verified: true, totalTurns: turns }));
} finally { game.close(); }
