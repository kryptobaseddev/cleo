# CANT DSL: Unified Non-Prose Language for CLEO

CANT DSL Migration Plan — Full Audit Report

  Audit Date: 2026-03-28 | Auditors: 8 parallel agents | Scope: All 8 phases

  ---
  1. COMPLETED

  ┌───────┬────────────────────────────────┬───────────────────────────────────────────────────────────────────┐
  │ Phase │              Item              │                             Evidence                              │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ CANT-DSL-SPEC.md               │ 115 KB, 4,076 lines, all sections present                         │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ File format definition         │ .cant universal, kind: frontmatter, 6 document modes              │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ Complete EBNF grammar (all 3   │ 608 lines, Layer 1 FROZEN                                         │
  │       │ layers)                        │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ AST type definitions with Span │ All nodes carry span: Span                                        │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ CAAMP event mapping            │ 31 total events (16 provider + 15 domain) via hook-mappings.json  │
  │       │                                │ SSoT                                                              │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ Import resolution algorithm    │ 4 forms, security constraints S09-S11                             │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ Expression language spec       │ Operators, interpolation, literals, ternary                       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ 10+ example .cant files        │ Agents, skills, workflows, pipelines, hooks, loops, error         │
  │       │                                │ handling                                                          │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ Migration guide from markdown  │ Before/after examples, conservative strategy                      │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 0     │ 5 companion specs              │ Execution semantics, implementation plan, persona MVI, TS         │
  │       │                                │ integration, vision                                               │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ crates/cant-napi/ crate        │ Cargo.toml with napi 3.x, build.rs, #[napi] exports               │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ WASM removal from cant-core    │ wasm-bindgen, js-sys, cdylib removed; wasm.rs deleted             │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ WASM removal from conduit-core │ Both wasm.rs files deleted, features removed                      │
  │       │  + lafs-core                   │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ native-loader.ts               │ Loads napi addon, sync init                                       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ parse.ts calls native addon    │ Falls back to JS implementation if unavailable                    │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ initCantParser() is no-op      │ Kept for backward compatibility                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ parseCANTMessage() signature   │ Backward compatible API                                           │
  │       │ unchanged                      │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 1     │ JS fallback parser preserved   │ Regex-based extraction at parse.ts:60-78                          │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ dsl/ directory structure       │ 25 files (14 planned + 11 Layer 3 forward-integrated)             │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ parse_document() entry point   │ Independent from parse(), separate codepath                       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ AST Span on every node         │ Verified across all AST types                                     │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ INDENT/DEDENT preprocessing    │ IndentedLine approach (functionally equivalent)                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ pub mod dsl; in lib.rs         │ Line 43, plus parse_document() re-export                          │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ parse_document() exported from │ cant_parse_document() with JsParseDocumentResult                  │
  │       │  cant-napi                     │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 2     │ CAAMP event validation in      │ 31 events validated via generated is_canonical_event()            │
  │       │ hook.rs                        │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ workflow.rs                    │ Params, all statement types in body (13 tests)                    │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ pipeline.rs                    │ Step-only enforcement, determinism validation (16 tests)          │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ session.rs                     │ Dual-mode prompt/agent, properties (13 tests)                     │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ parallel.rs                    │ Race/settle modifiers, named arms (10 tests)                      │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ conditional.rs                 │ Expression + Discretion conditions, elif/else (13 tests)          │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ loop_.rs                       │ repeat/for/loop-until with discretion support (13 tests)          │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ try_catch.rs                   │ Optional catch/finally, error binding (10 tests)                  │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ discretion.rs                  │ Prose extraction, delimiter validation (10 tests)                 │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ approval.rs                    │ Properties-based gate, duration timeout (10 tests)                │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ Statement enum                 │ 11 variants (Session, Parallel, Conditional, Repeat, ForLoop,     │
  │       │                                │ LoopUntil, TryCatch, ApprovalGate, Pipeline, PipeStep, Output)    │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 3     │ Pipeline vs Workflow           │ Pipelines enforce PipeStep-only; workflows accept any Statement   │
  │       │ distinction                    │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ validate/ directory            │ 22 files across 5 sub-modules                                     │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ ValidationEngine (validate     │ Runs all rules in dependency order, returns Vec<Diagnostic>       │
  │       │ function)                      │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Diagnostic type                │ severity, rule_id, message, span, optional fix with TextEdit      │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Scope/symbol resolution        │ Scope stack, symbol tables, binding resolution, cycle detection   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Scope rules S01-S13            │ 13 rules (plan said S01-S08)                                      │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Pipeline purity P01-P07        │ 7 rules (plan said P01-P05)                                       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Type rules T01-T07             │ 7 rules (plan said T01-T06)                                       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Hook rules H01-H04             │ 4 rules (as planned)                                              │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ Workflow rules W01-W11         │ 11 rules (plan said W01-W07)                                      │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 4     │ LSP-consumable diagnostics     │ Serializable, public API, Fix with TextEdit                       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ crates/cant-lsp/ crate         │ tower-lsp 0.20, binary crate, 8 modules                           │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ Diagnostics from validation    │ to_lsp_diagnostic() with severity/span mapping                    │
  │       │ engine                         │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ Completions                    │ Keywords, events, agents, properties, context-aware               │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ Hover                          │ Directives, events, properties, keywords with markdown docs       │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ Go-to-definition               │ Agents, skills, imports, bindings                                 │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ Document symbols               │ Outline view via document_symbols()                               │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 5     │ VS Code extension              │ TextMate grammar, language config, LSP client via stdio           │
  │       │ (editors/vscode-cant/)         │                                                                   │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 6     │ Pipeline executor (Rust)       │ Takes PipelineDef AST, tokio subprocesses, stdout/stderr capture, │
  │       │                                │  variable resolution                                              │   
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ 6     │ workflow-executor.ts           │ AST statement dispatch, ExecutionScope, all statement handlers    │   
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 6     │ parallel-runner.ts             │ Three strategies: all, race, settle                               │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 6     │ discretion.ts                  │ Pluggable evaluator, mock, rate-limited implementations           │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 6     │ approval.ts                    │ Token generation, validation, CAS transitions, expiry             │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 6     │ context-builder.ts             │ Scope chain, template resolution, step output binding             │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 7     │ cant migrate CLI command       │ Reads markdown, converts to .cant, --write/--dry-run, TODO flags  │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 7     │ AGENTS.md @import support      │ cant-resolver.ts (418 lines), resolves @import *.cant in CAAMP    │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 7     │ Migration tooling              │ Converter, markdown-parser, serializer, diff engine               │
  ├───────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────┤   
  │ 7     │ Existing .cant files           │ 4 agent definitions in .cleo/agents/                              │
  └───────┴────────────────────────────────┴───────────────────────────────────────────────────────────────────┘   
                                                   
  ---                                                                                                              
  2. PENDING                                                                                        
                                               
  ┌───────┬─────────────────────────────────┬──────────────────────────────────────────────────────────────────┐
  │ Phase │              Item               │                         Gap Description                          │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 1     │ package.json in cant-napi       │ No @cleocode/cant-native package.json (likely generated at       │   
  │       │                                 │ publish time)                                                    │
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤   
  │ 1     │ build-native.sh                 │ Not created; build-wasm.sh still exists                          │
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤   
  │ 1     │ Dedicated napi binding tests    │ Tests integrated into parse.test.ts but no isolated napi test    │
  │       │                                 │ suite                                                            │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 2     │ TS AST types in types.ts        │ Only Layer 1 ParsedCANTMessage types — missing Layer 2           │   
  │       │                                 │ CantDocument, AgentDef, SkillDef, HookDef, etc.                  │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 2     │ parseCantDocument() export in   │ Not exported; only parseCANTMessage() available to TS consumers  │   
  │       │ index.ts                        │                                                                  │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 2     │ native-loader.ts interface      │ Missing cantParseDocument() declaration in CantNativeModule      │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤   
  │ 4     │ Test coverage (104/145)         │ 104 validation tests vs planned 145 — needs ~41 more             │
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤   
  │ 5     │ Test coverage (63/75)           │ 63 LSP tests vs planned 75 — needs ~12 more                      │
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤   
  │ 6     │ session-manager.ts              │ File does not exist; only a stub in workflow-executor.ts         │
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤   
  │ 6     │ NAPI execute_pipeline() export  │ Pipeline executor not bridged to Node.js — only parser exports   │
  │       │                                 │ exist                                                            │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 6     │ approvalTokensJson column in    │ Column missing from tasks-schema.ts sessions table               │   
  │       │ sessions table                  │                                                                  │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 6     │ ApprovalToken in                │ Type defined locally in core, not exported to contracts package  │   
  │       │ @cleocode/contracts             │                                                                  │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 6     │ Approval suspend/resume flow    │ Gate → generate token works; session suspension, /approve        │   
  │       │                                 │ endpoint, and resume are stubs                                   │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 6     │ TS-to-Rust hybrid bridge        │ executePipeline() in workflow-executor.ts is a stub; no napi     │   
  │       │                                 │ import                                                           │   
  ├───────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
  │ 6     │ TS runtime test coverage (4/60) │ 4 skipped TS tests vs planned 60+ (blocked on napi bridge)       │   
  └───────┴─────────────────────────────────┴──────────────────────────────────────────────────────────────────┘   
                                                   
  ---                                                                                                              
  3. CHANGED                                                                                        
                                               
  ┌───────┬─────────────────────┬──────────────────────────────────────────────────────────────────────────────┐
  │ Phase │        Item         │                                 What Changed                                 │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 0     │ Validation rules    │ Plan said ~30 → Spec defines 45 rules (S01-S13, P01-P08, T01-T07, H01-H04,   │
  │       │ count               │ W01-W13)                                                                     │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 0     │ CAAMP event count   │ Plan said 16 canonical → Now 31 events (16 provider + 15 domain, added       │
  │       │                     │ 2026-03-27)                                                                  │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 0     │ Grammar constructs  │ Added choice, block_def/block_call, throw (2026-03-27 commit c3aea385)       │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 0     │ AST Statement       │ Plan said ~10 → Now 15 variants (added Choice, Throw, BlockDef, BlockCall,   │
  │       │ variants            │ Output)                                                                      │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 1     │ cant-napi exports   │ Plan said parse() + classify_directive() → Actual has 6 exports including    │   
  │       │                     │ parse_document(), validate_document(), extract_agent_profiles()              │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 1     │ wasm-loader.ts      │ Plan said rename to native-loader.ts → Both files exist (wasm-loader.ts      │   
  │       │                     │ preserved for backward compat)                                               │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 1     │ Rust test count     │ Plan baseline 47 → Actual 497 tests in cant-core (10x growth)                │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 1     │ TS test count       │ Plan baseline 8 → Actual 111 tests in packages/cant (14x growth)             │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 2     │ dsl/ module count   │ Plan said 14 modules → Actual 25 files (Layer 3 forward-integrated)          │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 2     │ INDENT/DEDENT       │ Plan said explicit token markers → Actual uses IndentedLine struct with      │   
  │       │ approach            │ implicit indent tracking (functionally equivalent)                           │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 3     │ Test count          │ Plan said ~125 → Actual 130 tests (+5 over target)                           │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 4     │ Rule count          │ Plan said ~30 → Actual 41 rules (37% more: S+5, P+2, T+1, W+4)               │   
  │       │ implemented         │                                                                              │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 4     │ ValidationEngine    │ Plan said ValidationEngine class + run_all_rules() → Actual is validate()    │
  │       │ naming              │ function                                                                     │   
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 5     │ Test count          │ Plan said ~75 → Actual 63 tests (84% — 12 short)                             │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 6     │ Rust runtime tests  │ Plan said ~30 → Actual 42 tests (40% more)                                   │
  ├───────┼─────────────────────┼──────────────────────────────────────────────────────────────────────────────┤   
  │ 7     │ Test count          │ Plan said ~55 → Actual 105 tests (1.9x over target)                          │
  └───────┴─────────────────────┴──────────────────────────────────────────────────────────────────────────────┘   
                                                                                                    
  ---                                                                                                              
  Summary Scorecard                                                                                 
                                                                                                                   
  ┌───────┬─────────────────────────────────┬──────────────────────────────┬────────────┐
  │ Phase │           Description           │            Status            │ Completion │                          
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤           
  │ 0     │ CANT-DSL-SPEC.md                │ COMPLETED                    │ 100%       │
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤
  │ 1     │ napi-rs 3.8+ Migration          │ COMPLETED (3 minor pending)  │ ~90%       │                          
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤                          
  │ 2     │ Grammar Foundation (Layer 2)    │ COMPLETED (TS types pending) │ ~85%       │                          
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤                          
  │ 3     │ Orchestration Parsing (Layer 3) │ COMPLETED                    │ 100%       │           
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤                          
  │ 4     │ Validation Engine               │ COMPLETED (tests short)      │ ~95%       │           
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤                          
  │ 5     │ LSP Server + VS Code            │ COMPLETED (tests short)      │ ~90%       │           
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤                          
  │ 6     │ Runtime Integration             │ PARTIAL (bridge pending)     │ ~60%       │           
  ├───────┼─────────────────────────────────┼──────────────────────────────┼────────────┤                          
  │ 7     │ Migration & Adoption            │ COMPLETED                    │ 100%       │
  └───────┴─────────────────────────────────┴──────────────────────────────┴────────────┘                          
                                                                                                    
  Test Reality vs Plan                                                                                             
                                                                                                    
  ┌───────────────────────────┬───────────┬────────┬───────────┐                                                   
  │          Metric           │  Planned  │ Actual │   Delta   │
  ├───────────────────────────┼───────────┼────────┼───────────┤                                                   
  │ Total tests               │ ~757      │ 699    │ -58 (92%) │                                    
  ├───────────────────────────┼───────────┼────────┼───────────┤
  │ Rust tests (cant-core)    │ ~450 est. │ 497    │ +47       │                                                   
  ├───────────────────────────┼───────────┼────────┼───────────┤                                                   
  │ Rust tests (cant-lsp)     │ ~75       │ 63     │ -12       │                                                   
  ├───────────────────────────┼───────────┼────────┼───────────┤                                                   
  │ Rust tests (cant-runtime) │ ~30       │ 28     │ -2        │                                    
  ├───────────────────────────┼───────────┼────────┼───────────┤                                                   
  │ TS tests (packages/cant)  │ ~55+      │ 111    │ +56       │
  └───────────────────────────┴───────────┴────────┴───────────┘                                                   
                                                                                                    
  Critical Remaining Work                                                                                          
                                                                                                    
  The biggest gap is Phase 6 bridge integration: the Rust pipeline executor and TypeScript workflow executor are   
  both individually implemented, but the napi bridge connecting them (execute_pipeline() export + TS import) is not
   wired. This also blocks the approval suspend/resume flow, session-manager.ts, and TS-side runtime tests. The    
  secondary gap is Phase 2 TypeScript types — Layer 2 AST types aren't exported to JS consumers, limiting adoption
  of parseCantDocument().

