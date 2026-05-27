# **Cleo Code: Agentic Harness Architecture Plan**

> **Status**: canonical (2026-05-23) · indexed by `cleo docs fetch cleo-canonical-north-star` (mirror: [`docs/plan/cleo-canonical-north-star.md`](../plan/cleo-canonical-north-star.md))
> **Layer owned**: Tier 0 Harness Layer (Cockpit TUI · TS Daemon · ZeroMQ IPC · VCM mutex · PTY isolation)
> **Sibling canon**: [`docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md`](../plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md) — persona/memory layer (Tier 1-14)
> **Seam between layers**: LAFS envelope (ADR-039); contract hardened by saga **T10343 SG-ENVELOPE-FIRST**
> **Filed sagas covering this doc's scope** (per `cleo docs fetch sg-canonical-saga-mesh-2026-05-23`; decisions ratified in BRAIN D018-D024):
> - **T10401 SG-HARNESS-DAEMON-IPC** — `cleo daemon serve` + VCM mutex queue + ZeroMQ data plane + WASI/Docker sandbox (§§2, 7, 8.D, 8.E)
> - **T10402 SG-COCKPIT-HARNESS** — Rust `ratatui` TUI as separate process consuming envelope-over-IPC (§§2, 6)
> - **T10409 SG-VAULT-CORE** — vendored `crates/cleo-gateway` (axum + hyper + tokio-rustls + rcgen MITM CA) hosting the SDK API surface
> - **T10403 SG-GENKIT-MIDDLEWARE** — context compression (LLMLingua-2) + bidirectional PII (gaze-pii NAPI-RS) addresses §8.C context window exhaustion
> - **T9800 SG-WORKTREE-CANON** + **T9977 SG-WORKTRUNK-OWN** — addresses §8.A worktree dependency management
> **2026-05-24 update**: HTTPS via vendored `crates/cleo-gateway` is the **primary** transport for the SDK API control plane; ZeroMQ retained for streaming/PUB-SUB only (heartbeats, brain pulses, PTY firehose) per §8.D heartbeat protocol. See BRAIN D019.
> **Promotion-to-plans/ pending**: when first Tier 0 wave ships, move this doc into `docs/plan/` via `cleo docs add --type plan`.

## **1\. Executive Summary**

Cleo Code is a bleeding-edge, autonomous agentic harness designed to manage complex software development lifecycles. It utilizes a hybrid architecture: a highly responsive, crash-resistant Rust Terminal User Interface (TUI) acting as the command cockpit, driven by a high-concurrency TypeScript Daemon that routes logic, orchestrates LLM agents, and manages file-system mutability.

The system features a sentient-leaning Prime Orchestrator, a collaborative agent network (Conduit), an execution pipeline (LOOM), and a graph-connected memory system (The Living Brain).

## **2\. Core Architecture & Inter-Process Communication (IPC)**

The system is strictly divided to ensure UI responsiveness and deterministic execution without blocking the Node/Bun event loop.

* **The TS Daemon (Traffic Cop):** Written in TypeScript. Handles LLM network I/O, state machine transitions, OS child-process spawning, and git lock management.  
* **The Rust TUI (The Cockpit):** Built with ratatui and the cockpit crate. Renders the UI, multiplexes PTYs (Pseudo-Terminals) for worker isolation, and visualizes system state.  
* **The IPC Bridge (ZeroMQ):** \* *PUB/SUB Socket:* High-volume, unidirectional firehose from TS Daemon to Rust TUI (streaming worker stdout, brain pulses, state changes).  
  * *REQ/REP Socket:* Command channel for user input from the TUI to the Daemon.  
  * *Payloads:* Strictly typed using Discriminated/Tagged Unions (CleoEnvelope, CleoEvent) mapped between TypeScript interfaces and Rust serde structs.

## **3\. Project Lifecycle & Data Hierarchy (LOOM)**

Development is tracked via a strict hierarchical pipeline to ensure LLMs maintain context and focus.

### **The Hierarchy**

1. **Sagas:** Grouped, overarching epics (e.g., "Implement User Authentication").  
2. **Epics:** Full release packages tied to a Saga.  
3. **Tasks:** PR-worthy grouped commits.  
4. **Subtasks:** Atomic, isolated changes assigned to ephemeral workers.

### **The Pipeline (LOOM)**

Every Epic flows through two distinct loop phases:

1. **RCASD:** Research, Consensus, Architecture Decision, Specification, Decomposition. (Managed by Lead Agents via the *Conduit* collaboration pipeline).  
2. **IVTR:** Implementation, Validation, Testing, Release. (Executed by Ephemeral Workers in isolated environments).

## **4\. Agent Hierarchy**

