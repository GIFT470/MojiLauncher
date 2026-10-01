const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const mc = require('./mc-core');
const { ensureJava, findInstalledJavas } = require('./java');
const { getLoaderVersions, ensureLoader, resolveInstanceId } = require('./loaders');
const mods = require('./mods');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  gameDir: path.join(app.getPath('appData'), '.minecraft'),
  javaPath: '',
  ramMb: 4096,
  showSnapshots: false,
  width: 0,
  height: 0,
  username: 'Player',
  loader: 'vanilla',
  loaderVersion: '',
  curseforgeKey: '',
};

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const file = SETTINGS_FILE();
  try {
    const raw = await fsp.readFile(file, 'utf8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // Migrate settings from the previous app name (craftlaunch) if present.
    const legacy = path.join(app.getPath('appData'), 'craftlaunch', 'settings.json');
    try {
      const raw = await fsp.readFile(legacy, 'utf8');
      settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(settings, null, 2));
    } catch {}
  }
  await fsp.mkdir(settings.gameDir, { recursive: true });
}

async function saveSettings() {
  await fsp.writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

let win = null;
let gameProcess = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 660,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0a0a0d',
    title: 'Moji Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await loadSettings();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (gameProcess) gameProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('save-settings', async (_e, patch) => {
  settings = { ...settings, ...patch };
  if (patch.gameDir) await fsp.mkdir(patch.gameDir, { recursive: true });
  await saveSettings();
  return settings;
});

