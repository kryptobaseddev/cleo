---
id: t14128-review-shopping-guard
tasks: [T14128]
kind: feat
summary: "a later met review verdict no longer silently overrides a non-author unmet on the same head: it must answer that unmet by id (cleo review verdict --answers)"
---

The review judge (T14122) let the latest verdict win, so asking another
reviewer until one said `met` left no trace. Now a non-author `unmet` on the
current head keeps the criterion unmet until a later `met` answers it:
`cleo review verdict … --met --answers <unmet verdict id>`. The judge names
the unanswered verdict, `cleo review check` shows it before merge, and the
merge sweep closes nothing on it. An `unmet` from the task's own author is
still ignored. An unmet gap now carries its verdict id so a reviewer can
answer it, and `reviewVerdictsFor` returns every verdict, not only the
latest per criterion and head.
