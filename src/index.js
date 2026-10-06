const path = require('path');

const { getInputs, computeDest, assertRequired } = require('./inputs');
const { ALWAYS_EXCLUDE } = require('./excludes');
const { readExcludeFile, splitList, splitArgsPreserveQuotes } = require('./helpers');
const { addSshKey, removeSshKey, configureKnownHosts, hostKeyArgs, removePassphrase } = require('./sshKey');
const { ensureRsync, runRsync } = require('./rsyncCli');
const { runRemoteCommand } = require('./sshCli');

// path to the written key file — set in main(), removed on exit
let deployKeyPath = null;
process.on('exit', () => removeSshKey(deployKeyPath));

/**
 * Run the optional SCRIPT on the remote server after a successful rsync. Skipped when SCRIPT is empty.
 *
 * @since 1.0.0
 * @param {object} cfg      - parsed action inputs
 * @param {string} keyPath  - path to the SSH private key
 * @param {string[]} sshArgs - extra ssh arguments
 * @returns {Promise<void>}
 */
async function runPostDeploy(cfg, keyPath, sshArgs) {
  if (!cfg.script) return;

  console.log('[script] Running remote script...');
  await runRemoteCommand({
    host: cfg.host,
    user: cfg.user,
    port: cfg.port,
    privateKey: keyPath,
    command: cfg.script,
    sshArgs
  });
  console.log('✅ [script] completed');
}

/**
 * Deploy the source folder over rsync + SSH, then run the optional remote script.
 *
 * @since 1.0.0
 * @returns {Promise<void>}
 */
async function main() {
  const cfg = getInputs();
  assertRequired(cfg);

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const remoteDest = `${cfg.user}@${cfg.host}:${computeDest(cfg)}`;
  const localSrc = path.posix.join(workspace, cfg.source.endsWith('/') ? cfg.source : `${cfg.source}/`);

  // merge excludes: always-on + file + extra
  const excludes = [...ALWAYS_EXCLUDE, ...readExcludeFile(workspace, cfg.excludeFile), ...splitList(cfg.extraExclude)];

  console.log(`[deploy] Source → ${localSrc}`);
  console.log(`[deploy] Dest → ${remoteDest}`);
  console.log(`[deploy] Rsync → ${cfg.rsyncArgs}`);
  console.log(`[deploy] Excludes → ${excludes.length}`);

  const keyPath = addSshKey(cfg.key, cfg.keyName);
  deployKeyPath = keyPath;
  const sshArgs = hostKeyArgs(configureKnownHosts(cfg.knownHosts));

  if (cfg.passphrase) {
    await removePassphrase(keyPath, cfg.passphrase);
  }

  await ensureRsync();

  const stdout = await runRsync({
    src: localSrc,
    dest: remoteDest,
    args: splitArgsPreserveQuotes(cfg.rsyncArgs),
    privateKey: keyPath,
    port: cfg.port,
    excludes,
    sshArgs
  });
  console.log('✅ [rsync] completed');
  if (stdout) console.log(stdout);

  await runPostDeploy(cfg, keyPath, sshArgs);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('⚠️  [deploy] error:', e.message);
    process.exit(1);
  });