ipcMain.handle('pick-directory', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('get-versions', async () => {
  const manifest = await mc.getVersionManifest();
  return {
    latest: manifest.latest,
    versions: manifest.versions.map(v => ({ id: v.id, type: v.type, url: v.url, releaseTime: v.releaseTime })),
  };
});

ipcMain.handle('get-javas', () => findInstalledJavas(settings.gameDir));

ipcMain.handle('get-loader-versions', async (_e, { loader, gameVersion }) => {
  try {
    return { ok: true, versions: await getLoaderVersions(loader, gameVersion) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function instanceDirFor(gameDir, launchId) {
  const dir = path.join(gameDir, 'instances', launchId);
  for (const sub of ['mods', 'config', 'saves']) {
    await fsp.mkdir(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

ipcMain.handle('open-instance-dir', async (_e, { versionId, loader, loaderVersion }) => {
  const launchId = await resolveInstanceId(settings.gameDir, loader, versionId, loaderVersion);
  const dir = await instanceDirFor(settings.gameDir, launchId);
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('mod-search', async (_e, opts) => {
  try {
    return await mods.search({ ...opts, apiKey: settings.curseforgeKey });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mod-files', async (_e, opts) => {
  try {
    return { ok: true, files: await mods.files({ ...opts, apiKey: settings.curseforgeKey }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mod-install', async (_e, { fileUrl, filename, versionId, loader, loaderVersion }) => {
  try {
    const launchId = await resolveInstanceId(settings.gameDir, loader, versionId, loaderVersion);
    const dir = await instanceDirFor(settings.gameDir, launchId);
    const dest = path.join(dir, 'mods', filename);
    if (fs.existsSync(dest)) return { ok: true, dest, existing: true };
    await mc.downloadFile(fileUrl, dest);
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('launch', async (_e, { versionId, versionUrl, username, loader, loaderVersion }) => {
  if (gameProcess) return { ok: false, error: 'Game is already running.' };
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username || '')) {
    return { ok: false, error: 'Username must be 3-16 characters: letters, numbers, underscores.' };
  }

  const gameDir = settings.gameDir;
  try {
    send('progress', { phase: 'version', current: 0, total: 1, file: `Loading ${versionId}...` });
    const vjVanilla = await mc.getVersionJson(gameDir, versionId, versionUrl);

    const java = await ensureJava(gameDir, vjVanilla, settings.javaPath,
      p => send('progress', p));
    send('game-log', `[launcher] Using Java ${java.major}: ${java.path}`);

    let launchId = versionId;
    if (loader && loader !== 'vanilla') {
      if (!loaderVersion) return { ok: false, error: 'No loader version selected.' };
      send('progress', { phase: 'loader', current: 0, total: 1, file: `Preparing ${loader} ${loaderVersion}...` });
      launchId = await ensureLoader(gameDir, loader, versionId, loaderVersion, java.path,
        line => send('game-log', line));
      send('progress', { phase: 'loader', current: 1, total: 1, file: launchId });
    }

    const vj = launchId === versionId ? vjVanilla : await mc.getVersionJson(gameDir, launchId);

    await mc.installVersion(gameDir, vj, p => send('progress', p));

    const instanceDir = await instanceDirFor(gameDir, launchId);
    send('game-log', `[launcher] Instance folder: ${instanceDir}\n`);

    // Modern version jsons put natives jars directly on the classpath and point
    // -Djava.library.path/-Djna.tmpdir/lwjgl SharedLibraryExtractPath at this
    // dir, so it must exist even when nothing is extracted into it.
    const nativesPath = path.join(gameDir, 'versions', vj.id, `${vj.id}-natives`);
    await fsp.mkdir(nativesPath, { recursive: true });
    const nativesDir = nativesPath;

    const args = mc.buildLaunchArgs(gameDir, vj, {
      username,
      ramMb: settings.ramMb,
      width: settings.width,
      height: settings.height,
      nativesDir,
      gameDirectory: instanceDir,
    });

    send('progress', { phase: 'launch', current: 1, total: 1, file: 'Starting game...' });
    send('game-log', `[launcher] ${java.path} ${args.slice(0, 4).join(' ')} ... ${vj.mainClass}`);

    gameProcess = spawn(java.path, args, { cwd: gameDir, windowsHide: false });
    gameProcess.stdout.on('data', d => send('game-log', d.toString()));
    gameProcess.stderr.on('data', d => send('game-log', d.toString()));
    gameProcess.on('exit', (code, signal) => {
      gameProcess = null;
      send('game-exit', { code, signal });
    });
    gameProcess.on('error', err => {
      gameProcess = null;
      send('game-exit', { code: -1, error: err.message });
    });

    return { ok: true, pid: gameProcess.pid };
  } catch (err) {
    gameProcess = null;
    return { ok: false, error: err.message || String(err) };
  }
});

// ---- App self-update ----
// Packaged app: electron-updater downloads new versions from GitHub Releases.
// Dev/git checkout: fast-forward pull from the repo.
const { autoUpdater } = require('electron-updater');
let updateDownloaded = false;
let lastUpdateCheck = 0;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

autoUpdater.on('update-downloaded', info => {
  updateDownloaded = true;
  send('game-log', `[updater] Version ${info.version} downloaded — restart to install.\n`);
  send('update-downloaded', { version: info.version });
});
autoUpdater.on('error', err => {
  send('game-log', `[updater] ${err.message}\n`);
});

function runGit(args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: app.getAppPath(), windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function checkForUpdatesGit() {
  if (!fs.existsSync(path.join(app.getAppPath(), '.git'))) {
    return { ok: false, state: 'no-repo', message: 'This install is not a git checkout, so it cannot auto-update.' };
  }
  const remote = await runGit(['remote']);
  if (!remote.stdout.trim()) {
    return { ok: false, state: 'no-remote', message: 'No git remote configured.' };
  }
  const before = await runGit(['rev-parse', 'HEAD']);
  const fetched = await runGit(['fetch', '--quiet', 'origin']);
  if (fetched.err && /ENOENT|not recognized/i.test(fetched.err.message)) {
    return { ok: false, state: 'no-git', message: 'Git is not installed, so auto-update is unavailable.' };
  }
  if (fetched.err) {
    return { ok: false, state: 'fetch-failed', message: fetched.stderr.trim() || 'Could not reach GitHub.' };
  }
  const behind = await runGit(['rev-list', '--count', 'HEAD..@{u}']);
  const count = parseInt(behind.stdout.trim(), 10);
  if (!count) {
    return { ok: true, state: 'up-to-date', message: 'You are on the latest version.' };
  }
  const pull = await runGit(['pull', '--ff-only', '--quiet']);
  if (pull.err) {
    return { ok: false, state: 'pull-failed', message: pull.stderr.trim() || 'Update failed.' };
  }
  const after = await runGit(['rev-parse', 'HEAD']);
  const changed = before.stdout.trim() !== after.stdout.trim();
  return {
    ok: true,
    state: changed ? 'updated' : 'up-to-date',
    count,
    message: changed
      ? `Updated ${count} change${count === 1 ? '' : 's'}. Restart to apply.`
      : 'You are on the latest version.',
  };
}

async function checkForUpdates() {
  if (updateDownloaded) {
    return { ok: true, state: 'updated', message: 'Update downloaded. Restart to install.' };
  }
  if (app.isPackaged) {
    if (Date.now() - lastUpdateCheck < 30000) {
      return { ok: true, state: 'checking', message: 'Checking for updates...' };
    }
    lastUpdateCheck = Date.now();
    try {
      const res = await autoUpdater.checkForUpdates();
      const latest = res?.updateInfo?.version;
      if (!latest || latest === app.getVersion()) {
        return { ok: true, state: 'up-to-date', message: 'You are on the latest version.' };
      }
      return {
        ok: true,
        state: 'downloading',
        message: `Version ${latest} found — downloading in the background. You'll be prompted to restart.`,
      };
    } catch (err) {
      return { ok: false, state: 'error', message: err.message || String(err) };
    }
  }
  return checkForUpdatesGit();
}

ipcMain.handle('check-for-updates', () => checkForUpdates());

ipcMain.handle('restart-app', () => {
  if (updateDownloaded) {
    autoUpdater.quitAndInstall();
    return;
  }
  app.relaunch();
  app.exit(0);
});