* **Prime Orchestrator:** The single point of contact for the user. Manages global state, delegates Epics to Lead Agents, and monitors the Living Brain.  
* **Lead Agents:** Domain-specific managers. They debate architecture in the Conduit, decompose Tasks into Subtasks, and review PRs.  
* **Ephemeral Workers:** Highly focused, short-lived agents spawned to execute a single IVTR Subtask. They operate in isolated terminal sessions and git worktrees.

## **5\. The Living Brain & Memory**

A native Rust SDK utilizing SQLite, exposed to the TypeScript Daemon via **NAPI-RS**. This allows CPU-bound graph traversal to run on background C++ threads, keeping the TS event loop unblocked.

* **Macro Topology (Braille Canvas):** TUI visualization using sub-character resolution to show neural "pulses" and connection activity.  
* **Micro Semantics (Semantic Ledger):** TUI table showing exact contextual memory retrievals.  
* **Dream States:** When the system is idle, a dedicated Node worker thread engages the NAPI-RS module to run compaction algorithms—forging ephemeral observations into deterministic rules. The UI visually shifts palettes to indicate this "Consolidation Mode."

## **6\. The Cockpit TUI Layout**

A single, clean terminal interface to monitor the entire harness.

* **Left Sidebar (HUD):** System daemon health and The Living Brain visualization/Dream state gauges.  
* **Right Sidebar (Pipeline):** Collapsible Saga/Epic tree with color-coded tags indicating LOOM phases (RCASD vs IVTR).  
* **Center Top:** Prime Orchestrator Chat and the rolling Conduit agent-debate feed.  
* **Center Bottom (Cockpit Isolation Zone):** Dynamic grid of cockpit PTY panes where ephemeral workers stream their compilation/test output in real-time. If a worker crashes, the PTY collapses safely without taking down the TUI.

## **7\. Version Control & Isolation Manager (VCM)**

To prevent agents from stepping on each other's toes during simultaneous IVTR loops, the system uses strict filesystem and process isolation.

* **Git Worktrees:** Every ephemeral worker is assigned a dynamically generated git worktree to ensure file-system and git index isolation.  
* **The VCM Mutex Queue:** A singleton class in the TS Daemon handling locked Git operations (branch, fetch, push, worktree add).  
* **Fault Tolerance:** The VCM uses try/finally blocks, AbortController timeouts, and OS-level SIGKILL commands to guarantee that rogue, hanging Git processes cannot dead-lock the automated queue.

## **8\. "Gotchas" & Research Areas**

As development progresses, pay special attention to the following architectural risks:

### **A. Dependency Management in Worktrees**

* **The Problem:** git worktree isolates source code, but running npm install or cargo build in 10 simultaneous worktrees will exhaust disk space and CPU.  
* **Action/Research:** Research hardlinking techniques. For Node/TS, leverage pnpm's global store. For Rust, configure a shared .cargo/config.toml injecting sccache and a shared CARGO\_TARGET\_DIR for the workers.

### **B. SQLite Write Contention (The Brain)**

* **The Problem:** During a Dream State, the background thread will heavily write/compact the SQLite database. If the Prime Orchestrator needs to read context simultaneously, SQLite might lock.  
* **Action/Research:** Ensure the Rust SQLite connection is explicitly configured to use PRAGMA journal\_mode=WAL; (Write-Ahead Logging) to allow concurrent reads and writes.

### **C. Context Window Exhaustion**

* **The Problem:** Passing the Saga, Epic, Task, Subtask, and Brain Context into an LLM prompt will quickly exceed token limits or cause the LLM to lose focus ("lost in the middle" phenomenon).  
* **Action/Research:** Develop strict summarization strategies within the Conduit pipeline. Lead Agents must compress the RCASD consensus into a terse specification before passing it to the ephemeral worker.

### **D. ZeroMQ Zombie Sockets & TUI Disconnects**

* **The Problem:** If the TS Daemon crashes unexpectedly, the Rust TUI might hang indefinitely waiting for a REQ/REP response.  
* **Action/Research:** Implement heartbeat payloads on the PUB/SUB socket. If the Rust TUI misses 3 heartbeats, it should gracefully display a "Connection Lost" overlay rather than freezing.

### **E. Security & Jailbreaking (Worker Containment)**

* **The Problem:** Ephemeral workers operate with shell access via child\_process.spawn. An LLM hallucination could result in rm \-rf / or escaping the worktree.  
* **Action/Research:** Research lightweight containment. Depending on the OS, restrict the spawned worker's permissions, strictly validate the cwd, or run workers inside lightweight Docker containers or WebAssembly (WASI) sandboxes if pure PTY isolation isn't secure enough.