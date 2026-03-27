⚠️ SUPERSEDED — This document is retained for design history only.

  The canonical CANT specification is: docs/specs/CANT-DSL-SPEC.md
  The human-readable guide is: docs/guides/CANT-REFERENCE.md
  The execution semantics are: docs/specs/CANT-EXECUTION-SEMANTICS.md

  Key differences from this vision:
  - File extensions: settled on .cant only (no .cant.agent, .cant.workflow)
  - Grammar: choice, block_def, throw_stmt added to final spec
  - Events: expanded from 16 CAAMP events to 31 (16 provider + 15 domain)
  - use keyword: changed to @import in final spec
  - Phases: 7 phases (not 6), Phase 0 = spec writing added
  - Dropped constructs: const_binding, resume_stmt (handled differently)

  ─────────────────────────────────────────────────────────────────────

  ORIGINAL DOCUMENT BELOW (unmodified for historical reference)

  ─────────────────────────────────────────────────────────────────────

  The Vision: CANT as Unified Non-Prose DSL                                                         
                                                                                                                           
  You're describing three things collapsing into one:
                                                                                                                           
  OpenProse (.prose)    → agent orchestration, sessions, parallel execution, discretion             
  Lobster (.lobster)    → deterministic pipelines, approvals, resume tokens                                                
  CLEO message protocol → directives, addressing, task refs, tags                                                          
                  ↓                                                                                                        
           CANT (.cant) → all of the above, unified, non-prose                                                             
                                                                                                                           
  The key philosophical difference from OpenProse: CANT is NOT an "interpreter spec" that tricks an LLM into simulating a  
  VM. CANT is a real language with a real parser (cant-core), a real runtime (CLEO dispatch), and real static analysis     
  (LSP). The LLM is a tool invoked by the runtime, not the runtime itself.                                                 
                                                                                                    
  This is exactly the "non-prose" advantage:                                                                               
  - Sharper attention — no syntactic sugar, every token carries meaning
  - Programmatic scalability — structured templates, not generated paragraphs                                              
  - Pattern priming — structured input → structured output                                          
  - Static analysis — an LSP can validate .cant before any LLM touches it                                                  
                                                                                                    
  ---                                                                                                                      
  CANT Language Architecture                                                                        
                                               
  Three Layers, One Grammar

  Layer 1: Message Protocol          (DONE — what cant-core does today)
    directives, addresses, task refs, tags, header/body
                                                                                                                           
  Layer 2: Instruction DSL           (NEW — agent definitions, skills, hooks)
    agent blocks, property assignment, context wiring, skill specs                                                         
                                                                                                                           
  Layer 3: Orchestration DSL         (NEW — workflows, pipelines, execution)
    sessions, parallel, pipelines, loops, conditionals, approvals, discretion                                              
                                                                                                                           
  All three layers share one grammar, parsed by one cant-core crate. A .cant file can use any combination of layers.       
                                                                                                                           
  File Types (Same Grammar, Different Entry Points)                                                                        
                                                                                                    
  .cant            generic CANT file (any layers)                                                                          
  .cant.agent      agent instruction file (Layer 2 focused)                                                                
  .cant.workflow    orchestration workflow (Layer 3 focused)                                                               
  .cant.pipeline   deterministic pipeline (Layer 3, no discretion)                                                         
  .cant.skill      skill definition                                                                                        
                                                                                                    
  Or just .cant for everything — the parser detects mode from content.                                                     
                                                                                                    
  Grammar Design (Extended BNF)                                                                                            
                                                                                                    
  Here's what the full grammar looks like. This extends the existing message BNF with instruction and orchestration        
  constructs:                                                                                       
                                                                                                                           
  # ═══════════════════════════════════════════════════════                                         
  # CANT Grammar v2 — Full DSL                 
  # ═══════════════════════════════════════════════════════                                                                
                                                                                                                           
  # ── Document ──────────────────────────────────────────                                                                 
  document       ::= frontmatter? statement*                                                                               
  frontmatter    ::= "---" NEWLINE meta_field* "---" NEWLINE                                                               
  meta_field     ::= KEY ":" VALUE NEWLINE                                                                                 
                                                                                                                           
  # ── Statements ────────────────────────────────────────                                                                 
  statement      ::= import_stmt | agent_def | skill_def | hook_def                                 
                   | workflow_def | pipeline_def | block_def                                                               
                   | session_stmt | resume_stmt | parallel_block                                                           
                   | loop_stmt | conditional | try_block                                                                   
                   | let_binding | const_binding | output_binding                                                          
                   | directive_stmt | approve_stmt                                                                         
                   | throw_stmt | comment                                                           
                                                                                                                           
  # ── Layer 1: Message Protocol ─────────────────────────                                                                 
  directive_stmt ::= "/" VERB element*         
  element        ::= address | task_ref | tag | TEXT                                                                       
  address        ::= "@" IDENTIFIER                                                                                        
  task_ref       ::= "T" DIGITS                
  tag            ::= "#" IDENTIFIER                                                                                        
  approve_stmt   ::= "/approve" TOKEN                                                                                      
                                               
  # ── Layer 2: Instruction DSL ──────────────────────────                                                                 
  import_stmt    ::= "use" STRING ("as" NAME)?                                                      
  agent_def      ::= "agent" NAME ":" INDENT property* DEDENT                                                              
  skill_def      ::= "skill" NAME ":" INDENT property* DEDENT                                                              
  hook_def       ::= "on" EVENT ":" INDENT statement* DEDENT                                                               
                                                                                                                           
  property       ::= "model:" MODEL_ID                                                              
                   | "prompt:" STRING                                                                                      
                   | "persist:" PERSIST_SCOPE                                                                              
                   | "context:" context_expr   
                   | "retry:" NUMBER                                                                                       
                   | "backoff:" BACKOFF_STRATEGY                                                                           
                   | "skills:" "[" STRING* "]" 
                   | "permissions:" INDENT permission* DEDENT                                                              
                   | "timeout:" DURATION                                                                                   
                   | "approval:" APPROVAL_LEVEL
                   | CUSTOM_KEY ":" VALUE                                                                                  
                                                                                                    
  context_expr   ::= NAME | "[" NAME ("," NAME)* "]" | "{" NAME ("," NAME)* "}"                                            
                                                                                                    
  # ── Layer 3: Orchestration DSL ────────────────────────                                                                 
                                                                                                    
  # Workflows (may contain sessions — LLM-involved)                                                                        
  workflow_def   ::= "workflow" NAME params? ":" INDENT statement* DEDENT
                                                                                                                           
  # Pipelines (deterministic — NO sessions, NO discretion)                                          
  pipeline_def   ::= "pipeline" NAME ":" INDENT step* DEDENT                                                               
  step           ::= "step" NAME ":" INDENT step_prop* DEDENT                                                              
  step_prop      ::= "command:" STRING | "stdin:" REF
                   | "approval:" APPROVAL_LEVEL | "condition:" EXPR                                                        
                                                                                                                           
  # Sessions (LLM invocation — the ONLY place prose enters)                                                                
  session_stmt   ::= "session" (STRING | ":" NAME) properties?                                                             
  resume_stmt    ::= "resume" ":" NAME properties?                                                                         
                                                                                                    
  # Parallel execution                                                                                                     
  parallel_block ::= "parallel" modifiers? ":" INDENT branch* DEDENT                                
  modifiers      ::= "(" modifier ("," modifier)* ")"                                                                      
  modifier       ::= "all" | "first" | "any" | "count:" N
                   | "on-fail:" FAIL_POLICY                                                                                
  branch         ::= (NAME "=")? statement                                                                                 
                                                                                                                           
  # Control flow                                                                                                           
  loop_stmt      ::= "repeat" N ("as" NAME)? ":" INDENT statement* DEDENT                           
                   | "for" NAME "in" collection ":" INDENT statement* DEDENT                                               
                   | "parallel" "for" NAME "in" collection ":" INDENT statement* DEDENT                                    
                   | "loop" condition? ("(" "max:" N ")")? ":" INDENT statement* DEDENT                                    
  condition      ::= ("until" | "while") discretion                                                                        
                                                                                                                           
  conditional    ::= "if" discretion ":" INDENT statement* DEDENT elif* else?                                              
                   | "choice" discretion ":" INDENT option* DEDENT                                  
  elif           ::= "elif" discretion ":" INDENT statement* DEDENT                                                        
  else           ::= "else:" INDENT statement* DEDENT                                               
  option         ::= "option" STRING ":" INDENT statement* DEDENT                                                          
                                                                                                    
  # Error handling                                                                                                         
  try_block      ::= "try:" INDENT statement* DEDENT catch? finally?                                
  catch          ::= "catch" ("as" NAME)? ":" INDENT statement* DEDENT                                                     
  finally        ::= "finally:" INDENT statement* DEDENT
  throw_stmt     ::= "throw" STRING?                                                                                       
                                                                                                    
  # Bindings                                                                                                               
  let_binding    ::= "let" NAME "=" expression                                                      
  const_binding  ::= "const" NAME "=" expression                                                                           
  output_binding ::= "output" NAME "=" expression
                                                                                                                           
  # Block (reusable)                                                                                                       
  block_def      ::= "block" NAME params? ":" INDENT statement* DEDENT
  params         ::= "(" NAME ("," NAME)* ")"                                                                              
                                                                                                    
  # ── Primitives ────────────────────────────────────────                                                                 
  discretion     ::= "**" TEXT "**" | "***" TEXT "***"
  STRING         ::= '"' ... '"' | '"""' ... '"""'                                                                         
  VERB           ::= [a-z][a-z0-9-]*                                                                
  IDENTIFIER     ::= [a-zA-Z][a-zA-Z0-9_-]*                                                                                
  NAME           ::= [a-zA-Z_][a-zA-Z0-9_-]*                                                                               
  DIGITS         ::= [0-9]+                                                                                                
  MODEL_ID       ::= "opus" | "sonnet" | "haiku" | STRING                                                                  
  PERSIST_SCOPE  ::= "true" | "project" | "user" | STRING                                                                  
  APPROVAL_LEVEL ::= "required" | "optional" | "skip"                                                                      
  BACKOFF_STRATEGY ::= "none" | "linear" | "exponential"                                                                   
  FAIL_POLICY    ::= "fail-fast" | "continue" | "ignore"                                                                   
  EVENT          ::= [a-zA-Z][a-zA-Z0-9_.]*                                                         
  DURATION       ::= DIGITS ("ms" | "s" | "m")                                                                             
  comment        ::= "#" TEXT                                                                                              
                                                                                                                           
  What This Looks Like in Practice                                                                                         
                                                                                                    
  Agent instruction file (ops-lead.cant):                                                                                  
  ---                                                                                               
  kind: agent                                                                                                              
  version: 1                                                                                        
  ---                                          
                                                                                                                           
  agent ops-lead:
    model: opus                                                                                                            
    persist: project                                                                                
    prompt: "You coordinate operations, never implement directly"
    skills: ["ct-cleo", "ct-orchestrator"]                       
    permissions:                                                                                                           
      tasks: read, write                                                                                                   
      session: read, write                                                                                                 
      memory: read                                                                                                         
                                                                                                    
  on SessionStart:                                                                                                         
    /checkin @all                                                                                                          
    session "Review current sprint state"      
      context: [active-tasks, recent-decisions]                                                                            
                                                                                                                           
  on TaskComplete:                                                                                                         
    if **the completed task unblocks other agents**:                                                                       
      /action @all T{completed.id} #unblocked                                                                              
    else:                                                                                                                  
      /info @all T{completed.id} #shipped                                                                                  
                                                                                                                           
  Workflow file (code-review.cant):                                                                                        
  ---                                                                                               
  kind: workflow                                                                                                           
  version: 1                                                                                        
  ---                                          
     
  use "security-scan" as scanner
  use "style-check" as styler                                                                                              
                             
  agent reviewer:                                                                                                          
    model: opus                                                                                     
    prompt: "Expert code reviewer, focus on correctness and edge cases"                                                    
                                                                                                    
  agent quick-check:                                                                                                       
    model: haiku                                                                                                           
    prompt: "Fast lint and style check"                                                                                    
                                                                                                                           
  workflow review(pr_url):                                                                          
    # Deterministic pipeline first (no LLM, no discretion)                                                                 
    pipeline checks:                                      
      step fetch:                                                                                                          
        command: "gh pr diff {pr_url}"                                                              
      step lint:                                                                                                           
        command: "biome check --json"                                                                                      
        stdin: fetch                           
      step test:                                                                                                           
        command: "pnpm test --json"                                                                                        
                                               
    # Parallel LLM review (sessions = only place LLM enters)                                                               
    parallel:                                                                                                              
      security = scanner(target: pr_url)       
      style = session: quick-check                                                                                         
        prompt: "Review style issues"                                                               
        context: checks                                                                                                    
      depth = session: reviewer                                                                     
        prompt: "Deep review for logic errors and edge cases"                                                              
        context: checks                                                                                                    
                                               
    # AI-evaluated conditional                                                                                             
    if **all reviews pass with no critical issues**:                                                                       
      /done T{pr.task_id} #shipped                  
      output verdict = "approve"                                                                                           
    elif **security issues found**:                                                                                        
      /blocked T{pr.task_id} #security                                                                                     
      /review @human "Security issues require manual review"                                                               
      output verdict = "block"                                                                                             
    else:                                                                                                                  
      /action @author "Address review feedback"                                                                            
      output verdict = "changes-requested"                                                                                 
                                                                                                                           
  Deterministic pipeline (deploy.cant):                                                             
  ---                                                                                                                      
  kind: pipeline                                                                                    
  version: 1                                   
  ---       
                                                                                                                           
  pipeline deploy:
    step build:                                                                                                            
      command: "pnpm run build"                                                                     
      timeout: 120s                            
                   
    step test:                                                                                                             
      command: "pnpm run test"
      stdin: build                                                                                                         
      timeout: 300s                                                                                 
                                               
    step stage:
      command: "railway deploy --environment staging"
      condition: test.exit_code == 0                 
      approval: required                                                                                                   
                                                                                                                           
    step promote:                                                                                                          
      command: "railway deploy --environment production"                                                                   
      stdin: stage                                                                                  
      approval: required                       
      timeout: 60s      

  What's NOT Prose                                                                                                         
  
  Notice the design: prose only appears in two places:                                                                     
                                                                                                    
  1. Session prompts (prompt: "...") — the instruction to the LLM                                                          
  2. Discretion conditions (**...**) — AI-evaluated logic                                           
                                                                                                                           
  Everything else is strict, parseable, lintable structure. This is the non-prose philosophy:                              
  - Agent definitions → structured properties, not paragraphs                                                              
  - Control flow → keywords (parallel, if, loop), not sentences                                                            
  - References → T1234, @agent, #tag — tokens with semantic meaning                                 
  - Pipelines → deterministic steps, no LLM involvement at all                                                             
  - Context wiring → explicit context: declarations, not implicit                                                          
                                                                                                                           
  ---                                                                                                                      
  LSP Architecture                                                                                                         
                                                                                                                           
  cant-lsp (Rust binary, built from cant-core) 
  │                                                                                                                        
  ├── Diagnostics                                                                                   
  │   ├── Syntax errors (malformed blocks, bad indentation)                                                                
  │   ├── Unknown directives (not in canonical 12)                                                                         
  │   ├── Missing references (T-ref to nonexistent task, @address to unknown agent)                                        
  │   ├── Discretion in pipeline (pipelines must be deterministic — no ** **)                                              
  │   ├── Session in pipeline (pipelines can't invoke LLMs)                                                                
  │   ├── Unused bindings (let x = ... but x never referenced)                                                             
  │   └── Type mismatches (context expects array, got single)                                                              
  │                                                                                                                        
  ├── Completions                                                                                                          
  │   ├── Directive names (/claim, /done, /blocked...)                                                                     
  │   ├── Agent names (from agent definitions in scope)                                                                    
  │   ├── Task IDs (from CLEO task DB via integration)                                                                     
  │   ├── Property keys (model:, prompt:, persist:...)                                                                     
  │   ├── Event names (SessionStart, TaskComplete...)                                                                      
  │   └── Skill names (from installed skills)                                                       
  │                                                                                                                        
  ├── Hover                                                                                         
  │   ├── Directive docs ("actionable — maps to tasks.complete")                                                           
  │   ├── Agent property docs                                                                                              
  │   └── Reference resolution (T1234 → task title)
  │                                                                                                                        
  ├── Go-to-definition                                                                              
  │   ├── Agent name → agent block                                                                                         
  │   ├── Block name → block definition                                                                                    
  │   ├── Import → source file                 
  │   └── Variable → binding site                                                                                          
  │                                                                                                                        
  ├── Code actions                             
  │   ├── "Extract to block" (refactor repeated statements)                                                                
  │   ├── "Add missing context" (when binding referenced but not wired)                                                    
  │   └── "Convert to pipeline" (when workflow has no sessions/discretion)                                                 
  │                                                                                                                        
  └── Formatting                                                                                                           
      └── Canonical CANT style (consistent indentation, ordering)                                                          
                                                                                                                           
  Editor support:                              
  - VS Code extension (cant-lsp binary, .cant syntax highlighting)                                                         
  - Neovim (LSP client configuration)                                                                                      
  - In-browser (cant-core WASM for web editors)
                                                                                                                           
  ---                                                                                                                      
  Implementation Plan (Phased)                                                                                             
                                                                                                                           
  Phase 1: Grammar Foundation (extends cant-core)                                                   
                                                                                                                           
  Goal: Parse .cant files — agent defs, properties, imports, blocks.                                                       
                                                                                                                           
  Scope:                                                                                                                   
  - Extend cant-core parser from message-only to document mode                                      
  - Add frontmatter parsing (--- blocks)                                                                                   
  - Add agent/skill/hook/block definitions
  - Add property assignment                                                                                                
  - Add import statements                                                                                                  
  - Add let/const/output bindings              
  - Keep existing message parsing intact (backward compatible)                                                             
  - ~40 new Rust tests                                                                              
                                                                                                                           
  Crate changes:                                                                                                           
  cant-core/                                                                                                               
    src/                                                                                                                   
      lib.rs          → split into modules                                                          
      message.rs      → existing message parser (untouched)
      document.rs     → NEW: document-mode parser                                                                          
      ast.rs          → NEW: full AST types                                                                                
      classify.rs     → existing directive classification                                                                  
      validate.rs     → NEW: basic validation rules                                                                        
                                                                                                    
  Phase 2: Orchestration Constructs                                                                                        
                                                                                                                           
  Goal: Parse workflow/pipeline/session/parallel/conditional/loop constructs.
                                                                                                                           
  Scope:                                                                                                                   
  - Session statements with properties         
  - Parallel blocks with modifiers and branches                                                                            
  - Pipeline definitions with deterministic steps                                                   
  - Workflow definitions                         
  - Conditional blocks (if/elif/else, choice)                                                                              
  - Loop blocks (repeat, for, loop until)    
  - Try/catch/finally                                                                                                      
  - Discretion conditions (**...**)                                                                 
  - Context expressions                                                                                                    
  - ~60 new tests                                                                                                          
                                               
  Phase 3: Validation & Static Analysis                                                                                    
                                                                                                                           
  Goal: Build the analysis layer that powers the LSP.                                                                      
                                                                                                                           
  Scope:                                                                                                                   
  - Scope analysis (which names are visible where)                                                  
  - Reference resolution (agent refs, block refs, variable refs)
  - Pipeline purity checking (no sessions, no discretion in pipelines)
  - Unused binding detection                                                                                               
  - Missing context warnings                                                                                               
  - Circular dependency detection                                                                                          
  - Type consistency (context shapes)                                                                                      
  - ~30 validation rules                                                                                                   
                                               
  Phase 4: LSP Server                                                                                                      
                                                                                                                           
  Goal: Ship cant-lsp binary.                  
                                                                                                                           
  Scope:                                                                                            
  - LSP protocol implementation (tower-lsp crate)
  - Diagnostics (from Phase 3 validators)                                                                                  
  - Completions (directives, properties, agent names)
  - Hover documentation                                                                                                    
  - Go-to-definition                                                                                
  - Formatting                                                                                                             
  - VS Code extension with syntax highlighting                                                      
                                                                                                                           
  Phase 5: Runtime Integration
                                                                                                                           
  Goal: CLEO dispatch executes .cant files.                                                                                
                                               
  Scope:                                                                                                                   
  - @cleocode/cant gains document parsing (WASM from Phase 1-2)                                     
  - @cleocode/core imports @cleocode/cant for directive-to-operation mapping                                               
  - NEXUS routes CANT operations to CQRS gateways                           
  - Pipeline executor (deterministic, no LLM)                                                                              
  - Workflow executor (orchestrates sessions via CLEO dispatch)                                                            
  - Approval gate / resume token system                                                                                    
                                                                                                                           
  Phase 6: Migration & Adoption                                                                                            
                                                                                                                           
  Goal: Convert existing instruction formats to .cant.                                                                     
                                                                                                    
  Scope:                                                                                                                   
  - cant migrate CLI command (Markdown instructions → .cant)
  - AGENTS.md can @import .cant files                                                                                      
  - Skill definitions in .cant format                                                               
  - Hook configurations in .cant format                                                                                    
  - Documentation and examples                                                                      
                                                                                                                           
  ---                                                                                                                      
  What CANT Absorbs vs. What Stays Separate    
                                                                                                                           
  ┌───────────────────────────┬──────────────────────────┬─────────────────────────────────────────────────────┐
  │          Concept          │       CANT Absorbs       │                   Stays Separate                    │           
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤
  │ Agent instructions        │ Yes — .cant agent blocks │                                                     │           
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤
  │ Workflow orchestration    │ Yes — workflow construct │                                                     │           
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤
  │ Deterministic pipelines   │ Yes — pipeline construct │                                                     │           
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ Skill definitions         │ Yes — skill blocks       │                                                     │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ Hook configurations       │ Yes — on Event: blocks   │                                                     │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ Message protocol          │ Yes — directive syntax   │                                                     │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ LAFS response envelopes   │                          │ lafs-core (response format, not instruction format) │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ Conduit transport         │                          │ conduit-core (wire protocol, not content)           │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ Task state/LOOM lifecycle │                          │ CLEO core (state machine, not instruction)          │
  ├───────────────────────────┼──────────────────────────┼─────────────────────────────────────────────────────┤           
  │ Config files              │                          │ JSON config (not instruction-level)                 │
  └───────────────────────────┴──────────────────────────┴─────────────────────────────────────────────────────┘           
                                                                                                    
  ---                                                                                                                      
  Is This Fully Scoped?                                                                             
                                                                                                                           
  No. What exists today (message parsing) is a solid foundation, but the DSL vision needs:
                                                                                                                           
  1. Grammar specification — the extended BNF above is a draft, needs formal review                                        
  2. AST design — what data structures represent parsed .cant files                                                        
  3. Semantic rules — what's valid/invalid beyond syntax (e.g., pipeline purity)                                           
  4. Runtime model — how does CLEO dispatch execute a .cant workflow? Is it event-driven? Step-by-step?                    
  5. Discretion evaluation — how exactly does **...** get evaluated? Which LLM? What context?                              
  6. Approval/resume — where do tokens live? How do they integrate with CLEO sessions?                                     
  7. Import resolution — how does use "security-scan" resolve? Local file? Registry? URL?                                  
                                                                                                                           
  The grammar design is the hard part. The implementation follows naturally from a good grammar. I'd recommend writing the 
  formal spec first (a CANT-DSL-SPEC.md), getting it reviewed, then implementing in phases.
