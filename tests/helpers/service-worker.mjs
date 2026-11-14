import { parentPort, workerData } from 'node:worker_threads';
import { GameService } from '../../src/service/game-service.mjs';
const service = new GameService(workerData.file);
if (workerData.crash) {
  service.repository.transaction(() => {
    service.repository.run('UPDATE turns SET actual_bit=1, answered_at=1 WHERE id=?', workerData.turnId);
    service.repository.run('UPDATE participants SET revision=1 WHERE id=?', 'alice');
    // Exit without reaching COMMIT or the JavaScript rollback handler.
    process.exit(23);
  });
} else {
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000);
  try {
    const result = service[workerData.operation || 'answer']('alice', workerData.input);
    parentPort.postMessage({ result });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { service.close(); }
}
