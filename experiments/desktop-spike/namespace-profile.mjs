import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error('Usage: node namespace-profile.mjs <upstream-default.json> <output.json>');
const input = await readFile(baselinePath);
const digest = createHash('sha256').update(input).digest('hex');
if (digest !== '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6') {
  throw new Error('Baseline differs from the tested upstream snapshot; see README.md for the pinned download.');
}
const profile = JSON.parse(input);
if (profile.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(profile.syscalls)) {
  throw new Error('Expected the upstream deny-by-default Docker seccomp profile.');
}
// Namespace creation plus Chromium's inner-namespace chroot.
// No mount, setns, clone3 or capability additions.
const user = 0x10000000;
const pid = 0x20000000;
const net = 0x40000000;
const namespaceMask = 0x7e020000;
// Chromium chroots after entering its own user namespace. The outer user still
// has no CAP_SYS_CHROOT; seccomp cannot constrain the pointed-to pathname.
profile.syscalls.push({ names: ['chroot'], action: 'SCMP_ACT_ALLOW' });
for (const flags of [user, net]) {
  profile.syscalls.push({
    names: ['unshare'], action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: flags, op: 'SCMP_CMP_EQ' }],
  });
}
for (const flags of [user, user + pid + net, pid + net, pid]) {
  profile.syscalls.push({
    names: ['clone'], action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: namespaceMask, valueTwo: flags, op: 'SCMP_CMP_MASKED_EQ' }],
  });
}
await writeFile(outputPath, JSON.stringify(profile, null, 2), { mode: 0o600, flag: 'wx' });
console.log(`Upstream baseline sha256:${digest}`);
console.log(`Experimental profile: ${outputPath}`);
