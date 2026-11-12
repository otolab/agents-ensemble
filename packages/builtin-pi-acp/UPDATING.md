# Updating the vendored Pi ACP adapter

This package starts from `svkozak/pi-acp` v0.0.33 at commit
`1bfcb394088ed879db8fd936b570bb626017f878`. Updates are manual; there is no
automated sync.

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
