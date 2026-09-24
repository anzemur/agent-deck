// Builds media/seti-map.json + copies media/seti.woff from an installed VS Code / Cursor.
// The Seti icon theme ships with VS Code (MIT). Run: node scripts/build-icons.js [path-to-app-resources]
const fs = require('fs');
const path = require('path');

const app = process.argv[2] || '/Applications/Cursor.app/Contents/Resources/app';
const themeDir = path.join(app, 'extensions/theme-seti/icons');
const theme = JSON.parse(fs.readFileSync(path.join(themeDir, 'vs-seti-icon-theme.json'), 'utf8'));
const defs = theme.iconDefinitions;

// languageId -> file extensions / names, from the built-in language extensions.
const langExts = {}, langNames = {};
for (const dir of fs.readdirSync(path.join(app, 'extensions'))) {
  const pj = path.join(app, 'extensions', dir, 'package.json');
  if (!fs.existsSync(pj)) continue;
  for (const l of JSON.parse(fs.readFileSync(pj, 'utf8')).contributes?.languages ?? []) {
    for (const e of l.extensions ?? []) (langExts[l.id] ??= []).push(e.replace(/^\./, '').toLowerCase());
    for (const n of l.filenames ?? []) (langNames[l.id] ??= []).push(n.toLowerCase());
  }
}

const glyph = (id, light) => {
  const d = defs[id];
  const l = light && defs[light];
  if (!d) return undefined;
  return [d.fontCharacter.replace('\\', ''), d.fontColor, l ? l.fontColor : d.fontColor];
};
const out = { default: glyph(theme.file, theme.light?.file), ext: {}, name: {} };
const lt = theme.light ?? {};
// Precedence in the icon theme: file names > extensions > language ids.
for (const [lang, id] of Object.entries(theme.languageIds ?? {})) {
  for (const e of langExts[lang] ?? []) out.ext[e] = glyph(id, lt.languageIds?.[lang]);
  for (const n of langNames[lang] ?? []) out.name[n] = glyph(id, lt.languageIds?.[lang]);
}
for (const [e, id] of Object.entries(theme.fileExtensions ?? {})) out.ext[e.toLowerCase()] = glyph(id, lt.fileExtensions?.[e]);
for (const [n, id] of Object.entries(theme.fileNames ?? {})) out.name[n.toLowerCase()] = glyph(id, lt.fileNames?.[n]);

fs.writeFileSync(path.join(__dirname, '../media/seti-map.json'), JSON.stringify(out));
fs.copyFileSync(path.join(themeDir, 'seti.woff'), path.join(__dirname, '../media/seti.woff'));
console.log(`seti-map.json: ${Object.keys(out.ext).length} extensions, ${Object.keys(out.name).length} file names`);
