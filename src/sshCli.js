const { spawn } = require('child_process');

/**
 * Run a shell command on the remote server over SSH and stream its output.
 * Uses spawn so nothing is interpreted by a local shell; the command string is
 * handed to ssh as one argument and run entirely by the remote shell.
 *
 * @since 1.1.0
 * @param {object} opts
 * @param {string} opts.host           - remote host
 * @param {string} opts.user           - SSH username
 * @param {string|number} opts.port    - SSH port
 * @param {string} opts.privateKey     - path to the SSH private key
 * @param {string} opts.command        - shell command to run remotely
 * @param {string[]} [opts.sshArgs]    - extra ssh arguments
 * @returns {Promise<void>}
 */
function runRemoteCommand({ host, user, port, privateKey, command, sshArgs = [] }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', privateKey,
      '-p', String(port),
      '-o', 'BatchMode=yes',
      ...sshArgs,
      `${user}@${host}`,
      command
    ];

    const proc = spawn('ssh', args);
    let stderr = '';

    proc.stdout.on('data', (d) => {
      process.stdout.write(d);
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Remote command failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  runRemoteCommand
};
