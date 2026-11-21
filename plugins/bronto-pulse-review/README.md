# Bronto Pulse Review

A local plugin for reviewing an existing private Pulse installation from a
coding assistant. It bundles the `pulse-project-review` skill and launches
the source build's read-only MCP tools.

This is a **source-preview pilot package**. The instructions below use a source
checkout containing this plugin; they do not require or announce a new npm
release. The repository does not install the plugin into an account, provide a
hosted subscription or publish a public directory listing. A web installation
cannot run this local process.

## Build the source and initialize a first database

Use Node.js 24.15 or newer. After these changes are merged, a new checkout can
start with:

```sh
git clone https://github.com/Ponchia/bronto-pulse.git
cd bronto-pulse
npm ci
npm run demo
```

For an existing checkout, start from its repository root and use a revision
containing this plugin and the `mcp` command. `npm ci` runs the package's
`prepare` script, which invokes `npm run build` to create `dist/cli.js`.
The demo then creates an initialized, registered **synthetic** database at
`.pulse/demo.db` and its matching `.pulse/demo.config.json`. It makes no
provider requests.

From that repository root, set absolute paths in the same terminal that will
launch the client:

```sh
export PULSE_CLI_PATH="$(pwd)/dist/cli.js"
export PULSE_CONFIG_PATH="$(pwd)/.pulse/demo.config.json"
export PULSE_DB_PATH="$(pwd)/.pulse/demo.db"
```

For your own projects, first complete the
[private setup workflow](https://github.com/Ponchia/bronto-pulse/blob/main/docs/quickstart.md#configure-a-real-installation)
or an explicit archive restore, then replace the two data paths with the
existing installation's absolute paths:

```sh
export PULSE_CONFIG_PATH="/private/pulse/pulse.config.json"
export PULSE_DB_PATH="/private/pulse/pulse.db"
```

Keep the synthetic and real databases separate. The configuration and database
must already exist and agree. The MCP process opens the database read-only;
it does not initialize, migrate or collect. The launcher starts the configured
CLI with `mcp --config ... --db ...`, without downloading an npm package,
loading an environment file or starting a collector. It passes only a small
operating-system environment to the child, excluding provider credentials and
Node preload options.

Keep credentials out of plugin manifests. Local report results are supplied
to the AI client you connect; apply that client's data controls.

## Install in Codex

Use a Codex client with the `codex plugin` commands. From the repository root
and the terminal containing the path variables above:

```sh
codex plugin marketplace add "$(pwd)"
codex plugin add bronto-pulse-review@bronto-pulse-local
codex
```

The first command registers this checkout's local marketplace. The second
installs the source plugin in the local client. These are owner-run client
configuration changes, not publication to a public marketplace. The repository's
`.agents/plugins/marketplace.json` marks the package as **AVAILABLE**; its
presence alone does not install or enable it.

Portable clients use the package's `plugin.json`, `mcp.json` and `skills/`.
Keep the source checkout and the three absolute paths available when launching
the client.

## Load in Claude Code

From the same repository root and environment:

```sh
claude --plugin-dir "$(pwd)/plugins/bronto-pulse-review"
```

This loads the plugin for that session. The Claude compatibility manifest uses
`.mcp.json` and the same included launcher. Do not substitute a plugin cache
path into the manifests.

After either client connects, ask it to list the configured projects. With the
synthetic database, then ask:

> Review Bronto UI over the last 30 completed days. What changed, what remains
> uncertain, and which check is useful next?

For a private hosted installation, configure a direct authenticated remote
connection instead of this local launcher. See the repository's
[agent integration guide](https://github.com/Ponchia/bronto-pulse/blob/main/docs/agent-review.md).
Do not configure both connections for the same question unless you deliberately
need to compare installations.

## Validate the package

From a source checkout:

```sh
claude plugin validate ./plugins/bronto-pulse-review --strict
node --test tests/plugin-package.test.mjs
```

These checks do not install a plugin, contact analytics providers or submit
a directory listing. Structural validation alone does not establish a connected
client's end-to-end interaction.
