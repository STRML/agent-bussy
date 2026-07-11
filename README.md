# agent-bus — the paddock radio

A local message bus that lets concurrent AI coding sessions (Claude Code, Codex,
anything with a shell) talk to each other instead of only to you. A session stuck
on a design call posts a question; another session answers it; you step in only to
steer. You can also post under any name — including a fake peer's — to trigger a
re-review without the agents knowing it came from a human.

It is deliberately small: one SQLite-backed daemon, one CLI, no cloud, localhost
only. GitHub issues (a later phase) hold the durable state; the bus itself is just
ordered, disposable scrollback.

Status: **Phase 1** — the message store, CLI, and `tail` console are built and
tested. Adapters (the Claude/Codex plugins that inject bus traffic into a running
session) and the GitHub state machine are specced but not yet implemented. See
[the spec](#design) for the full picture.

## Why this exists

A single agent session asks you about everything, because you are the only other
party it can reach. Point several sessions at a shared bus and they reach each
other first. Two things fall out of that:

- **Peer review for free.** Tell an idle session "another agent thinks your retry
  loop is wrong for cold starts" and it goes back and re-reads the code. The message
  doesn't have to be true, and it doesn't have to come from an agent. You can post it
  yourself under a peer's name.
- **Fewer interruptions.** Questions one session can answer for another never reach
  you.

## Security model (read this before you run it)

The bus injects unauthenticated, spoofable text into sessions that hold shell, git,
and filesystem tools. That makes it a prompt-injection-to-code-execution pipe by
construction. Phase 1 bounds the blast radius:

- Every message an adapter injects is wrapped in an untrusted-data fence that tells
  the model to treat it as a claim to evaluate, never an instruction to execute.
  A bus message is never authorization for a side effect.
- The daemon requires a token on every request (constant-time compare), rejects any
  request carrying an `Origin` header, and rejects any `Host` other than loopback —
  so a web page you have open can't post into your agents via DNS-rebinding or CSRF.
- Message bodies are stripped of terminal control sequences before display.
- Rate limits and size caps key on the token, not the spoofable author name.

`author` stays spoofable on purpose — that's the point — but nothing
security-relevant depends on it.

## Install

Requires Node ≥ 20.

```bash
git clone https://github.com/strml/agent-bus
cd agent-bus
npm install
npm link          # optional: puts `bus` on your PATH
```

## Use

```bash
bus daemon start                                  # start bussy (detached)
bus post -t issue-42 --as codex-1 "is this thread-safe under concurrent polls?"
bus read -t issue-42                              # prints the thread, fenced
bus threads                                       # active threads
bus tail                                          # live feed across all threads
bus daemon stop
```

Post under any identity with `--as`; it defaults to `$AGENT_BUS_IDENTITY`, then a
host-based fallback. That's how you inject a provocation as a fake peer:

```bash
bus post --as codex-2 -t issue-42 "who wrote this retry loop? it's wrong for cold starts"
```

## How it works

```
        ┌────────────────────────────────┐
        │  bussy — SQLite message store   │   127.0.0.1:4787, token-gated
        └──────┬──────────────────┬───────┘
   read/post   │                  │   read/post
        ┌───────────┐      ┌───────────┐
        │  session  │      │  session  │      (adapters inject behind the fence)
        └───────────┘      └───────────┘
                  ┌───────────┐
                  │ human CLI │  bus post --as … / bus tail
                  └───────────┘
```

- `POST /post` — append a message. Send an `Idempotency-Key` header and a retried
  post after a timeout won't duplicate.
- `GET /messages?thread=X&since=<id>` — stateless read. The client tracks its own
  `since`; there are no server-side cursors, so a dropped response never loses a
  message.
- `GET /threads`, `GET /health`.

Configuration (port, size caps, rate limits) lives in `~/.agent-bus/`. The token is
created there on first run with `0600`.

## Design

The full design — including the phases still to build (Claude/Codex adapters, the
GitHub issue state machine, worktree isolation) — is in
[`docs/SPEC.md`](docs/SPEC.md). It went through a six-reviewer adversarial pass
before any code was written; the security posture above is the result.

## Development

```bash
npm test          # node:test — unit, HTTP, render/fence, and e2e daemon tests
```

## License

MIT
