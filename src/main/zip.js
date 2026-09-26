const { execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

// Extracts a zip (e.g. a natives jar) into destDir, skipping excluded META-INF patterns.
// Uses Windows' built-in bsdtar, falling back to PowerShell.
function extractZip(zipFile, destDir, exclude = []) {
  const shouldSkip = name => exclude.some(inc =>
    name.startsWith(inc.replace(/\*\*$/, '')) || name === inc);

  return new Promise(async (resolve, reject) => {
    await fsp.mkdir(destDir, { recursive: true });
    const tar = 'C:\\Windows\\System32\\tar.exe';
    execFile(tar, ['-xf', zipFile, '-C', destDir], async err => {
      if (err) {
        execFile('powershell.exe', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`],
          err2 => err2 ? reject(err2) : cleanup());
        return;
      }
      cleanup();
    });

    async function cleanup() {
      try {
        const skip = name => shouldSkip(name) ||
          (name.startsWith('META-INF/') && /\.(SF|DSA|RSA)$/.test(name));
        async function walk(dir) {
          for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (skip(path.relative(destDir, full).replace(/\\/g, '/'))) {
              await fsp.rm(full, { force: true });
            }
          }
        }
        await walk(destDir);
      } catch { /* best effort */ }
      resolve();
    }
  });
}

module.exports = { extractZip };
