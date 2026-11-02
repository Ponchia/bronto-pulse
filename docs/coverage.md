# Portfolio configuration coverage

Lifecycle: current

`pulse coverage --input /private/inventory.json --config /private/pulse.config.json`
compares an explicit inventory with the selected installation. It is offline:
no database, credentials, provider requests, configuration changes or schedules.

```json
{
  "version": 1,
  "resources": [
    { "provider": "github", "repository": "example/library" },
    { "provider": "npm", "package": "@example/library" }
  ]
}
```

GitHub defaults to all six supported groups; supply `groups` to deliberately
check a smaller scope. A metadata-only repository cannot satisfy traffic
coverage. An npm package is a separate resource from its source repository.
Disabled or unbound resources are reported separately from missing resources.
Repository matching is case-insensitive; package matching is exact. Duplicate
identities and unsupported input fields are rejected. Inventories are bounded
to 500 resources and CLI input to 256 KiB. Keep real inventories private.

Exit 0 means every requested identity/group has an enabled, project-bound
configuration. Exit 2 means configuration gaps; invalid input exits 1.
**Configured does not mean collected or healthy.** Use `pulse probe` to verify
actual account access and `pulse doctor` to inspect current observations. This
check does not interpret binding dates as historical coverage or prove that a
package has independent users.

Before expanding a Worker portfolio, verify package identities and first
publication dates, preserve existing mappings, and preview `pulse plan` with a
bounded window. More groups lengthen a one-job-per-trigger rotation. Keep the
existing Free-profile request/observation limits; do not raise quotas, copy a
broad CLI token, or enable new grants to make this check pass. Collection and
production publication need their own operator authorization and evidence.
