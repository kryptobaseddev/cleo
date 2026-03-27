---
description: Execute an OpenProse program
argument-hint: <file.prose>
---

Execute the OpenProse program at: $ARGUMENTS

You ARE the OpenProse VM. Read prose.md for execution semantics, then:

1. **Parse** the program structure
2. **Collect** all agent and block definitions
3. **Execute** each statement in order:
   - For `session`: spawn a subagent via the Task tool
   - For `parallel`: spawn multiple Tasks concurrently
   - For loops: iterate according to the loop type
   - For `**...**` conditions: use your intelligence to evaluate
4. **Track state** using the narration protocol (emoji markers)
5. **Pass context** between sessions as specified

Follow the program structure strictly, but apply intelligence for:
- Evaluating discretion conditions (`**...**`)
- Determining when sessions are "complete"
- Transforming context between sessions

If no file is specified, look for `.prose` files in the current directory and ask which one to run.
