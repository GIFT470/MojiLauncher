const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');

const META = 'https://piston-meta.mojang.com';
const RESOURCES = 'https://resources.download.minecraft.net';
const LIBRARIES = 'https://libraries.minecraft.net';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// Parallel ranged chunks for big files; false when the server can't do ranges.
async function tryParallelChunks(url, tmp, sizeHint) {
  let fh;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const len = Number(head.headers.get('content-length'));
    const size = sizeHint > 0 ? sizeHint : (head.ok && len > 0 ? len : 0);
    if (!size || size < 8 * 1024 * 1024) return false;
    if ((head.headers.get('accept-ranges') || 'none').toLowerCase() === 'none') return false;
    const chunks = Math.min(8, Math.max(2, Math.floor(size / (6 * 1024 * 1024))));
    const step = Math.ceil(size / chunks);
    fh = await fsp.open(tmp, 'w');
    await fh.truncate(size);
    await Promise.all(Array.from({ length: chunks }, async (_, i) => {
      const start = i * step;
      const end = Math.min(size, start + step) - 1;
      if (start > end) return;
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`range request failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fh.write(buf, 0, buf.length, start);
    }));
    await fh.close();
    fh = null;
    const st = await fsp.stat(tmp);
    return st.size === size;
  } catch {
    if (fh) await fh.close().catch(() => {});
    try { await fsp.unlink(tmp); } catch {}
    return false;
  }
}

async function downloadFile(url, dest, { sha1, size, retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const done = await tryParallelChunks(url, tmp, size);
      if (!done) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        await pipeline(res.body, createWriteStream(tmp));
      }
      if (sha1) {
        const actual = await sha1File(tmp);
        if (actual !== sha1) throw new Error(`SHA1 mismatch for ${url}: ${actual}`);
      }
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

async function existsFull(file, expectedSize) {
  try {
    const st = await fsp.stat(file);
    return expectedSize == null || st.size === expectedSize;
  } catch {
    return false;
  }
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function ruleAllows(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName()) matches = false;
      if (rule.os.version && !new RegExp(rule.os.version).test(require('os').release())) matches = false;
      if (rule.os.arch) {
        const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
        if (rule.os.arch !== arch) matches = false;
      }
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== v) matches = false;
      }
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function mavenPath(name, classifier) {
  const parts = name.split(':');
  const [group, artifact, version] = parts;
  const cls = classifier || parts[3];
  const suffix = cls ? `-${cls}` : '';
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${suffix}.jar`;
}

function nativeKey(natives) {
  if (!natives) return null;
  let key = natives[osName()];
  if (!key) return null;
  key = key.replace('${arch}', process.arch === 'x64' ? '64' : '32');
  return key;
}

async function getVersionManifest() {
  return fetchJson(`${META}/mc/game/version_manifest_v2.json`);
}

async function getVersionJson(gameDir, versionId, url) {
  const dir = path.join(gameDir, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  if (!(await existsFull(file))) {
    if (!url) {
      const manifest = await getVersionManifest();
      url = manifest.versions.find(v => v.id === versionId)?.url;
      if (!url) throw new Error(`Unknown version: ${versionId}`);
    }
    const json = await fetchJson(url);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(json));
  }
  const json = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (json.inheritsFrom) {
    const parent = await getVersionJson(gameDir, json.inheritsFrom);
    return mergeVersionJsons(parent, json);
  }
  return json;
}

// Version inheritance per the launcher meta spec: child scalars win,
// libraries and argument lists are appended to the parent's.
function mergeVersionJsons(parent, child) {
  const merged = { ...parent, ...child };
  // A child library replaces parent libraries with the same group:artifact
  // (e.g. Forge's newer log4j). Entries within one list must NOT be collapsed:
  // modern Mojang jsons list the same group:artifact several times (main jar +
  // per-OS natives entries like org.lwjgl:lwjgl-glfw:3.3.3:natives-windows).
  const ga = l => l.name.split(':').slice(0, 2).join(':');
  const childKeys = new Set((child.libraries || []).map(ga));
  merged.libraries = [
    ...(parent.libraries || []).filter(l => !childKeys.has(ga(l))),
    ...(child.libraries || []),
  ];
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }
  return merged;
}

// The client jar comes from the base version when a loader json inherits.
function jarVersionId(vj) {
  return vj.jar || vj.inheritsFrom || vj.id;
}

// Collect every download needed for a version.
function collectDownloads(gameDir, vj) {
  const files = []; // { url, dest, size, sha1 }
  const nativeJars = [];

  const client = vj.downloads.client;
  const jarId = jarVersionId(vj);
  files.push({
    url: client.url,
    dest: path.join(gameDir, 'versions', jarId, `${jarId}.jar`),
    size: client.size,
    sha1: client.sha1,
  });

  for (const lib of vj.libraries || []) {
    if (!ruleAllows(lib.rules)) continue;
    const nKey = nativeKey(lib.natives);
    if (nKey && !lib.downloads?.classifiers?.[nKey]) continue;

    const artifact = lib.downloads?.artifact;
    if (artifact && !nKey) {
      files.push({
        url: artifact.url,
        dest: path.join(gameDir, 'libraries', artifact.path || mavenPath(lib.name)),
        size: artifact.size,
        sha1: artifact.sha1,
      });
    } else if (!nKey) {
      // Libraries without a downloads block: use the library's custom repo url if present.
      const p = lib.path || mavenPath(lib.name);
      const base = lib.url || `${LIBRARIES}/`;
      files.push({ url: base + p, dest: path.join(gameDir, 'libraries', p) });
    }

    if (nKey) {
      const cls = lib.downloads.classifiers[nKey];
      const jar = path.join(gameDir, 'libraries', cls.path || mavenPath(lib.name, nKey));
      files.push({ url: cls.url, dest: jar, size: cls.size, sha1: cls.sha1 });
      nativeJars.push({ jar, extract: lib.extract?.rules || [] });
    }
  }

  if (vj.assetIndex) {
    files.push({
      url: vj.assetIndex.url,
      dest: path.join(gameDir, 'assets', 'indexes', vj.assetIndex.id),
      size: vj.assetIndex.size,
      sha1: vj.assetIndex.sha1,
    });
  }

  if (vj.logging?.client?.file) {
    const lf = vj.logging.client.file;
    files.push({
      url: lf.url,
      dest: path.join(gameDir, 'assets', lf.id),
      size: lf.size,
      sha1: lf.sha1,
    });
  }

  return { files, nativeJars };
}

async function runQueue(items, worker, concurrency, onDone) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
      onDone(items[i], i);
    }
  });
  await Promise.all(runners);
}

