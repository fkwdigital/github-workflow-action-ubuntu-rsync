const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');
const rsync = require('rsyncwrapper');
const { sync: commandExists } = require('command-exists');

const { getInputs, computeDest, assertRequired } = require('./inputs');
const { ALWAYS_EXCLUDE } = require('./excludes');

/**
 * Ensures that rsync is installed.
 *
 * If rsync is already installed, the Promise is resolved immediately.
 * If rsync is not installed, the Promise is resolved after installation is complete.
 *
 * @returns {Promise<void>} a Promise that is resolved when rsync is installed.
 */
function ensureRsync() {
  return new Promise((resolve, reject) => {
    if (commandExists('rsync')) {
      resolve();
      return;
    }
    exec('sudo apt-get update && sudo apt-get --no-install-recommends install -y rsync', (err) => {
      if (err) {
        reject(new Error(`rsync install failed: ${err.message}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Strip the passphrase from a private key file in-place so rsync can use it
 * directly with -i. Uses spawn to avoid shell injection with special characters.
 *
 * @since 1.1.0
 * @param {string} keyPath    - absolute path to the private key file
 * @param {string} passphrase - current passphrase protecting the key
 * @returns {Promise<void>}
 */
function removePassphrase(keyPath, passphrase) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh-keygen', ['-p', '-P', passphrase, '-N', '', '-f', keyPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ssh-keygen failed (exit ${code}): ${stderr}`));
        return;
      }
      console.log('[SSH] Key unlocked for deployment');
      resolve();
    });
  });
}

/**
 * Reads an exclude file and returns an array of exclude patterns.
 *
 * @param {string} workspace - the workspace directory
 * @param {string} relPath - the relative path to the exclude file
 * @returns {string[]} an array of exclude patterns
 */
function readExcludeFile(workspace, relPath) {
  if (!relPath) return [];
  const p = path.isAbsolute(relPath) ? relPath : path.join(workspace, relPath);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Splits a string into an array of tokens, preserving quotes.
 *
 * @param {string} str - the string to split
 * @returns {string[]} an array of tokens
 */
function splitArgsPreserveQuotes(str) {
  const tokens = (str || '').match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) || [];
  return tokens.map((t) => t.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
}

/**
 * Validates that a directory exists at the given path.
 * If the directory does not exist, it is created recursively.
 *
 * @param {string} dir - the path to the directory to validate
 */
function validateDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Ensures that a file exists at the given path.
 * If the file does not exist, it is created with the given mode and encoding.
 *
 * @param {string} filePath - the path to the file to validate
 */
function validateFile(filePath) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Adds an SSH key to the user's ~/.ssh directory.
 *
 * @param {string} key - the SSH key to add
 * @param {string} [name] - the name to give the key (defaults to 'deploy_key')
 * @returns {string} - the path to the added key
 */
function addSshKey(key, name) {
  const home = process.env.HOME || os.homedir();
  const sshDir = path.join(home, '.ssh');
  validateDir(sshDir);
  validateFile(path.join(sshDir, 'known_hosts'));
  const filePath = path.join(sshDir, name || 'deploy_key');
  fs.writeFileSync(filePath, key, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

/**
 * Run a remote script on a configured host.
 *
 * @param {object} cfg - the configured host
 * @param {string} keyPath - the path to the SSH key
 * @returns {Promise} - resolves when the script completes, rejects if the script fails
 */
function runRemoteScript(cfg, keyPath) {
  return new Promise((resolve, reject) => {
    if (!cfg.script) {
      resolve();
      return;
    }

    console.log('[deploy] Running remote script...');

    const sshCmd = [
      'ssh',
      '-i',
      keyPath,
      '-p',
      cfg.port,
      '-o',
      'StrictHostKeyChecking=no',
      `${cfg.user}@${cfg.host}`,
      cfg.script
    ].join(' ');

    exec(sshCmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Remote script failed: ${error.message}\nstderr: ${stderr}`));
        return;
      }
      console.log('✅ [script] completed');
      if (stdout) console.log(stdout);
      resolve();
    });
  });
}

async function main() {
  const cfg = getInputs();
  assertRequired(cfg);

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const remoteDest = `${cfg.user}@${cfg.host}:${computeDest(cfg)}`;
  const localSrc = path.posix.join(
    workspace,
    cfg.source.endsWith('/') ? cfg.source : `${cfg.source}/`
  );

  // merge excludes: always-on + file + extra (lint-friendly)
  const fileEx = readExcludeFile(workspace, cfg.excludeFile);
  const extra = (cfg.extraExclude || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const EXCLUDES = [...ALWAYS_EXCLUDE, ...fileEx, ...extra];

  console.log(`[deploy] Source → ${localSrc}`);
  console.log(`[deploy] Dest → ${remoteDest}`);
  console.log(`[deploy] Rsync → ${cfg.rsyncArgs}`);
  console.log(`[deploy] Excludes → ${EXCLUDES.length}`);

  const keyPath = addSshKey(cfg.key, cfg.keyName);
  const home = process.env.HOME || os.homedir();
  validateDir(path.join(home, '.ssh'));
  validateFile(path.join(home, '.ssh', 'known_hosts'));

  if (cfg.passphrase) {
    await removePassphrase(keyPath, cfg.passphrase);
  }

  await ensureRsync();

  rsync(
    {
      src: localSrc,
      dest: remoteDest,
      args: splitArgsPreserveQuotes(cfg.rsyncArgs),
      privateKey: keyPath,
      port: cfg.port,
      excludeFirst: EXCLUDES,
      ssh: true,
      sshCmdArgs: ['-o', 'StrictHostKeyChecking=no'],
      recursive: true
    },
    async (error, stdout, stderr, cmd) => {
      // if rsync fails, abort
      if (error) {
        console.error('⚠️  [rsync] error:', error.message);
        console.error('stderr:', stderr || '');
        console.error('cmd:', cmd || '');
        process.abort();
        return;
      }
      console.log('✅ [rsync] completed');
      if (stdout) console.log(stdout);

      // run remote script if provided
      try {
        await runRemoteScript(cfg, keyPath);
        process.exit(0);
      } catch (scriptError) {
        console.error('⚠️  [script] error:', scriptError.message);
        process.exit(1);
      }
    }
  );
}

main();
