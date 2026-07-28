/**
 * ssh.service.js
 * Low-level SSH helper using the `ssh2` package (CommonJS compatible).
 * Provides connect, exec (with live streaming), and writeFile via SFTP.
 */

const { Client } = require('ssh2');

/**
 * Open an SSH connection.
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=22]
 * @param {string} opts.username
 * @param {string} [opts.privateKey]  PEM private key string
 * @param {string} [opts.password]    password (alternative to privateKey)
 * @returns {Promise<Client>}
 */
function connect({ host, port = 22, username, privateKey, password }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({ host, port: Number(port), username, privateKey, password });
  });
}

/**
 * Run a shell command on the remote host.
 * Output is streamed line-by-line via the optional callbacks.
 *
 * @param {Client} conn
 * @param {string} command
 * @param {(line: string) => void} [onStdout]
 * @param {(line: string) => void} [onStderr]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
function exec(conn, command, onStdout, onStderr) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      const stdoutChunks = [];
      const stderrChunks = [];

      stream.on('close', (code) => {
        resolve({
          code,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
        });
      });

      stream.on('data', (chunk) => {
        stdoutChunks.push(chunk);
        if (onStdout) {
          chunk.toString().split('\n').forEach((line) => {
            if (line.trim()) onStdout(line);
          });
        }
      });

      stream.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk);
        if (onStderr) {
          chunk.toString().split('\n').forEach((line) => {
            if (line.trim()) onStderr(line);
          });
        }
      });
    });
  });
}

/**
 * Write file content to a remote path via SFTP.
 * @param {Client} conn
 * @param {string} remotePath  absolute path on the remote host
 * @param {string} content
 * @returns {Promise<void>}
 */
function writeFile(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', resolve);
      stream.on('error', reject);
      stream.write(content, 'utf8');
      stream.end();
    });
  });
}

module.exports = { connect, exec, writeFile };