## Context

CANT (Collaborative Agent Notation Tongue) exists today as a ~900 LOC Rust message protocol parser (47 tests) that extracts directives, @addresses, T-refs, and #tags from agent messages. The vision is to evolve it into a **full non-prose DSL** — the sole structured language for the CLEO ecosystem — inspired by OpenProse (.prose) and Lobster (.lobster) but with a fundamentally different philosophy: real parser, real runtime, real static analysis. Not an LLM-simulated VM.

**Problem**: Agents currently receive instructions via unstructured markdown (AGENTS.md), orchestrate via prose messages, and have no way to define deterministic pipelines or validate instruction files before runtime. The ecosystem has three separate uncoordinated systems: message parsing (cant-core), instruction injection (CAAMP), and implicit orchestration (prose in conversation).

**Goal**: Collapse all three into `.cant` files — a single grammar parsed by one Rust crate, validated by one LSP, executed by one hybrid runtime (Rust for deterministic pipelines, TS for LLM-involved workflows).

## Locked Design Decisions

1. **Runtime Model (C - Hybrid)**: Rust binary for pipelines (deterministic), @cleocode/core for workflows (LLM-involved), napi-rs 3.8+ bridging both
2. **Discretion Evaluation (A+C)**: `evaluateDiscretion(condition, context)` — defaults to LLM call, pluggable for override/testing
3. **AGENTS.md Relationship (C - Migration)**: AGENTS.md remains industry entry point. `.cant` files work alongside. `cant migrate` converts markdown to `.cant`. `@import *.cant` supported from AGENTS.md
4. **Approval/Resume Tokens (A)**: Use existing session persistence in tasks.db (sessions table already has status, handoffJson, resumeCount)

