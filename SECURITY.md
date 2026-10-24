# Security

LLM-Super-Bench is a tool for a trusted home or lab network. See the **Security** section of the
[README](README.md) for what it protects against and what it does not (in short: set `RACE_PASSWORD`, keep the
port off the internet, use a private network such as Tailscale).

## Reporting a problem

Please report security problems privately, not in a public issue:
**Security tab → Report a vulnerability** on this repository. Include what you did, what you expected, and what
happened. Do not include your real network addresses or passwords.

## What is in scope

The server (`src/server.ts` and what it serves), the results page and the run files it reads, and the commands
in `package.json`. The inherited benchmark suite's extra pages are read-only and unauthenticated by design.
