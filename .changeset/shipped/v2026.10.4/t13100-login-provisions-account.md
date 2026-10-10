---
id: t13100-login-provisions-account
tasks: [T13100]
kind: feat
summary: cleo login nexus sets up the account key and certifies the device, so the first push has nothing left to set up
---

Until now the first `cleo cloud push` on an account quietly minted the account master key, escrowed it
on Cleo Nexus, certified the device and only then minted the project key, so account setup failed in the
middle of a backup. `cleo login nexus` now does the account part right after enrolment, on the new
device credential (the escrow routes accept only device credentials): it reads the escrowed key, or
mints and escrows it when the account has none, then certifies this device and records the signer trust
in `nexus-vault.json`. When two devices log in at once on a fresh account, the one whose escrow loses
with 409 reads the winner's key and never mints again.

The login says "Your account is ready for encrypted backups" when this worked, and the result carries
an `account` block (`ready`, `unsupported`, `skipped` for a read-only device, or `failed`). The setup
never fails the login: a server without key escrow, or a failed step, is a warning naming the step
(`escrow-read`, `escrow-mint`, `certify`, `trust`) and the remedy. `cleo cloud push` still sets the
account up for a device that logged in before this change. The same step is exported as
`provisionNexusAccount` for the guided first run.
