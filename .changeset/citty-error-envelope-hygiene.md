---
id: citty-error-envelope-hygiene
tasks: [T12184]
kind: fix
summary: A citty error no longer emits a doubled E_ prefix, raw ANSI inside the JSON envelope, or a fix line that withholds the subcommands
---

Three defects in one block, all on the path an agent reaches for **after**
something else has already gone wrong. Measured on 2026.9.1 with
`cleo issue "a bare title probe"` — `issue` is a real command and the quoted
string is not one of its four subcommands. The envelope came back with
`codeName: "E_E_UNKNOWN_COMMAND"`, a `message` carrying the escape bytes citty
wraps around the offending token, and `fix: "Run 'cleo <command> --help' to see
required arguments."`

1. **`E_E_UNKNOWN_COMMAND`.** The prefix was applied unconditionally, with one
   special case for `EARG`. Citty's codes are not uniformly prefixed — `EARG` is
   bare, `E_UNKNOWN_COMMAND` already carries the prefix. Agents are told to
   branch on `codeName`, and every documented code has exactly one `E_`, so a
   lookup table built from the docs misses this entirely. Prefixing is now
   conditional.

2. **Raw ANSI inside a JSON envelope field.** ADR-086 makes stdout exactly one
   parseable envelope. Citty colours the offending token inside its own
   message, and that message went in verbatim — escape bytes mid-string, which
   then land in whatever log, issue body or task description an agent writes the
   message into. The comment directly above the callsite already reasons about
   stdout purity: it guards against citty's usage BLOCK reaching stdout, and
   missed that its MESSAGE carries colour. Colour belongs to the human renderer,
   not to the envelope.

3. **A `fix` line that withholds what the command knows.** Every citty error got
   the same note about required arguments — including the case where the caller
   named a group correctly and a verb wrongly, where the actionable hint is the
   verb list. An unknown subcommand now gets one, with a worked example. This
   repo fixed the same shape in T12127 / gh#1231, which is why a wrong `--field`
   costs one read instead of a guessing round.

The helpers live in their own module rather than in `index.ts`, for the reason
`resolve-subcommand.ts` gives: `index.ts` ends in `void bootstrap()`, so
importing it from a unit test starts the CLI. A helper that cannot be imported
cannot be tested.

Closes gh#1391.
