---
id: t13159-vanished-only
tasks: [T13159]
kind: fix
summary: when the CLI cannot load the code that finishes a command, it prints the upgrade/reinstall notice only for a genuinely missing module, and any other load error as itself
---

If the code that finishes a command can't be loaded, the CLI used to say CLEO had been
upgraded or needed reinstalling, whatever the cause. It now says that only when the
module is actually missing from the installation. Any other failure, such as a syntax
error or a module that throws while loading, is printed as the real error with its
code and stack, so a bug is not mistaken for a broken install. The command's exit
code is unchanged.