---

## Phase 0: CANT-DSL-SPEC.md (Formal Specification)

**Why first**: The grammar design IS the hard part. Implementation follows mechanically from a good spec. Ship the spec, get it reviewed, then build.

### Deliverable
- `docs/specs/CANT-DSL-SPEC.md` — Complete language specification

### Contents
1. **File format**: `.cant` universal extension, `kind:` frontmatter for mode (`agent`, `skill`, `hook`, `workflow`, `pipeline`, `config`). No frontmatter = Layer 1 message mode (backward compat).
2. **Complete EBNF grammar** (all 3 layers)
3. **AST type definitions** (Rust structs with `Span` on every node)
4. **~30 numbered validation rules** (S01-S08 scope, P01-P05 pipeline purity, T01-T06 types, H01-H04 hooks, W01-W07 workflows)
5. **CAAMP event mapping**: 16 canonical events → CANT `on Event:` block names (PascalCase, verbatim)
6. **Import resolution algorithm**: `./relative` → `@skill-name` → `bare-name` → error
7. **Expression language**: variables, property access, comparisons, string interpolation, boolean operators
8. **10+ example `.cant` files** covering each kind
9. **Migration guide** from markdown

### Three-Layer Grammar Architecture

```
Layer 1: Message Protocol    (DONE — current cant-core, MUST NOT BREAK)
  /directive @address T1234 #tag — header/body split

Layer 2: Instruction DSL     (NEW — what agents ARE)
  frontmatter, agent blocks, skill blocks, on Event: hooks,
  properties, permissions, context wiring, @import

Layer 3: Orchestration DSL   (NEW — how work FLOWS)
  workflow (LLM-involved), pipeline (deterministic),
  session, parallel, loop, if/else, try/catch,
  discretion (**...**), approval gates, resume tokens
```

