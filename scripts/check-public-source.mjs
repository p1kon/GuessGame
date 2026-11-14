import { execFileSync } from 'node:child_process';
const git = args => {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { console.error('PUBLIC_CHECK_GIT_READ_FAILED'); process.exit(1); }
};
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
const issues = [];
for (const file of files) {
  if (file !== '.env.example' && (/(^|\/)(private|\.env|\.ssh)(\/|$)/i.test(file) ||
    /\.(sqlite.*|db(?:-.*)?|pem|key|p12|pfx)$/i.test(file) || /(^|\/)(id_ed25519|id_rsa)(\.|$)/i.test(file) ||
    /guessGameState.*\.json$/i.test(file))) { issues.push(file); continue; }
  const source = git(['show', ':' + file]);
  if (/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\b\d{8,16}:[A-Za-z0-9_-]{30,}\b|gh[pousr]_[A-Za-z0-9]{30,}/.test(source)) issues.push(file);
  if (file.endsWith('.json')) {
    try {
      const data = JSON.parse(source);
      if (Array.isArray(data.history) && data.history.length &&
          !(data.format === 'GuessGameSyntheticFixture' && data.source === 'simulated')) issues.push(file);
    } catch { /* Other checks validate the syntax of application JSON. */ }
  }
}
const objects = git(['rev-list', '--objects', '--all']);
if (/guessGameState[^\r\n]*\.json/i.test(objects)) issues.push('reachable-history-contains-private-state');
if (issues.length) {
  console.error('PUBLICATION_BLOCKED: ' + [...new Set(issues)].join(', ')); process.exitCode = 1;
} else console.log('PUBLIC_SOURCE_CHECK_OK (' + files.length + ' files)');
