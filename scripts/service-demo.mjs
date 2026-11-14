import { GameService } from '../src/service/game-service.mjs';

// Disposable demonstration only; no real identities, network or persistent DB.
const service = new GameService(':memory:');
try {
  service.createParticipant({ id: 'demo-a', source: 'simulated' });
  service.createParticipant({ id: 'demo-b', source: 'simulated' });
  const session = service.startSession('demo-a', { requestId: 'session-1', visibility: 'blind' });
  const prediction = service.predict('demo-a', { sessionId: session.id, requestId: 'prediction-1' });
  console.log('Blind prediction committed:', prediction.prediction === null);
  const input = { turnId: prediction.id, bit: 1, requestId: 'answer-1' };
  const result = service.answer('demo-a', input);
  const repeat = service.answer('demo-a', input);
  console.log('Repeated answer returns same result:', JSON.stringify(result) === JSON.stringify(repeat));
  console.log('Player A:', service.getProgress('demo-a'));
  console.log('Player B:', service.getProgress('demo-b'));
} finally { service.close(); }
