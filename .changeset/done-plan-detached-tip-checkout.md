---
id: done-plan-detached-tip-checkout
tasks: [T14059]
kind: fix
summary: "cleo done --plan accepts a clean checkout detached at the task branch tip (checkout-required false positive)"
---

`cleo done --plan` refused a branch change set with `checkout-required` when
the execution root had the exact change-set commit checked out detached, or
under any ref other than the task branch, although the tools would measure
the cited tree. The checkout check now passes whenever HEAD's sha equals the
change-set commit, whatever the ref, and the dirty-tree check covers that
checkout too. A different HEAD is still refused with the same remedy.
