# @cleocode/cleo

> Part of [CLEO](https://github.com/kryptobaseddev/cleo#readme). Start with the root README; run `cleo <command> --help` for any command.

The `cleo` command-line interface: tasks, evidence gates, pull-request closing,
docs, memory (BRAIN), code intelligence (Nexus) and release, for AI coding
agents and the people who work with them. Every call prints one JSON envelope
on stdout; logs and progress go to stderr.

## Install

```bash
npm install -g @cleocode/cleo
```

Requires Node.js >= 24.16.0. The package installs the `cleo` binary (and `ct`
as an alias) and pulls in `@cleocode/core`, the SDK it is built on.

## Quick start

```bash
cd your-project
cleo init
cleo session start --scope global --name "first session"
cleo saga create --title "Ship the auth hardening" --acceptance "login is rate limited|sessions expire"
cleo next
```

The full quick start, the pull-request flow and the docs workflow are in the
[root README](https://github.com/kryptobaseddev/cleo#readme).

## Finding commands

The command set changes between releases, so this README does not list it.
Ask the CLI:

```bash
cleo <command> --help          # flags and usage for one command
cleo <command> <sub> --help    # for a sub-command, e.g. cleo docs update --help
```

Command output is JSON by default. `--field <json-pointer>` extracts one value,
`--output id|count|table|silent` changes the shape, and `--human` renders for
people.

## Programmatic use

Agents and tools can call the SDK directly instead of spawning the CLI; see
[`@cleocode/core`](https://www.npmjs.com/package/@cleocode/core).

## License

MIT