**Non-prose invariant**: Prose ONLY in session prompts and discretion conditions. Everything else is structured, parseable, lintable.

---

## Phase 1: napi-rs 3.8+ Migration

**Why**: napi-rs 3.8+ compiles to BOTH native Node.js addon AND WASM from one crate. Replaces wasm-bindgen/wasm-pack, gives better Node perf, cleaner SSoT.

### New Crate
- `crates/cant-napi/` — Thin binding crate wrapping cant-core for Node/WASM via napi-rs
  - `Cargo.toml` (napi 3.8+, napi-derive, cant-core dep)
  - `src/lib.rs` — `#[napi]` exports: `parse()`, `classify_directive()`
  - `build.rs` — napi-rs build script
  - `package.json` — `@cleocode/cant-native`

### Modifications
- `crates/cant-core/Cargo.toml` — Remove wasm-bindgen, js-sys, wasm feature, cdylib crate-type, wasm-pack metadata. Keep rlib only.
- `crates/cant-core/src/wasm.rs` — **DELETE**
- `crates/cant-core/src/lib.rs` — Remove `pub mod wasm`
- Same treatment for `conduit-core`, `lafs-core` (remove wasm.rs, wasm feature)
- `Cargo.toml` (workspace) — Add `crates/cant-napi` member, napi workspace deps
- `packages/cant/src/wasm-loader.ts` → `native-loader.ts` — Load napi addon, sync init
- `packages/cant/src/parse.ts` — Call native addon instead of WASM. `initCantParser()` becomes no-op.
- `packages/cant/src/index.ts` — Update exports
- `build-wasm.sh` → `build-native.sh`

