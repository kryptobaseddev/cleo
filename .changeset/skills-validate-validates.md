---
id: skills-validate-validates
tasks: [T12655]
kind: fix
summary: `cleo skills validate` now validates the SKILL.md and exits non-zero with findings
---

`cleo skills validate <name>` dispatched `tools.skill.verify`, which only
reported whether the skill was installed and catalogued. It returned success
for any input, including a SKILL.md with no description or broken YAML, so the
command named "validate" validated nothing.

It now takes a skill name, a skill directory or a SKILL.md path. A path is used
as given. A name resolves to the installed skill, else to the catalog copy. The
file is checked against the Agent Skills standard with CAAMP's `validateSkill`,
the same check `caamp skills validate` runs:

- the YAML must parse;
- `name` and `description` must be present and well-formed;
- the name must not be reserved.

`name` must also equal its directory. Any error-level finding fails with
`E_VALIDATION` (exit 6), with every finding in `error.details`. An unresolvable
target fails with `E_NOT_FOUND`. The result still reports `installed`,
`inCatalog` and `installPath`.
