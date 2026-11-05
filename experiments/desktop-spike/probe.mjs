import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const image = 'vspod-experiment:desktop-sandbox-probe';
const name = `vspod-desktop-probe-${randomBytes(6).toString('hex')}`;
const context = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--seccomp')) {
  throw new Error('Usage: node probe.mjs [--seccomp <experimental-profile.json>]');
}

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

const build = await run(['build', '--tag', image, context], 900_000);
if (build !== 0) process.exitCode = build;
else {
  try {
    process.exitCode = await run([
      'run', '--rm', '--name', name, '--init', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...(args.length ? ['--security-opt', `seccomp=${args[1]}`] : []),
      '--read-only', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
      '--shm-size', '128m',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
      image,
    ], 300_000);
  } finally {
    // The unique name identifies only this invocation's disposable container.
    await run(['rm', '--force', name], 15_000);
  }
}