### Backward Compat
- `parseCANTMessage()` signature unchanged
- JS fallback parser preserved at `packages/cant/src/parse.ts:60-78`
- All 47 Rust tests + 8 TS tests pass unchanged

### Tests: ~15 new napi binding + 47 cross-validation = ~62 new

---

## Phase 2: Grammar Foundation (Layer 2 — Instruction DSL)

**Why**: This is the first thing that makes `.cant` files useful — define agents, skills, hooks in structured non-prose format.

### New Rust Modules: `crates/cant-core/src/dsl/`
```
dsl/
  mod.rs            → parse_document() entry point
  ast.rs            → CantDocument, AgentDef, SkillDef, HookDef, Property, etc (all with Span)
  frontmatter.rs    → --- block parser
  agent.rs          → agent Name: block
  skill.rs          → skill Name: block
  hook.rs           → on Event: block (validates against 16 CAAMP events)
  import.rs         → @import statements
  property.rs       → key: value assignment
  binding.rs        → let/const bindings
  permission.rs     → allow/deny blocks
  context.rs        → context: wiring
  expression.rs     → variables, property access, comparisons, string interpolation
  indent.rs         → INDENT/DEDENT token preprocessing (Python-style)
  span.rs           → Span { start, end, line, col }
  error.rs          → ParseError with spans + rich messages
```

