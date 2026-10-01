---
id: t12798-wire-refs
tasks: [T12798]
kind: fix
summary: A row received by sync never carries another row's local key; every reference travels as a uid and fingerprint, and a row whose target is missing waits (row uids, opt-in)
---

The receive contract behind row uids (T12341) translated only plain
reference columns. Other references were sent as raw local keys:
- an evidence binding's `ac_id`, and the criterion uid it records (`ac_uid`);
- an AC history row's `ac_id`;
- a session's `tasks_created_json` and `tasks_completed_json` arrays.

A raw local key means a different row on the receiving device. So a binding
could attach evidence to the wrong criterion, and a session could list the
wrong tasks.

- Those columns are now left out of the row's values. They travel as
  references: uid plus birth fingerprint, element by element for the arrays.
- The receiver resolves each reference to its own local row.
- A row whose target is not there yet waits in the identity quarantine and
  is placed once the target arrives. That includes a target the sender
  itself could not find.

Nothing changes while row uids are off (the default).

What happens when the sender no longer has the row a reference names:
- **Id arrays.** The dangling id is dropped from the array.
- **AC history.** An AC history row whose criterion was deleted is still
  placed. It carries the criterion's uid, and its `ac_id` names no live
  criterion (`gone:<uid>`).
- **Optional reference columns.** They are set to NULL.
- **Everything else.** The row waits.

A reference to a minted row is only matched on uid AND birth fingerprint, so
a uid without a fingerprint never attaches to whatever row holds that uid
here. Wire rows carry a format version (2). A row from an older sender,
whose values hold raw local keys, is held (`unsupported-wire`) instead of
applied or silently stripped.

