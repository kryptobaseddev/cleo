---
id: merged-cleanup-regenerable-scope
tasks: [T14146]
kind: fix
summary: "Merged cleanup treats dist/, .turbo/, coverage/ and *.tsbuildinfo as rebuildable only at the checkout root or a packages/<name>/ root"
---

Merged cleanup now treats `dist/`, `.turbo/`, `coverage/` and `*.tsbuildinfo`
as rebuildable only at the checkout root or at a `packages/<name>/` root, the
places the build actually writes them. Before, the same name anywhere in a
path counted, so an ignored `secrets/dist/key.pem` would have been treated as
rebuildable. It now has to match the main checkout byte for byte.