### Key Technical Decisions
- **Indentation**: 2-space standard. Pre-process into INDENT/DEDENT token stream, then parse with nom. Separates indentation tracking from grammar.
- **AST carries Span everywhere**: Required for LSP (Phase 5) — every node knows its source location.
- **`parse_document()` is NEW, `parse()` is UNTOUCHED**: Two independent entry points. Message mode (Layer 1) never changes.

### Modifications
- `crates/cant-core/src/lib.rs` — Add `pub mod dsl;` and `pub fn parse_document()`
- `crates/cant-napi/src/lib.rs` — Add `parse_document()` napi export
- `packages/cant/src/types.ts` — Add TS types mirroring AST
- `packages/cant/src/index.ts` — Export `parseCantDocument()`

### Tests: ~140 new (frontmatter 20, agent 25, skill 15, hook 15, import 10, expression 25, indent 15, errors 10, roundtrip 5)

---

## Phase 3: Orchestration Parsing (Layer 3)

### New Rust Modules: `crates/cant-core/src/dsl/`
```
workflow.rs       → workflow Name(params): block
pipeline.rs       → pipeline Name: step sequences (deterministic only)
session.rs        → session "prompt" / session: agent-name
parallel.rs       → parallel: named arms
conditional.rs    → if **discretion**: / if expr: / else:
loop_.rs          → for x in collection: / loop until **condition**:
try_catch.rs      → try: / catch err: / finally:
discretion.rs     → ** prose text ** extraction
approval.rs       → approve: gate with message + timeout
```

### AST Extensions in `dsl/ast.rs`
- `Statement` enum: Session, Parallel, Conditional, Loop, TryCatch, ApprovalGate, PipeStep, Binding, Directive
- `WorkflowDef`, `PipelineDef`, `SessionExpr`, `ParallelBlock`, `DiscretionCondition`, `ApprovalGate`
- Pipeline vs Workflow structural distinction (pipelines contain only PipeStep, workflows contain any Statement)

### Tests: ~125 new (workflow 25, pipeline 20, parallel 15, conditional 20, loop 10, try/catch 10, approval 10, nested 15)

---

## Phase 4: Validation Engine (~30 Static Analysis Rules)

