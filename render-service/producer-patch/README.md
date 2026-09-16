# Producer resource budgets

OpenMAIC maintains a source patch for HyperFrames Producer 0.8.37, pinned by
`source.json`. It implements CPU/memory admission, per-task native hard limits,
and reservation/artifact settlement. The original upstream license is retained
in `LICENSE`.

This is an experimental, opt-in service path. The default service retains its
npm-locked Producer 0.7.107 and existing privilege model. **The current resource
installation and OpenMAIC Linux lifecycle cases are not yet qualified.**

## Build

Provision Linux ARM64 or x86_64 with Node >=22, Bun, Git, a C compiler and
matching Node headers. The source checkout must be at `source.json.revision`.

From `render-service`:

```sh
# Applies and verifies the patch in a temporary directory; installs nothing.
node scripts/build-resource-producer.mjs --check /path/to/hyperframes

# Installs frozen dependencies and builds the private package.
node scripts/build-resource-producer.mjs --build /path/to/hyperframes /opt/openmaic-resource
```

The output directory must not exist. The builder uses upstream `bun.lock`,
builds six workspace packages and installs the private consumer from
`consumer-lock.json`. Only the six rebuilt local tarball integrities change;
third-party versions and integrity remain fixed. It explicitly compiles native
helpers and records the installed package, lock and file identities in
`resource-build.json`. Failed build output is retained; the temporary checkout
is removed.

An extracted fixed-commit archive can be used with `--check-archive` or
`--build-archive` instead. `upstream.commit` binds the original commit object;
the complete extracted Git tree must match, including file modes and symlinks.
Supply a safely extracted, immutable directory without `.git` metadata.
The builder does not download or extract the archive.

`producer.patch` contains the implementation and its tests. `source.json`
binds the patch and changed-file hashes. Build commands do not provision OS
packages, Chromium, FFmpeg, cgroups or a VM, and do not run product tests.

## Startup and ownership

Provision an exclusive, empty cgroup v2 task delegation with CPU/memory
controllers, `cgroup.kill`, `memory.events.local`, and the privileges needed for
`CLONE_INTO_CGROUP` and mount/cgroup namespaces. The supervisor must run outside
the task delegation. Code, package and configuration paths must be root-owned
and immutable to the render user; the project root must belong to the configured
non-root worker UID/GID.

Adapt `resource-config.example.json` and save it as a root-owned configuration:

```sh
npm run start:resources -- /etc/openmaic/resource-config.json
```

The bootstrap starts a separate privileged supervisor, verifies the installed
package, then drops the HTTP process's UID/GID and supplementary groups.
Native subreaper/nondumpable settings apply only to the supervisor. Memory
budgets must be page-aligned and fit the owner envelope. The example's
1 CPU / 768 MiB budget is a mechanism-test setting, not a qualified classroom
workload profile.

| Component | Responsibility and reason for separation | Verification |
| --- | --- | --- |
| `resource-owner.mjs` | Keeps one Producer and reservation ledger across requests; process-wide subreaping must stay outside HTTP | Owner tests and installed supervisor/death cases |
| `resource-main.ts` | Starts the supervisor before dropping HTTP privileges | Installed bootstrap and privilege checks |
| `ResourceClient` | Carries cancellation, deadlines and settlement over IPC; lost transport cannot prove cleanup | Client tests and installed cancellation/owner-loss cases |
| Existing coordinator/job store | Rejects work when admission closes and retains quarantined projects across TTL cleanup | Settlement tests and installed fault cases |
| Fixed patch/build entry | Supplies the resource API absent from the default released dependency | Source/package tests and installed build readback |

Producer is the sole CPU/memory reservation ledger. The service retains upload
admission, per-user limits and job ordering, with one active render and no
second hidden queue. HTTP completion alone does not return a reservation.
A closed owner closes admission and rejects queued jobs; quarantined records
and projects remain available for platform takeover.

## Supported boundary

- The resource path uses local MP4 rendering; chunk execution is rejected.
- Preview retains its existing execution path and outer limits. Per-task native
  budgets for preview are not claimed.
- Progress remains at preparing until completion; frame percentages and capture
  metrics are not synthesized.
- Job records retain accounting. HTTP exposes publication/settlement status,
  including unknown publication after owner loss, without private paths.
- Default service and Docker startup do not enable privileged resource execution.
- Platform ownership of abandoned sessions and external references is required;
  automatic recovery, persistent queues and distributed scheduling are outside
  this implementation.

See [Linux validation](LINUX-VALIDATION.md) for required installed-package and
service lifecycle checks. Portable tests and historical Producer runs do not
qualify the current installation. Supported architecture/profile evidence and
final CI must accompany the exact candidate before merge.
