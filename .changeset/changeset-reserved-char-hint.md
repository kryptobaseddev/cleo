---
id: changeset-reserved-char-hint
tasks: [T12351]
kind: fix
summary: "`lint-changesets` names the fix for a value starting with a YAML-reserved character: wrap it in double quotes"
---

A changeset `summary:` starting with a backtick failed with the parser's bare
"Plain value cannot start with reserved character `", and it tripped three
authors in one day. The error now ends with the exact line to write:

    hint: 'summary' starts with the YAML-reserved character '`' — wrap the value in double quotes: summary: "`cleo show` works"

The hint covers every leading character that YAML reads as syntax rather than
text: `` ` `` `@` `%` `|` `>` `*` `&` `!` `#`. It escapes inner quotes and
backslashes. A bare block-scalar header such as `summary: >-` is still
accepted.

Three of those characters used to parse without any error and silently drop
text: `&` (anchor), `!` (tag) and `#` (comment). `summary: &x fixed` was read
as "fixed". They are now rejected with the same hint rather than accepted.
YAML parsing itself is not relaxed: the quoted form is the fix.

(This entry's own summary starts with a backtick, which is why it is quoted.)
