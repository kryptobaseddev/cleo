# Contributing

## Releasing

From a clean working copy, run [`npm version major|minor|patch|VERSION`][npm-version].
This will bump the package version, commit, tag, and push.
The tag-push event triggers the release workflow on GitHub.
The workflow creates a GitHub Release from the tag and publishes to npm.

It is preferred for these version commits and tags to be signed by git.  This
not only aids with provenance, but the act of signing the tag also ensures
these release tags are [annotated tags][], not [lightweight tags][].  First be
sure git is [configured for signing][git signing].  Then either tell git to
sign _all_ tags with [`tag.gpgSign = true`][tag.gpgSign] (recommended), or
configure npm to sign its tags with [`sign-git-tag = true`][sign-git-tag].

[npm-version]: https://docs.npmjs.com/cli/v11/commands/npm-version
[annotated tags]: https://git-scm.com/book/en/v2/Git-Basics-Tagging#_annotated_tags
[lightweight tags]: https://git-scm.com/book/en/v2/Git-Basics-Tagging#_lightweight_tags
[git signing]: https://git-scm.com/book/en/v2/Git-Tools-Signing-Your-Work
[tag.gpgSign]: https://git-scm.com/docs/git-config#Documentation/git-config.txt-taggpgSign
[sign-git-tag]: https://docs.npmjs.com/cli/v11/using-npm/config#sign-git-tag
