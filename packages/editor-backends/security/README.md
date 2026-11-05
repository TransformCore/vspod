# Desktop renderer seccomp policy

`desktop-renderer-seccomp.json` is the byte-identical policy used for the Wayland
renderer spike and desktop acceptance. The desktop adapter selects this checked-in
asset automatically. `VSPOD_DESKTOP_SECCOMP` is an optional absolute-path override;
invalid overrides fail rather than falling back or disabling seccomp.

The base policy is from [Moby profiles](https://github.com/moby/profiles/blob/main/seccomp/default.json),
licensed under Apache-2.0; see [LICENSE](LICENSE). VSPod modified the base policy
to allow Chromium's unprivileged renderer namespace sandbox:

- `chroot` (the container still drops all capabilities).
- `unshare` only with exactly `CLONE_NEWUSER` or `CLONE_NEWNET`.
- `clone` with namespace-mask matches for `CLONE_NEWUSER`,
  `CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET`, `CLONE_NEWPID | CLONE_NEWNET`,
  or `CLONE_NEWPID`.

All other base rules are retained, including the default `SCMP_ACT_ERRNO`.
This is not unconfined seccomp and does not disable Chromium's sandbox. It is
specific to this experimental editor environment, not a universal application policy.
The generic app runner still requires its consumer to supply a policy.

Validated asset SHA-256:
`107f451f9ac595bd29249e35dcef8177f4cff9e4951b74675e792a284b49c6de`.
Changes must update the checksum test and pass real desktop/native acceptance;
the checksum records the tested baseline, not a signature or trust guarantee.

Docker applies the profile at container creation. Changing the asset or override
does not retrofit existing containers; explicitly recreate/upgrade the selected
environment to apply a changed policy. Signed distribution and a broader security
review remain release gates.
