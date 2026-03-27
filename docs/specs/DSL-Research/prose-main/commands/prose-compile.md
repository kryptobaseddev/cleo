---
description: Validate and compile an OpenProse program
argument-hint: <file.prose>
---

Compile and validate the OpenProse program at: $ARGUMENTS

Use the compiler.md specification as your compiler and validator:

1. **Parse** the program according to the syntax grammar
2. **Validate** that the program is well-formed:
   - Check syntax correctness (all constructs match grammar)
   - Check semantic validity (references resolve, types match)
   - Check self-evidence (program is clear without full spec)
3. **Report** any errors or warnings with line numbers
4. **Output** the canonical form if valid

Do NOT execute the program. This is static analysis only.

If no file is specified, look for `.prose` files in the current directory and ask which one to compile.
