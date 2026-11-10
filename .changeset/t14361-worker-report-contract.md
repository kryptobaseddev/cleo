---
id: t14361-worker-report-contract
tasks: [T14361]
kind: feat
summary: "Spawn prompts ask for a worker report (conclusion, blocker, proof lines, at most 100 words) and cleo done --report refuses one without proof"
---

The spawn prompt's Return Format Contract now asks workers for the
`WorkerReport` shape under the compressed head line: `conclusion:`,
`blocker:` and one `proof:` line per item (`<cmd> => exit <n>`, or a PR url,
commit sha or file), at most 100 words, with detail in the PR body. The lead
closes the task with `cleo done <id> --report "<report>"`, which refuses,
before recording anything, a report with no `conclusion:` or `proof:` line
(`E_WORKER_REPORT_PROOF`, exit 61) or over 100 words, the template keys not
counted (`E_VALIDATION`, exit 6). A placeholder (`<cmd>`, `n/a`, `TBD`, `-`)
in the conclusion or a proof, a run with no command, and a command whose exit
is not 0 are refused as no proof; `blocker: None` in any case means no blocker.
The return-message validators still accept the `commits:`/`gates:` lines and
the legacy one-liner.
