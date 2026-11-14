export function eraseParticipant(service, id) {
  const db = service.repository;
  return db.transaction(() => {
    const users = db.all('SELECT telegram_id FROM telegram_users WHERE participant_id=?', id);
    for (const user of users) {
      db.run('DELETE FROM telegram_prompts WHERE telegram_id=?', user.telegram_id);
      db.run('DELETE FROM web_link_requests WHERE telegram_id=?', user.telegram_id);
      db.run("UPDATE telegram_updates SET user_id=NULL,payload_hash=NULL,actions_json='[]',next_action=0,done=1 WHERE user_id=?", user.telegram_id);
    }
    for (const table of ['telegram_deliveries', 'turn_training_snapshots', 'turn_channels']) {
      db.run('DELETE FROM ' + table + ' WHERE turn_id IN (SELECT id FROM turns WHERE participant_id=?)', id);
    }
    for (const table of ['history_imports', 'receipts', 'recovery_audit', 'predictor_snapshots', 'turns', 'sessions', 'telegram_users']) {
      db.run('DELETE FROM ' + table + ' WHERE participant_id=?', id);
    }
    db.run('DELETE FROM participants WHERE id=?', id);
  });
}

export function exportParticipant(service, id) {
  const db = service.repository;
  const pending = service.getProgress(id).pendingTurn;
  if (pending?.visibility === 'blind') throw new Error('PENDING_BLIND_EXPORT');
  return {
    format: 'GuessGameParticipantExport', version: 2, exportedAt: Date.now(), participantId: id,
    state: service.getState(id),
    webConsent: db.get('SELECT username,consent_text,consent_at FROM web_accounts WHERE participant_id=?', id) ?? null,
    sessions: db.all('SELECT * FROM sessions WHERE participant_id=? ORDER BY started_at,id', id),
    turns: db.all('SELECT * FROM turns WHERE participant_id=? ORDER BY seq', id),
    channels: db.all('SELECT c.* FROM turn_channels c JOIN turns t ON t.id=c.turn_id WHERE t.participant_id=?', id),
    historyImport: db.get('SELECT imported_at,source,source_checksum,result_json FROM history_imports WHERE participant_id=?', id) ?? null,
    replayTraining: db.all('SELECT s.* FROM turn_training_snapshots s JOIN turns t ON t.id=s.turn_id WHERE t.participant_id=? ORDER BY t.seq', id),
    deliveries: db.all('SELECT d.* FROM telegram_deliveries d JOIN turns t ON t.id=d.turn_id WHERE t.participant_id=?', id),
  };
}
