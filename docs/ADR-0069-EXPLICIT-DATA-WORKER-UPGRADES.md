# ADR-0069: Explicit versioned upgrades for user-owned data Workers

## Status

Accepted — 2026-10-15. Supplements ADR-0067 and ADR-0068.

## Context

The public application can be redeployed by its owner, but every installed data
Worker and D1 database belongs to a different Cloudflare account. Replacing the
main application therefore cannot silently change an existing user's data
plane. Ordinary UI releases also must not request unnecessary account writes,
while Worker or schema releases need a safe and visible upgrade path.

## Decision

- `CLOUD_DATA_WORKER_VERSION` is the single monotonically increasing release
  number for the provisioned Worker source, bindings and D1 schema. It is
  separate from `CLOUD_API_VERSION`, which versions the browser wire protocol.
- The control D1 stores `worker_version` for each installation. Legacy rows are
  migrated to version 1; fresh installations record the current release only
  after provisioning succeeds.
- Control status returns the installed version, latest version and an explicit
  `upgradeAvailable` flag. The cloud-sync plugin exposes one typed
  `cloudSync.upgrade` command and a governed panel action when the installed
  version is older.
- `POST /api/cloud/upgrade` revalidates the signed-in user, installation
  ownership and current Cloudflare grant. It then applies idempotent D1 schema
  statements before replacing the existing Worker script and bindings.
- Upgrade reuses the installation ID, Worker name, D1 database, signing secret
  and public URL. It does not create or delete user storage. Control metadata is
  advanced only after every Cloudflare API operation succeeds, so a failed
  attempt remains retryable and the previous ready installation is retained.
- A newer recorded installation is never downgraded automatically. Breaking
  wire changes require a new protocol decision and compatibility plan rather
  than overloading this release counter.

## Consequences

- Main-site UI-only releases require no user action. A data-plane release is
  visible and can be installed with one explicit click.
- Additive, idempotent schema changes fit the shared schema file. Destructive or
  rewriting migrations still require staged, recoverable migration code and a
  separate decision record.
- The version stored in the control plane is authoritative for upgrade
  admission. The data Worker's public health response also reports the release
  version for diagnostics, but the control Worker does not probe another
  workers.dev route in the same account.

## Verification

- Contract tests cover legacy control-schema migration and upgrade comparison,
  including the no-downgrade rule.
- Data-Worker health tests verify both wire-protocol and deployment versions.
- Deployment acceptance upgrades an existing test installation in place and
  verifies that its project, checkpoint and content chunks remain in the same
  D1 database.
