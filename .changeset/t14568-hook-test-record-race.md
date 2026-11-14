---
id: t14568-hook-test-record-race
tasks: [T14568]
kind: test
summary: Post-merge and NEXUS commit hook tests wait for the stub's whole record instead of its file appearing (gh#2901, gh#2808)
---

Both tests polled for the stub cleo's record file to exist and then read it. The shell's `>>` creates that file before `echo` writes the line, so a poll landing in the gap read an empty file and the assertion failed. The wait now ends when the file holds a whole line; assertions and wait budgets are unchanged.