// Downloads everything for a version; calls onProgress({phase, current, total, file}).
async function installVersion(gameDir, vj, onProgress) {
  const { files, nativeJars } = collectDownloads(gameDir, vj);

  const pending = [];
  for (const f of files) {
    if (!(await existsFull(f.dest, f.size))) pending.push(f);
  }

  const report = (phase, current, total, file) => onProgress?.({ phase, current, total, file });

  // Asset objects (bulk of the work) are discovered from the asset index.
  let assetTasks = [];
  if (vj.assetIndex) {
    const indexFile = path.join(gameDir, 'assets', 'indexes', vj.assetIndex.id);
    if (await existsFull(indexFile)) {
      const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
      for (const obj of Object.values(index.objects || {})) {
        const dest = path.join(gameDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash);
        if (!(await existsFull(dest, obj.size))) {
          assetTasks.push({ url: `${RESOURCES}/${obj.hash.slice(0, 2)}/${obj.hash}`, dest, size: obj.size, sha1: obj.hash });
        }
      }
    }
  }

  const nonAsset = pending.filter(f => !f.url.startsWith(RESOURCES));
  if (nonAsset.length) {
    let done = 0;
    await runQueue(nonAsset, async f => downloadFile(f.url, f.dest, { sha1: f.sha1, size: f.size }), 48,
      f => report('libraries', ++done, nonAsset.length, path.basename(f.dest)));
  }

  // Re-check asset index now that it may have just been downloaded.
  if (vj.assetIndex && assetTasks.length === 0) {
    const indexFile = path.join(gameDir, 'assets', 'indexes', vj.assetIndex.id);
    if (await existsFull(indexFile)) {
      const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
      for (const obj of Object.values(index.objects || {})) {
        const dest = path.join(gameDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash);
        if (!(await existsFull(dest, obj.size))) {
          assetTasks.push({ url: `${RESOURCES}/${obj.hash.slice(0, 2)}/${obj.hash}`, dest, size: obj.size, sha1: obj.hash });
        }
      }
    }
  }

  if (assetTasks.length) {
    let done = 0;
    await runQueue(assetTasks, async f => downloadFile(f.url, f.dest, { sha1: f.sha1, size: f.size }), 48,
      () => report('assets', ++done, assetTasks.length, ''));
  }

  if (nativeJars.length) {
    await extractNatives(gameDir, vj, nativeJars);
    report('natives', 1, 1, '');
  }
}

