# Updating the vendored Pi ACP adapter

This package starts from `svkozak/pi-acp` v0.0.33 at commit
`1bfcb394088ed879db8fd936b570bb626017f878`. Updates are manual; there is no
automated sync.

## Upstream contribution policy

Keep the vendored source in this repository as the release source; do not
maintain a separate downstream fork as the normal update path. Submit generally
useful, ensemble-independent fixes to `svkozak/pi-acp` and keep any required
patch in the vendor copy until upstream accepts it and a later manual update
can incorporate it. Keep ensemble-specific runtime, storage, and harness
integration in the vendor copy. If upstream cannot accept a generally useful
change or its response would block a necessary fix, carry only the required
local patch and record the divergence here. Reconsider a fork only through a
separate maintainer decision if the vendor delta becomes impractical to review
and update.

1. Review the upstream release notes and source changes since the recorded
   commit.
2. Compare the upstream source and tests with `src/` and `test/` here. Preserve
   local changes for session-map path overrides, Pi CLI invocation, builtin
   settings, and any ensemble-specific ACP behavior.
3. Update the upstream version and commit in this file, `NOTICE`, and the
   package README. Keep the upstream MIT license and copyright notice.
4. Run this package's `typecheck`, tests, and build, then run the core Pi ACP
   integration and session-history tests.
5. Record behavior or format changes in the relevant system documentation and
   changeset.

The package version follows the agents-ensemble release cycle. The upstream
version recorded above identifies the source baseline and is not the npm
version of this package.
