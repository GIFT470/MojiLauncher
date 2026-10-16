const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Offline Minecraft has no account skin server, so the player is rendered with
// one of the game's built-in default skins. To force a chosen skin we ship a
// resource pack that overrides EVERY default player texture, so no matter which
// default (or slim/wide model) the offline profile picks, it shows our skin.
//   - <=1.21.3 : assets/minecraft/textures/entity/{steve,alex}.png
//   - >=1.21.4 : assets/minecraft/textures/entity/player/{wide,slim}/<name>.png
const LEGACY_TARGETS = [
  'assets/minecraft/textures/entity/steve.png',
  'assets/minecraft/textures/entity/alex.png',
];
const DEFAULT_NAMES = ['steve', 'alex', 'kai', 'noor', 'sunny', 'zuri', 'ari', 'efe', 'makena'];
const MODERN_TARGETS = ['wide', 'slim'].flatMap(model =>
  DEFAULT_NAMES.map(n => `assets/minecraft/textures/entity/player/${model}/${n}.png`));
const TEXTURE_TARGETS = [...LEGACY_TARGETS, ...MODERN_TARGETS];

const PACK_NAME = 'MojiSkin';
const PACK_ID = `file/${PACK_NAME}`;

// Per-player route (multiplayer "only I see it"): CustomSkinLoader reads
// <gameDir>/CustomSkinLoader/LocalSkin/skins/<USERNAME>.png and applies it ONLY
// to that username; every other player falls back to their normal skin. Our
// gameDir is the per-instance folder, so the file lands inside the instance.
function perUserSkinPath(instanceDir, username) {
  return path.join(instanceDir, 'CustomSkinLoader', 'LocalSkin', 'skins', `${username}.png`);
}

async function applyPerUserSkin(instanceDir, username, srcAbs) {
  const dest = perUserSkinPath(instanceDir, username);
  if (!srcAbs) {
    await fsp.rm(dest, { force: true });
    return { applied: false };
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(srcAbs, dest);
  return { applied: true };
}

function skinsDir(gameDir) {
  return path.join(gameDir, 'skins');
}

async function ensureSkinsDir(gameDir) {
  const dir = skinsDir(gameDir);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function listSkins(gameDir) {
  const dir = await ensureSkinsDir(gameDir);
  const entries = await fsp.readdir(dir);
  return entries
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// options.txt is a flat "key:value" file the game reads at startup and rewrites
// on exit. We only touch the two keys we need and preserve everything else.
function setLine(lines, key, value) {
  const idx = lines.findIndex(l => l.startsWith(`${key}:`));
  const line = `${key}:${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines;
}

function setResourcePacks(lines, add) {
  const idx = lines.findIndex(l => l.startsWith('resourcePacks:'));
  let arr = [];
  if (idx >= 0) {
    try {
      const parsed = JSON.parse(lines[idx].slice('resourcePacks:'.length));
      if (Array.isArray(parsed)) arr = parsed.filter(x => typeof x === 'string');
    } catch {}
  }
  arr = arr.filter(x => x !== PACK_ID);
  if (add) arr.push(PACK_ID);
  return setLine(lines, 'resourcePacks', JSON.stringify(arr));
}

async function readOptionsLines(instanceDir) {
  try {
    const text = await fsp.readFile(path.join(instanceDir, 'options.txt'), 'utf8');
    return text.split(/\r?\n/);
  } catch {
    return [];
  }
}

async function writeOptions(instanceDir, lines) {
  await fsp.writeFile(path.join(instanceDir, 'options.txt'), lines.join('\n'));
}

async function removePack(instanceDir) {
  await fsp.rm(path.join(instanceDir, 'resourcepacks', PACK_NAME), { recursive: true, force: true });
  const lines = await readOptionsLines(instanceDir);
  if (!lines.length) return;
  await writeOptions(instanceDir, setResourcePacks(lines, false));
}

// Builds (or removes) the forced skin pack inside an instance right before launch.
// Returns { applied, reason? } for logging. Never throws — a skin problem must
// not block launching the game.
async function applySkinPack(gameDir, instanceDir, skinFile) {
  try {
    if (!skinFile) {
      await removePack(instanceDir);
      return { applied: false };
    }
    const src = path.join(skinsDir(gameDir), skinFile);
    if (!fs.existsSync(src)) {
      await removePack(instanceDir);
      return { applied: false, reason: 'skin file missing' };
    }

    const packDir = path.join(instanceDir, 'resourcepacks', PACK_NAME);
    await fsp.rm(packDir, { recursive: true, force: true });
    await fsp.mkdir(packDir, { recursive: true });
    await fsp.writeFile(
      path.join(packDir, 'pack.mcmeta'),
      JSON.stringify({ pack: { pack_format: 15, description: `Moji skin: ${skinFile}` } }));

    const buf = await fsp.readFile(src);
    for (const rel of TEXTURE_TARGETS) {
      const dest = path.join(packDir, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
    }

    let lines = await readOptionsLines(instanceDir);
    lines = setResourcePacks(lines, true);
    lines = setLine(lines, 'incompatibleResourcePacks', 'true');
    await writeOptions(instanceDir, lines);

    return { applied: true };
  } catch (err) {
    return { applied: false, reason: err.message || String(err) };
  }
}

module.exports = { skinsDir, ensureSkinsDir, listSkins, applySkinPack, applyPerUserSkin, perUserSkinPath, TEXTURE_TARGETS, PACK_ID };