async function extractNatives(gameDir, vj, nativeJars) {
  const nativesDir = path.join(gameDir, 'versions', vj.id, `${vj.id}-natives`);
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });

  const { extractZip } = require('./zip');
  for (const { jar, extract } of nativeJars) {
    const skip = extract.filter(r => r.action === 'exclude').flatMap(r => r.include || []);
    await extractZip(jar, nativesDir, skip);
  }
  return nativesDir;
}

function offlineUuid(username) {
  // Same as Java's UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + username, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildClasspath(gameDir, vj) {
  const entries = [];
  for (const lib of vj.libraries || []) {
    if (!ruleAllows(lib.rules)) continue;
    const nKey = nativeKey(lib.natives);
    const artifact = lib.downloads?.artifact;
    let p;
    if (artifact) p = artifact.path || mavenPath(lib.name);
    else if (!nKey) p = lib.path || mavenPath(lib.name);
    if (!p) continue;
    entries.push(path.join(gameDir, 'libraries', p));
  }
  const jarId = jarVersionId(vj);
  entries.push(path.join(gameDir, 'versions', jarId, `${jarId}.jar`));
  return entries.join(path.delimiter);
}

function expandArgs(list, vars, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      out.push(entry.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
    } else if (entry && ruleAllows(entry.rules, features)) {
      const raw = entry.value !== undefined ? entry.value : entry.values;
      if (raw === undefined) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const v of values) out.push(v.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
    }
  }
  return out;
}

// Builds the full java command line for a launch.
function buildLaunchArgs(gameDir, vj, opts) {
  const { username, ramMb, width, height, nativesDir, gameDirectory } = opts;
  const uuid = offlineUuid(username);
  const assetsRoot = path.join(gameDir, 'assets');
  const gameDirArg = gameDirectory || gameDir;

  const vars = {
    auth_player_name: username,
    version_name: vj.id,
    game_directory: gameDirArg,
    assets_root: assetsRoot,
    assets_index_name: vj.assetIndex?.id || '',
    auth_uuid: uuid,
    auth_access_token: crypto.randomBytes(16).toString('hex'),
    clientid: '',
    auth_xuid: '0',
    user_type: 'msa',
    version_type: vj.type || 'release',
    natives_directory: nativesDir || '',
    launcher_name: 'Moji Launcher',
    launcher_version: '1.0.0',
    classpath: buildClasspath(gameDir, vj),
    auth_session: '',
    user_properties: '{}',
    resolution_width: width ? String(width) : '',
    resolution_height: height ? String(height) : '',
    game_assets: path.join(assetsRoot, 'virtual', 'legacy'),
  };
  vars.auth_session = `token:${vars.auth_access_token}`;

  const features = { is_demo_mode: false, has_custom_resolution: Boolean(width && height) };

  // GC-tuned flags for smoother frame pacing. UnlockExperimentalVMOptions
  // must precede the experimental G1 flags or the JVM refuses to start.
  const jvmArgs = [
    `-Xmx${ramMb}M`, `-Xms${Math.min(ramMb, 2048)}M`,
    '-XX:+UseG1GC',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50',
    '-XX:G1HeapRegionSize=32M',
    '-XX:+ParallelRefProcEnabled',
    '-XX:+DisableExplicitGC',
    '-Djava.net.preferIPv4Stack=true',
  ];

  if (vj.arguments?.jvm) {
    jvmArgs.push(...expandArgs(vj.arguments.jvm, vars, features));
  } else {
    jvmArgs.push(...expandArgs([
      '-Djava.library.path=${natives_directory}',
      '-Dminecraft.launcher.brand=${launcher_name}',
      '-Dminecraft.launcher.version=${launcher_version}',
      '-cp', '${classpath}',
    ], vars, features));
  }

  if (vj.logging?.client?.argument && vj.logging?.client?.file) {
    const logPath = path.join(gameDir, 'assets', vj.logging.client.file.id);
    jvmArgs.push(vj.logging.client.argument.replace('${path}', logPath));
  }

  const gameArgs = vj.arguments?.game
    ? expandArgs(vj.arguments.game, vars, features)
    : (vj.minecraftArguments || '').split(/\s+/).filter(Boolean).map(a =>
        a.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? ''));

  // Legacy jsons lack the resolution rule args; modern ones expand them above.
  if (width && height && !vj.arguments?.game) gameArgs.push('--width', String(width), '--height', String(height));

  return [...jvmArgs, vj.mainClass, ...gameArgs];
}

module.exports = {
  getVersionManifest,
  getVersionJson,
  installVersion,
  buildLaunchArgs,
  buildClasspath,
  offlineUuid,
  downloadFile,
  existsFull,
  META,
};
