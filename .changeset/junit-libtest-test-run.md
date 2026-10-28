---
id: junit-libtest-test-run
tasks: [T14084]
kind: feat
summary: "test-run evidence reads JUnit XML (cargo nextest, pytest) and libtest JSON lines (cargo test)"
---

The T14041 audit found 21 owner overrides (Rust and Python suites) whose
runner wrote a report CLEO could not read as `test-run:` evidence. CLEO read
only vitest/jest, Playwright, summary and node --test JSON.

`test-run:<path>` now also accepts two formats:

- JUnit XML, written by cargo nextest, pytest `--junitxml` and most other
  runners. Each `<testcase>` is one test: a `<failure>` or `<error>` fails
  it, and `<skipped>` makes it pending. A test's file comes from its `file`
  attribute. Suite totals must match the testcases.
- libtest JSON lines, written by `cargo test --format json` or
  `nextest --message-format libtest-json`. Each finished `test` event counts
  once, and suite summaries must match the events.

Both formats go through the same counter checks and the same binding (HEAD,
tree hash, covered files) as a vitest report.