### New Module: `crates/cant-core/src/validate/`
```
mod.rs              → ValidationEngine, run_all_rules()
context.rs          → Symbol tables, scope stacks
scope.rs            → S01-S08: unresolved refs, shadowing, import cycles
pipeline_purity.rs  → P01-P05: no sessions/discretion/approval in pipelines
types.rs            → T01-T06: property types, comparison compat
hooks.rs            → H01-H04: valid CAAMP events, no duplicates
workflows.rs        → W01-W07: approval gates, parallel names, session prompts
diagnostic.rs       → Diagnostic { severity, rule_id, message, span, fix? }
```

### Validation Rules (30 total)
- **S01-S08**: Scope (unresolved refs, shadowing, import cycles, unique names, valid events)
- **P01-P05**: Pipeline purity (no sessions, no discretion, no approval, no LLM calls, deterministic only)
- **T01-T06**: Types (property values, comparison operands, interpolation types)
- **H01-H04**: Hooks (valid CAAMP events, no duplicates, no workflow constructs in hooks)
- **W01-W07**: Workflows (approval needs message, unique parallel arms, valid iterables)

### Output: `Diagnostic` type directly consumable by LSP (Phase 5)

### Tests: ~145 new (3-5 per rule + 15 integration + 10 diagnostic quality)

---

## Phase 5: LSP Server (cant-lsp)

### New Crate: `crates/cant-lsp/`
- `tower-lsp` based LSP binary
- Diagnostics from Phase 4 validation engine
- Completions: keywords, event names (16 CAAMP), agent/skill names, property keys, import paths
- Hover: type info, directive docs, property descriptions
- Go-to-definition: imports, agent/skill references
- Document symbols: outline view

### VS Code Extension: `editors/vscode-cant/`
- TextMate grammar for `.cant` syntax highlighting
- Language configuration (brackets, comments, indentation)
- LSP client connecting to `cant-lsp` via stdio

### Tests: ~75 new (30 protocol, 20 completion, 15 diagnostic integration, 10 TextMate)

---

## Phase 6: Runtime Integration

### Pipeline Executor (Rust): `crates/cant-runtime/`
- Takes validated `PipelineDef` AST
- Executes steps as subprocesses (tokio)
- Captures stdout/stderr, pipes between steps
- Variable resolution
- napi export: `execute_pipeline()`

### Workflow Executor (TypeScript): `packages/core/src/cant/`
```
workflow-executor.ts   → Orchestrates sessions via CLEO dispatch
session-manager.ts     → Session lifecycle for CANT sessions
parallel-runner.ts     → Concurrent arm execution
discretion.ts          → evaluateDiscretion(condition, context) — pluggable, defaults to LLM
approval.ts            → Token generation, storage in sessions table, /approve resumption
context-builder.ts     → Build execution context from CANT bindings
```

### Approval Token Integration
- Add `approvalTokensJson` column to sessions table (additive migration)
- `ApprovalToken` type in `@cleocode/contracts`: token, sessionId, workflowName, gateName, message, status, timestamps
- Flow: workflow hits gate → generate UUID token → store in session → suspend → `/approve {token}` directive → validate → resume

### Hybrid Bridge
TS workflow executor calls Rust pipeline executor for deterministic sub-steps via napi-rs:
```typescript
import { executePipeline } from '@cleocode/cant-native';
```

### Tests: ~100 new (30 pipeline Rust, 25 workflow TS, 15 discretion, 20 approval, 10 bridge)

---

## Phase 7: Migration & Adoption

### `cant migrate` CLI Command
- `packages/cleo/src/commands/cant-migrate.ts`
- Reads AGENTS.md/CLAUDE.md, converts structured sections → `.cant` files
- Conservative: flags uncertain conversions with `# TODO: manual conversion needed`
- `--write` to apply, `--dry-run` to preview

### AGENTS.md @import Support
- `packages/caamp/src/core/instructions/cant-resolver.ts`
- Resolves `@import *.cant` lines within CAAMP:START/END markers
- Parses referenced `.cant` file, extracts definitions, converts to provider instruction format

