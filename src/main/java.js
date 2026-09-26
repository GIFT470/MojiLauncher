const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { downloadFile, existsFull } = require('./mc-core');
const { extractZip } = require('./zip');

const CANDIDATE_ROOTS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files (x86)\\Java',
];

function exec(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '') + (stderr || '') });
    });
  });
}

// Parses `java -version` output into a major version number (8, 17, 21...).
function parseJavaVersion(output) {
  const m = output.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

async function probe(javaExe) {
  try {
    if (!(await existsFull(javaExe))) return null;
    const { err, stdout } = await exec(javaExe, ['-version']);
    if (err) return null;
    const major = parseJavaVersion(stdout);
    return major ? { path: javaExe, major } : null;
  } catch {
    return null;
  }
}

async function findInstalledJavas(gameDir) {
  const found = [];
  const seen = new Set();
  const add = async p => {
    if (!p || seen.has(p.toLowerCase())) return;
    seen.add(p.toLowerCase());
    const info = await probe(p);
    if (info) found.push(info);
  };

  if (process.env.JAVA_HOME) await add(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  await add('C:\\Windows\\System32\\java.exe');

  const runtimeDir = path.join(gameDir, 'runtimes');
  try {
    for (const e of await fsp.readdir(runtimeDir, { withFileTypes: true })) {
      if (e.isDirectory()) await add(path.join(runtimeDir, e.name, 'bin', 'java.exe'));
    }
  } catch {}

  for (const root of CANDIDATE_ROOTS) {
    try {
      for (const e of await fsp.readdir(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const direct = path.join(root, e.name, 'bin', 'java.exe');
        if (fs.existsSync(direct)) await add(direct);
        else {
          // e.g. "jdk-17.0.9+9" nested folders under Adoptium
          try {
            for (const sub of await fsp.readdir(path.join(root, e.name))) {
              await add(path.join(root, e.name, sub, 'bin', 'java.exe'));
            }
          } catch {}
        }
      }
    } catch {}
  }

  const { err, stdout } = await exec('where.exe', ['java.exe']);
  if (!err) {
    for (const line of stdout.split(/\r?\n/)) await add(line.trim());
  }

  found.sort((a, b) => b.major - a.major);
  return found;
}

// Which Java major version does this Minecraft version need?
function requiredJava(vj) {
  if (vj.javaVersion?.majorVersion) return vj.javaVersion.majorVersion;
  return 8;
}

async function ensureJava(gameDir, vj, javaPathOverride, onProgress) {
  const required = requiredJava(vj);
  const installed = await findInstalledJavas(gameDir);

  if (javaPathOverride) {
    const info = await probe(javaPathOverride);
    if (info && info.major >= required) return info;
    if (info) throw new Error(`Configured Java is version ${info.major}, but Minecraft ${vj.id} needs Java ${required}.`);
    throw new Error(`Configured Java not found: ${javaPathOverride}`);
  }

  // Lowest version that satisfies the requirement — newer JVMs break old mods.
  const usable = installed.slice().sort((a, b) => a.major - b.major)
    .find(j => j.major >= required);
  if (usable) return usable;

  onProgress?.({ phase: 'java', current: 0, total: 1, file: `Downloading Java ${required}...` });
  const url = `https://api.adoptium.net/v3/binary/latest/${required}/ga/windows/x64/jdk/hotspot/normal/eclipse`;
  const runtimesDir = path.join(gameDir, 'runtimes');
  const zipPath = path.join(runtimesDir, `jdk${required}.zip`);
  await fsp.mkdir(runtimesDir, { recursive: true });
  await downloadFile(url, zipPath, { retries: 2 });

  const staging = path.join(runtimesDir, `_extract_${required}`);
  await fsp.rm(staging, { recursive: true, force: true });
  await extractZip(zipPath, staging);
  await fsp.rm(zipPath, { force: true });

  // Move the single nested jdk-* folder into runtimes/java-<required>
  const dest = path.join(runtimesDir, `java-${required}`);
  await fsp.rm(dest, { recursive: true, force: true });
  const entries = await fsp.readdir(staging);
  const inner = entries.length === 1 ? path.join(staging, entries[0]) : staging;
  await fsp.rename(inner, dest);
  if (inner !== staging) await fsp.rm(staging, { recursive: true, force: true });

  const info = await probe(path.join(dest, 'bin', 'java.exe'));
  if (!info) throw new Error('Java download succeeded but java.exe is not runnable.');
  onProgress?.({ phase: 'java', current: 1, total: 1, file: `Java ${required} ready` });
  return info;
}

module.exports = { findInstalledJavas, ensureJava, requiredJava, parseJavaVersion };
