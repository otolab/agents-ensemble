# @agents-ensemble/builtin-pi-acp

Pi ACP adapter shipped with `@agents-ensemble/core`. The package exposes the
existing `pi-acp` executable so worker profiles keep using the `pi` preset.

The adapter is based on [`svkozak/pi-acp` v0.0.33](https://github.com/svkozak/pi-acp/tree/v0.0.33).
Its MIT license and source attribution are included in this package. The local
copy is updated manually; see [UPDATING.md](./UPDATING.md).

`@agents-ensemble/core` uses this package for both Pi worker modes:

- **BYO (default):** runs the `pi` command from `PATH` and keeps Pi's existing
  user settings, auth, session map, and transcript locations.
- **Builtin (opt in):** uses the Pi CLI already installed as a core dependency,
  keeps user Pi settings and auth under `~/.ensemble/pi/`, and stores each
  worker's session map and transcripts under
  `~/.ensemble/pi/worker/<repoKey>/<workerKey>/`.

The builtin mode does not require a global Pi CLI installation or a prepared
`~/.pi` directory. Pi still needs provider credentials. It uses credentials
already available to the Pi runtime, including supported provider environment
variables and `~/.ensemble/pi/auth.json`. The existing `ensemble auth login`
command writes this file when the selected conductor backend is Pi; with the
default Cursor backend, `--provider` alone does not select Pi authentication.
If Pi reports no available models, ACP attach fails with `AUTH_REQUIRED`; this
package cannot provide a provider account or credential. Builtin mode requires
Node.js 22.19.0 or later.

The bundled settings are copied to the Pi user directory only when
`settings.json` does not exist. Existing user settings are preserved. The Pi
model catalog comes from the pinned `@earendil-works/pi-coding-agent`
dependency; project model selection can be supplied through
`acp.models` / `acp.tags`.
