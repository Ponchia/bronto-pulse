# Bronto Pulse Review

A local plugin for reviewing an existing private Pulse installation from a
coding assistant. It bundles the `pulse-project-review` skill and launches
the source build's read-only MCP tools.

This is a **source-preview pilot package**. It is not installed into an account
by this repository, is not a hosted subscription, and has not been approved for
a public plugin directory. A web installation cannot run this local process.

## Prepare the local runtime

Use Node.js 24.15 or newer and build a source revision containing the
`pulse mcp` command. Configure and collect a private installation separately.

Set these absolute paths in the environment that launches the client:

```sh
export PULSE_CLI_PATH="/absolute/path/to/bronto-pulse/dist/cli.js"
export PULSE_CONFIG_PATH="/private/pulse/pulse.config.json"
export PULSE_DB_PATH="/private/pulse/pulse.db"
```

The configuration and database must already exist. The launcher checks these
paths and starts the actual CLI with `mcp --config ... --db ...`. It does not
download an npm package, load an environment file or start a collector. It
passes only a small operating-system environment to the child, excluding
provider credentials and Node preload options.

Keep credentials out of plugin manifests. Local report results are supplied
to the AI client you connect; apply that client's data controls.

## Load the package

Current portable clients discover `plugin.json`, `mcp.json` and `skills/`.
The repository includes a local OpenAI marketplace entry marked available,
without automatically installing or enabling it.

For Claude Code, from the repository root:

```sh
claude --plugin-dir ./plugins/bronto-pulse-review
```

The Claude compatibility manifest uses `.mcp.json` and the same included
launcher. Do not substitute a plugin cache path into the manifests.

After the client connects, verify tool discovery and ask to list the configured
projects before reading a real report. Try the skill with a routine review,
a release question or a focused investigation. A local manifest validation
does not establish that a connected client's end-to-end interaction works.

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
a directory listing.
