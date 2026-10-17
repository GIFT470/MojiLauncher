const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// FPS-focused options merged into the instance's options.txt on each launch.
// Render distance and simulation distance are deliberately left alone: they are
// the biggest FPS lever, but also the most visible gameplay choice.
const BASE_OPTIONS = {
  fancyGraphics: 'false',      // key used before 1.16
  graphicsMode: '0',           // fast graphics, 1.16–1.21.10
  graphicsPreset: '"custom"',  // 1.21.11+; keeps the individual choices below
  particles: '2',              // minimal
  entityShadows: 'false',
  enableVsync: 'false',
  maxFps: '260',
  biomeBlendRadius: '0',
};

// Curated, widely-compatible performance mods per loader. Fabric mods run on
// Quilt, so Quilt queries Fabric builds. Forge uses the Embeddium equivalent.
const PERF_MODS = {
  fabric: ['sodium', 'lithium', 'krypton', 'ferrite-core'],
  quilt: ['sodium', 'lithium', 'krypton', 'ferrite-core'],
  forge: ['embeddium', 'ferrite-core'],
};

// Jar filenames vary between mods/versions, so detect an existing install by
// the distinctive part of each mod's name rather than an exact filename.
const PERF_MOD_PATTERNS = {
  sodium: /sodium.*\.jar$/i,
  lithium: /lithium.*\.jar$/i,
  krypton: /krypton.*\.jar$/i,
  'ferrite-core': /ferritecore.*\.jar$/i,
  embeddium: /embeddium.*\.jar$/i,
};

function parseVersion(versionId) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(versionId || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

// Unknown/future version schemes (snapshots) are treated as modern.
function atLeast(version, major, minor, patch = 0) {
  if (!version) return true;
  if (version[0] !== major) return version[0] > major;
  if (version[1] !== minor) return version[1] > minor;
  return version[2] >= patch;
}

function setLine(lines, key, value) {
  const idx = lines.findIndex(l => l.startsWith(`${key}:`));
  const line = `${key}:${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
}

async function applyGameSettings(instanceDir, versionId) {
  try {
    const file = path.join(instanceDir, 'options.txt');
    let text = '';
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {}
    const lines = text ? text.split(/\r?\n/) : [];
    const version = parseVersion(versionId);

    // Match the format the game itself uses for this instance so the values
    // aren't silently ignored: ao is numeric before 1.13, and renderClouds is
    // quoted on 1.21.2+. An existing file is the best signal; version is the
    // fallback when this is the first launch.
    const aoBoolean = /^ao:(true|false)\s*$/m.test(text) ||
      (!/^ao:\d+/m.test(text) && atLeast(version, 1, 13));
    const cloudsQuoted = /^renderClouds:"/m.test(text) ||
      (!/^renderClouds:/m.test(text) && atLeast(version, 1, 21, 2));

    const options = {
      ...BASE_OPTIONS,
      ao: aoBoolean ? 'false' : '0',
      renderClouds: cloudsQuoted ? '"false"' : 'false',
    };
    for (const [key, value] of Object.entries(options)) setLine(lines, key, value);
    await fsp.writeFile(file, lines.join('\n'));
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: err.message || String(err) };
  }
}

async function listMods(instanceDir) {
  try {
    return await fsp.readdir(path.join(instanceDir, 'mods'));
  } catch {
    return [];
  }
}

async function hasPerfMod(instanceDir, slug) {
  const pattern = PERF_MOD_PATTERNS[slug];
  if (!pattern) return false;
  return (await listMods(instanceDir)).some(f => pattern.test(f));
}

async function hasOptiFine(instanceDir) {
  return (await listMods(instanceDir)).some(f => /optifine|optifabric/i.test(f));
}

module.exports = { PERF_MODS, PERF_MOD_PATTERNS, applyGameSettings, hasPerfMod, hasOptiFine };
