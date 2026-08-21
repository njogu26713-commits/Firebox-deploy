/**
 * ssh.service.js
 * Low-level SSH helper using the `ssh2` package (CommonJS compatible).
 * Provides connect, exec (with live streaming), and writeFile via SFTP.
 */

const { Client } = require('ssh2');
const net = require('net');

/**
 * Probe raw TCP reachability before attempting SSH authentication.
 * This never uses or handles credentials.
 */
function probeTcp({ host, port = 22, timeout = 10000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const socket = net.createConnection({ host, port: Number(port), family: 4, autoSelectFamily: false, timeout });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const payload = { ...result, host, port: Number(port), elapsedMs: Date.now() - startedAt };
      socket.destroy();
      resolve(payload);
    };
    socket.once('connect', () => finish({ ok: true, status: 'success' }));
    socket.once('timeout', () => finish({ ok: false, status: 'timeout', error: `TCP connection timed out after ${timeout}ms` }));
    socket.once('error', (err) => finish({ ok: false, status: 'failed', error: `${err.code || 'TCP_ERROR'}: ${err.message}` }));
  });
}

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
function connect({ host, port = 22, username, privateKey, password, readyTimeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      conn.end();
      const detail = String(err?.message || err || 'Unknown SSH connection error');
      const wrapped = new Error(`SSH connection to ${host}:${Number(port)} failed: ${detail}`);
      wrapped.code = err?.code;
      reject(wrapped);
    };
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for SSH handshake after ${readyTimeout}ms`)), readyTimeout + 1000);
    conn
      .on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(conn);
      })
      .on('error', fail)
      .on('timeout', () => fail(new Error('SSH socket timed out before the handshake completed')))
      .connect({ host, port: Number(port), username, privateKey, password, family: 4, readyTimeout, keepaliveInterval: 10000, keepaliveCountMax: 3 });
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

module.exports = { connect, probeTcp, exec, writeFile };
