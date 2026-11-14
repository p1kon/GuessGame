'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
// Only our one-line static imports and export lists are removed. Module bodies
// remain identical in Node and in the single classic browser script.
const modules = ['src/core/predictor.mjs', 'src/core/virtual-player.mjs',
  'src/core/simulation.mjs'];
const code = modules.map(file => read(file)
  .replace(/^import .*;\n/gm, '').replace(/^export \{[^\n]*\};\n/gm, ''))
  .concat(read('src/browser/app.js')).join('\n');
const template = read('src/browser/template.html');
const marker = '/* GUESSGAME_BUNDLE */';
if (template.split(marker).length !== 2) throw new Error('Expected one bundle marker');
const output = template.replace(marker, () => code);
const directory = path.join(root, 'dist');
fs.mkdirSync(directory, { recursive: true });
const file = 'GuessGame_next.html';
fs.writeFileSync(path.join(directory, file), output);
fs.writeFileSync(path.join(directory, 'checksums.json'), JSON.stringify({
  build: 'modular-preview-1', algorithm: '2.3.2',
  files: { [file]: crypto.createHash('sha256').update(output).digest('hex') },
}, null, 2) + '\n');
console.log('Built dist/' + file);
