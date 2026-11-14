export const CHECKPOINT_INTERVAL = 100;
export const PERIODIC_CHECKPOINTS = 2;

export function pruneSnapshots(repository, participantId, revision) {
  if (repository.get('SELECT revision FROM predictor_snapshots WHERE participant_id=? AND revision>? LIMIT 1', participantId, revision)) {
    throw new Error('SNAPSHOT_AHEAD_OF_STATE');
  }
  const base = repository.get("SELECT json_extract(initial_json,'$.total') AS revision FROM participants WHERE id=?", participantId).revision;
  const periodic = repository.all('SELECT revision FROM predictor_snapshots WHERE participant_id=? AND revision>0 AND revision>=? AND revision%?=0 ORDER BY revision DESC LIMIT ?',
    participantId, base, CHECKPOINT_INTERVAL, PERIODIC_CHECKPOINTS).map(row => row.revision);
  const keep = [...new Set([0, revision, Math.max(0, revision - 1), ...periodic])];
  repository.run('DELETE FROM predictor_snapshots WHERE participant_id=? AND revision NOT IN (' + keep.map(() => '?').join(',') + ')', participantId, ...keep);
}

export function snapshotMetrics(repository) {
  const row = repository.get('SELECT count(*) AS snapshots,coalesce(sum(length(CAST(state_json AS BLOB))),0) AS payloadBytes FROM predictor_snapshots');
  return { snapshots: row.snapshots, payloadBytes: row.payloadBytes };
}