### Tests: ~55 new (15 CLI, 10 @import, 20 conversion, 10 roundtrip)

---

## File Map Summary

### New Crates (3)
| Crate | Phase | Purpose |
|-------|-------|---------|
| `crates/cant-napi/` | 1 | napi-rs binding (Node + WASM targets) |
| `crates/cant-lsp/` | 5 | LSP server binary |
| `crates/cant-runtime/` | 6 | Pipeline executor |

### New TS Modules (3)
| Module | Phase | Purpose |
|--------|-------|---------|
| `packages/core/src/cant/` | 6 | Workflow executor, discretion, approval |
| `packages/cant/src/migrate/` | 7 | Markdown-to-CANT conversion |
| `packages/caamp/src/core/instructions/cant-resolver.ts` | 7 | @import resolution |

### Key Files Modified
| File | Phase | Change |
|------|-------|--------|
| `crates/cant-core/Cargo.toml` | 1 | Remove wasm-bindgen, keep rlib only |
| `crates/cant-core/src/wasm.rs` | 1 | DELETE |
| `crates/cant-core/src/lib.rs` | 2 | Add `pub mod dsl;` + `parse_document()` |
| `crates/cant-core/src/parser.rs` | — | UNCHANGED (Layer 1 untouched) |
| `packages/cant/src/wasm-loader.ts` → `native-loader.ts` | 1 | napi-rs loader |
| `packages/cant/src/parse.ts` | 1,2 | napi binding + parseCantDocument |
| `packages/core/src/store/tasks-schema.ts` | 6 | Add approvalTokensJson column |
| `Cargo.toml` (workspace) | 1,5,6 | Add new crate members |

### Spec Documents (1)
- `docs/specs/CANT-DSL-SPEC.md` (Phase 0)

---

## Test Targets

| Phase | New Tests | Cumulative |
|-------|-----------|------------|
| Existing | — | 55 (47 Rust + 8 TS) |
| Phase 1: napi-rs | ~62 | ~117 |
| Phase 2: Grammar | ~140 | ~257 |
| Phase 3: Orchestration | ~125 | ~382 |
| Phase 4: Validation | ~145 | ~527 |
| Phase 5: LSP | ~75 | ~602 |
| Phase 6: Runtime | ~100 | ~702 |
| Phase 7: Migration | ~55 | ~757 |

---

## Verification Plan

### Per-Phase Gates
1. All existing 47 Rust + 8 TS tests pass (backward compat)
2. `cargo test` passes for all workspace crates
3. `cargo clippy` clean (workspace lint rules: forbid unsafe, deny unwrap/expect)
4. `pnpm biome check --write .` passes
5. `pnpm run build` succeeds
6. `pnpm run test` passes

### End-to-End Validation (Post Phase 6)
1. Parse a `.cant` agent file → validate → render to instruction markdown
2. Parse a `.cant` workflow → validate → execute pipeline steps → verify output
3. Parse a `.cant` workflow with discretion → mock evaluator → verify conditional branch
4. Parse a `.cant` workflow with approval gate → generate token → simulate /approve → verify resume
5. LSP: open `.cant` file in VS Code → verify diagnostics, completions, hover all work

### Backward Compat Smoke Tests
- `cant_core::parse("/done @all T1234 #shipped\n\n## Done")` returns identical result at every phase
- `parseCANTMessage(content)` in TS returns identical result at every phase
- `.cant` file without frontmatter parses as Layer 1 message

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| napi-rs 3.8 WASM maturity | Browser consumers break | Keep JS fallback parser permanently |
| Indentation parsing with nom | Parser complexity | Pre-process to INDENT/DEDENT tokens (Python approach) |
| Discretion eval latency | Slow workflows | Pluggable evaluator: short-circuit for common patterns |
| Migration heuristic quality | Bad .cant output | Conservative conversion, --dry-run, TODO comments |
| SignalDock dep chain | Breaking git dep | SignalDock only calls `parse()` — DSL modules are additive |

