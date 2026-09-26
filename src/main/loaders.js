const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { downloadFile, existsFull } = require('./mc-core');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const FORGE_META = 'https://files.minecraftforge.net/net/minecraftforge/forge';

let forgeMetaCache = null;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Loader version lists, newest first: [{ version, recommended? }]
async function getLoaderVersions(loader, gameVersion) {
  if (loader === 'fabric') {
    const list = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`);
    return list.map(e => ({ version: e.loader.version }));
  }
  if (loader === 'quilt') {
    const list = await fetchJson(`${QUILT_META}/versions/loader/${encodeURIComponent(gameVersion)}`);
    return list.map(e => ({ version: e.loader.version }));
  }
  if (loader === 'forge') {
    if (!forgeMetaCache) forgeMetaCache = fetchJson(`${FORGE_META}/maven-metadata.json`);
    const [all, promos] = await Promise.all([
      forgeMetaCache,
      fetchJson(`${FORGE_META}/promotions_slim.json`).catch(() => ({ promos: {} })),
    ]);
    const versions = all[gameVersion] || [];
    const recommended = promos.promos?.[`${gameVersion}-recommended`];
    return versions.slice().reverse().map(v => ({
      version: v.startsWith(`${gameVersion}-`) ? v.slice(gameVersion.length + 1) : v,
      recommended: v.endsWith(recommended) || undefined,
    }));
  }
  throw new Error('Unknown loader: ' + loader);
}

async function writeVersionJson(gameDir, id, json) {
  const dir = path.join(gameDir, 'versions', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(json, null, 2));
}

// Fabric/Quilt: fetch the loader profile json and attach it to the vanilla version.
async function installFabricLike(gameDir, loader, gameVersion, loaderVersion) {
  const base = loader === 'fabric' ? FABRIC_META : QUILT_META;
  const profile = await fetchJson(
    `${base}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  profile.inheritsFrom = gameVersion;
  const id = profile.id || `${loader}-loader-${loaderVersion}-${gameVersion}`;
  profile.id = id;
  await writeVersionJson(gameDir, id, profile);
  return id;
}

function runInstaller(javaPath, args, onLog) {
  return new Promise(resolve => {
    const child = spawn(javaPath, args, { windowsHide: true });
    let output = '';
    const onData = d => { output += d; onLog?.(d.toString()); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => resolve({ code: -1, output: output + '\n' + err.message }));
    child.on('exit', code => resolve({ code, output }));
  });
}

async function findForgeJson(gameDir, gameVersion, forgeVersion) {
  const candidates = [
    `${gameVersion}-forge-${forgeVersion}`,
    `forge-${forgeVersion}`,
    `${gameVersion}-forge${forgeVersion}`,
  ];
  for (const id of candidates) {
    if (await existsFull(path.join(gameDir, 'versions', id, `${id}.json`))) return id;
  }
  // Legacy installers use irregular ids; scan for a json that references this forge version.
  const versionsDir = path.join(gameDir, 'versions');
  try {
    for (const e of await fsp.readdir(versionsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.includes(forgeVersion)) continue;
      const file = path.join(versionsDir, e.name, `${e.name}.json`);
      try {
        const json = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (json.inheritsFrom === gameVersion || json.jar === gameVersion) return json.id || e.name;
      } catch {}
    }
  } catch {}
  return null;
}

// Forge: run the official installer unless the version is already present.
async function installForge(gameDir, gameVersion, forgeVersion, javaPath, onLog) {
  const existing = await findForgeJson(gameDir, gameVersion, forgeVersion);
  if (existing) {
    onLog?.(`[launcher] Using existing Forge install: ${existing}\n`);
    return existing;
  }

  const installerUrl = `${FORGE_MAVEN}/net/minecraftforge/forge/${gameVersion}-${forgeVersion}/forge-${gameVersion}-${forgeVersion}-installer.jar`;
  const installerPath = path.join(gameDir, 'forge-installers', `forge-${gameVersion}-${forgeVersion}-installer.jar`);
  onLog?.(`[launcher] Downloading Forge installer ${gameVersion}-${forgeVersion}...\n`);
  await downloadFile(installerUrl, installerPath);

  onLog?.('[launcher] Running Forge installer (this can take a few minutes)...\n');
  const { code, output } = await runInstaller(javaPath, ['-jar', installerPath, '--installClient', gameDir], onLog);
  if (code !== 0) {
    throw new Error(`Forge installer failed (code ${code}):\n${output.slice(-1500)}`);
  }

  const id = await findForgeJson(gameDir, gameVersion, forgeVersion);
  if (!id) throw new Error('Forge installer finished but no version json was found.');
  return id;
}

// Returns the version id to launch for the given loader selection.
async function ensureLoader(gameDir, loader, gameVersion, loaderVersion, javaPath, onLog) {
  if (!loader || loader === 'vanilla') return gameVersion;
  if (loader === 'fabric' || loader === 'quilt') {
    return installFabricLike(gameDir, loader, gameVersion, loaderVersion);
  }
  if (loader === 'forge') {
    return installForge(gameDir, gameVersion, loaderVersion, javaPath, onLog);
  }
  throw new Error('Unknown loader: ' + loader);
}

// Deterministic id for a loader selection, resolved from disk for Forge.
async function resolveInstanceId(gameDir, loader, gameVersion, loaderVersion) {
  if (!loader || loader === 'vanilla') return gameVersion;
  if (loader === 'forge') {
    return (await findForgeJson(gameDir, gameVersion, loaderVersion)) || `${gameVersion}-forge-${loaderVersion}`;
  }
  return `${loader}-loader-${loaderVersion}-${gameVersion}`;
}

module.exports = { getLoaderVersions, ensureLoader, resolveInstanceId };
