# Installed Linux validation

**Current candidate: NOT_RUN for native and Producer/OpenMAIC runtime cases.**
OS dependency installation alone does not qualify the product. Record results
against the exact source, built packages and actual dependency locks.

## Environment

Use an isolated Linux ARM64 or x86_64 environment with Node >=22 and the build
dependencies described in [README](README.md). Provision Chromium headless shell
151, FFmpeg and ffprobe. The existing standard profile requires at least 8 GiB;
low-memory requires 4 GiB. These profile checks must remain enabled.

Provide root-owned immutable code/configuration and executable paths, an
unprivileged worker UID/GID, a fresh worker-owned project directory, and a fresh
exclusive cgroup v2 task delegation for each stage/case. The supervisor and test
observer must be outside that task delegation. Native smoke uses UID/GID 65534.
Retain the native cgroup/namespace capabilities described in the README.

The execution owner supplies outer resource limits, bounded process cleanup and
evidence return. Disable external networking before runtime cases while retaining
loopback HTTP. Tests do not provision machines or implement platform recovery.
Keep the original test budgets: 1 CPU / 768 MiB / swap 0, 10 s cleanup,
120 s normal task deadline and 15 s injected deadline. The native fixture retains
its own existing limits.

## Build and installation identity

From `render-service`, install the service's frozen dependencies and use the
existing private Producer builder:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/build-resource-producer.mjs --build /opt/hyperframes-source /opt/openmaic-resource
```

For a safely extracted fixed source archive, use `--build-archive`.
Retain both complete actual npm locks and `resource-build.json`, including native
file hashes and target architecture. The builder preserves the patched
`verification/installed-linux-cases.mjs` and binds its hash in that receipt.
Do not substitute an older successful package.

## Producer cases

Supply the existing `HYPERFRAMES_RESOURCE_TEST_` environment inputs:
`PACKAGE`, `CGROUP`, `WORKDIR`, `PROJECT`, `CHROME`, `ARTIFACT_DIR`,
`RUN_ID`, `INPUT_SHA256` and a fresh `EVIDENCE` path.

Run sequentially with the existing 180 s native and 600 s pipeline outer bounds:

```sh
node /opt/openmaic-resource/verification/installed-linux-cases.mjs run native
node /opt/openmaic-resource/verification/installed-linux-cases.mjs run pipeline
```

Native cases verify launch ownership, aggregate limits, cancellation, deadline
and lifeline loss. Pipeline cases verify real media execution, failure accounting,
ancestor-pressure closure versus task-OOM recovery, reservation reuse,
publication and quarantine. Do not inherit results from older fixture runs.

## OpenMAIC installed service

`test/resource-installed-linux.mjs` uses the actual HTTP service and installed
native package. Provision a new configuration, project root and task delegation
for each case. Set the profile, browser path, project root, fixture and unused
loopback port; for example:

```sh
export RENDER_RESOURCE_PROFILE=standard
export PRODUCER_HEADLESS_SHELL_PATH=/opt/chromium/headless_shell
export PRODUCER_TMP_PROJECT_DIR=/opt/openmaic-test/projects
export HYPERFRAMES_RESOURCE_TEST_PROJECT=/opt/fixed-fixture
export PORT=19000
node --import tsx test/resource-installed-linux.mjs --check \
  /opt/openmaic-test/settings.json normal /opt/evidence/NEW_RUN_ID-normal
```

The check verifies real installed/source identities, lock hashes, original
budgets, ownership and profile limits without starting the service. Bind its
returned `inputSha256` before executing the same inputs:

```sh
export OPENMAIC_RESOURCE_TEST_INPUT_SHA256=THE_CHECKED_INPUT_SHA256
node --import tsx test/resource-installed-linux.mjs --execute \
  /opt/openmaic-test/settings.json normal /opt/evidence/NEW_RUN_ID-normal
```

Use a 600 s outer bound per case. Run cases sequentially; stop at the first
failure and retain evidence.

| Case | Required behavior |
| --- | --- |
| normal | Separate privileged supervisor and unprivileged HTTP; two decoded exports on the same owner; drain and reservation return |
| cancel | HTTP cancellation after live media; cleanup, recovery and previous artifact preserved |
| deadline | Original deadline enforced; cleanup, reservation return and recovery |
| task-oom | Task-local OOM evidence; failure settlement and same-owner recovery |
| ancestor-pressure | Ancestor-local pressure evidence; admission closes and queued work is rejected |
| api-death | Lost HTTP lifeline triggers media drain and session closure; no fabricated settlement after owner death |
| supervisor-death | Guardian drains media; publication is unknown, reservation retained and new work rejected |
| guardian-death | Supervisor drains media; failed task remains quarantined and new work is rejected |

Fault injection requires an observed in-domain live Chrome renderer and encoding
FFmpeg process. Missing that gate is a failure, not startup-only coverage.
The fixed 1 s / 200×200 fixture establishes lifecycle behavior, not large-course
performance, full audio correctness or all capture modes.

## Evidence and cleanup

Keep source/package identities, complete actual locks, process starttimes and
membership, mount/security observations, startup/exit output, case assertions
and decoded output evidence. A case PASS requires independent execution-owner
exit and cleanup readback plus evidence acknowledgement.

The service test bounds normal shutdown to 25 s. The execution owner must stop
remaining processes within its cleanup bound, preserve uncertain ownership and
capture retained objects before removing only that run's owned assets.
Do not turn quarantined reservations into successful returns during cleanup.

Do not relax assertions or product deadlines after failure. Record the failing
stage and leave downstream cases NOT_RUN. Keep machine addresses, credentials,
download diagnostics, run-specific commands and historical failures outside
product documentation. Final review must bind runtime evidence and CI to the
delivered candidate; ordinary service tests do not automatically run these cases.
