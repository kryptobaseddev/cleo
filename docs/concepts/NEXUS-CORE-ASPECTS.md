# NEXUS Core Aspects

**A standalone canon for the workshop language of CLEO and NEXUS**

NEXUS is the Core, but "core" is too cold a word unless you understand what kind of center it is.

It is not merely the middle of the system. It is the axle, the central chamber where motion becomes coordinated instead of accidental. In the world of CLEO, everything that matters eventually passes through NEXUS because NEXUS is the place where scattered effort is given relationship. It is the round table, the engine room, the loom hall, the library threshold, the gear bench, the river gate. It is where loose work stops behaving like weather and starts behaving like craft.

Around that Core, five great aspects do the actual shaping: **Loom**, **Tessera**, **Cogs**, **Cascade**, and **Tome**.

These are not five identical systems wearing different hats. That is the dead language of bad architecture. They are five different kinds of force in the same workshop, each with its own temperament. One shapes. One composes. One turns. One carries. One remembers in a form that can be read.

The easiest way to understand them is to imagine the whole of NEXUS as an ancient-future workshop built for people who create in bursts, get interrupted by life, and need their work to survive the interruption without becoming nonsense.

In that workshop, the smallest honest unit of work is a **Thread**.

A Thread is not grand. It is not mythology pretending to be productivity. It is simply a task: one strand of intent, one actionable line, one piece of work that can be taken up, advanced, paused, and resumed. Threads are the things developers actually touch. Write the test. Fix the query. Split the handler. Validate the config. Follow up the bug. A Thread can be small, stubborn, tangled, elegant, dyed in panic, or pulled straight by discipline, but it is still one strand.

The reason the Thread metaphor matters is that strands on their own are useful, but fragile. A desk full of loose thread is not fabric. It is potential and mess.

But before the Threads can be woven, there must be a structure to hold them firm. This is the **Warp**.

The Warp represents the unyielding protocol chains: the synthesis of composable workflow shape and strict quality gates. It is the vertical structure of the system that ensures no matter how creatively the agents weave, the final Tapestry adheres to the constraints, validations, and lifecycle stages required by the realm.

In canon terms, **Warp** is the governing concept. In implementation language, this appears as protocol-chain composition. In workshop form, this is expressed as **Loomed Tesserae** at definition time (reusable composition) and **Loomed Tapestries** at runtime (live composed execution). These names describe one coherent motion and are not competing concepts.

This naming does not introduce new runtime domains, tools, or verbs. It remains an overlay on the canonical contract:
- composition and lifecycle in `pipeline`
- flow control in `orchestrate`
- gate enforcement in `check`
- capability execution in `tools`
- work units in `tasks`

That is where **Loom** begins.

Loom is the aspect of tension, framing, and order. It is the great stretched frame on which related Threads are held in relation long enough to become meaningful together. In practical terms, a Loom is the shape an epic takes when the system stops treating related tasks as a pile and starts treating them as one deliberate body of work. This is why it feels right that an epic is not merely "under" Loom, but can itself be called a Loom. An epic is a frame: a bounded field where many Threads are kept under tension, guided by the Warp, until the pattern starts to hold.

When developers say a project has direction, what they usually mean is that the Threads are no longer slipping around loose on the floor. They have been mounted on a Loom.

One Loom may hold the auth redesign. Another may hold the release hardening effort. Another may hold the migration from one provider to another. Each Loom is large enough to matter and specific enough to finish. It is not a vague ambition. It is a working frame.

But real campaigns rarely stop at one Loom.

Meaningful efforts spill across several frames at once. A product launch, a platform migration, a multi-week refactor, a documentation recovery effort, a security pass: these are rarely one epic and done. They are several Looms arranged into one larger design. When that happens, the result is not just "a bigger epic." It becomes a **Tapestry**.

A Tapestry is the first truly composed body of work in the NEXUS language.

It is made of multiple Looms, each with its own Threads, but viewed as one intentional work-pattern. If a Loom is the frame of an epic, a Tapestry is the visible design created by several Looms acting in concert. This is the right word because it implies both structure and picture. A Tapestry is not just execution. It is a coherent campaign you can stand back from and actually recognize.

That is where the workshop stops being about organization and starts becoming about composition.

And that is where **Tessera** belongs.

Tessera should not be treated as "the agent thing" unless you want to waste one of the best names in the whole world. A tessera is a tile in a mosaic, a small repeatable shape that gains real power when it can be set into larger patterns. In the canon of NEXUS, Tessera is the aspect of repeatable design. It is what happens when a Tapestry is understood deeply enough that it can be turned into a reusable pattern card.

A **Tessera** is not the work itself. It is the pattern by which that kind of work can be formed again.

If a Tapestry is the actual campaign for this project, a Tessera is the reusable composition mold for campaigns of that kind. It can carry variables, choices, inputs, conditions, branches, defaults, and environment-specific substitutions. It can say: when the project type is this, include these Looms; when the risk is high, add these checks; when the target is production, require this gate; when the team is small, collapse these paths into one route. A Tessera is not passive documentation. It is reusable intent with enough shape to generate real work.

That makes it far more powerful than a template and much more alive than a checklist.

A team might have a "New Service Tessera," a "Security Sweep Tessera," a "Provider Migration Tessera," a "Release Week Tessera," or a "Bug Triage Tessera." Each one can stamp out a different Tapestry when given fresh inputs. The names and details change, but the craftsmanship remains.

This is where NEXUS begins to feel less like a tracker and more like a language for recurring effort.

But patterns alone do not move anything.

You can have a Loom full of Threads and a beautifully designed Tessera for the resulting Tapestry, and still nothing will happen until something with teeth engages the mechanism.

That is the work of **Cogs**.

Cogs are not lofty. That is their virtue.

Cogs are the practical metal parts. The catches, teeth, levers, triggers, and little precise pieces that convert intention into action. If Loom is textile and Tessera is design, Cogs are clockwork. They are the callable tools, the small integrations, the transforms, validators, openers, shapers, notifiers, retrievers, generators, and external touches that do the tangible work at the edge.

A Cog should feel crisp. It should be small enough to invoke, swap, combine, or discard without redefining the whole machine. The point of a Cog is not grandeur. The point of a Cog is reliable bite.

Because the language needs a name for that bite, a single short-lived execution of a Cog is called a **Click**.

That name matters because it keeps the scale honest. A Click is brief. A Click is local. A Click happens and leaves behind an effect. Open the file. Run the check. Fetch the result. Transform the payload. Register the tool. Resolve the profile. A complex Tapestry may contain many Cogs and hundreds of Clicks, but no one mistakes a Click for the whole campaign. It is one tooth engaging for one moment.

This is also where the system gains its programmable edge. If Tessera defines reusable composition, then Cogs are the primitive powers that composition can call. A Tessera without Cogs is a pattern without hands. Cogs are what let repeatable design become executable design.

Then there is **Cascade**, which is easily misunderstood if you think it only means release.

Cascade is the aspect of descent through gates.

Picture water dropping from one terrace to the next in a mountain city, each fall controlled by stone channels, locks, pressure, and timing. It is not chaotic spill. It is governed flow. That is Cascade. It is what happens when a Tapestry stops being arranged work and becomes moving work. It is the force that carries a prepared pattern through real transitions: validation, execution, release, promotion, handoff, completion.

A Tapestry sitting on the wall is structure. A Tapestry entering live motion becomes a Cascade.

That distinction is useful. It means the same underlying body of work can exist in two very different states. Planned but not flowing. Or flowing through the gates. Cascade is the name for the second state, the moment when work starts crossing thresholds that matter.

This is why Cascade should feel like momentum under discipline, not just automation. It is not "the system runs now." It is "the prepared design is being carried through controlled descent." Failures, pauses, rollbacks, retries, approvals, environment promotions, and staged releases all belong naturally here because they are all threshold events. Cascade is the language of the crossing.

And when the crossing is done, when the work has moved, changed, shipped, or taught, there remains the oldest problem in software: how to remember what it means without entombing it in stale documentation.

That is why **Tome** exists.

Tome is not just documentation. If it becomes that, it dies.

Tome is the aspect of illuminated memory. It is where the realm takes what has been done, learned, patterned, proven, and repeated, and makes it readable without freezing it into irrelevance. If BRAIN is the deep vault under the city, Tome is the library above it where the useful truths are shelved in living form. It is the place of rendered understanding. The place where raw memory becomes something navigable.

A Loom can be described in Tome, but Tome is not the Loom. A Tessera can be published in Tome, but Tome is not the Tessera. A successful Cascade may leave a trail in Tome, but Tome is not merely the log. Tome is what happens when the system turns state into canon and keeps that canon close enough to reality that it remains worth reading.

That matters because the original wound in this world was not a lack of notes. It was the endless decay of notes that could no longer be trusted. Tome is the answer to stale markdown. Not more documents, but living reference. Not one more `PROJECT_STATUS.md` abandoned to dust, but a library where the work can still explain itself.

This leaves one human need that none of the great aspects should be forced to impersonate: the need to catch a thought before it disappears.

That is the purpose of **Sticky Notes**.

Sticky Notes are deliberately plainspoken because they serve a plainspoken need. They are the quick captures stuck to the edge of the workbench: raw thoughts, half-ideas, reminders, fragments, cautions, sparks. They are not yet shaped enough to deserve a Thread, and not yet stable enough to belong to BRAIN, but too important to trust to memory for even an hour.

In runtime language, this is the Catchers' shelf: a human-facing capture surface, not a live relay path.

Their power lies in their lack of ceremony. They are immediate. They are visible. They do not demand task binding, session binding, or a doctrinal commitment to what they will become. They exist so the builder can catch the thought now and decide what it is later.

If a Sticky Note proves trivial, it disappears with no drama. If it matters, it can be promoted.

It may become a **Thread** once it resolves into actionable work.
It may become a **Session Note** if it belongs to the live heat of the current effort.
It may become a **Task Note** if it belongs to one particular Thread.
It may become a **BRAIN Observation** if it ripens into durable knowledge.

That gives the workshop a clean note ecology without making it bureaucratic.

Sticky Notes catch thought at speed.
Session Notes preserve the immediate now.
Task Notes keep local context close to the Thread.
BRAIN Observations preserve what should outlive the moment.
Tome then makes the durable parts readable when the time comes to return.

The workshop also needs names for what happens when the realm is live, staffed, and in motion.

These names are not one flat class of "stations." They are different kinds of runtime form, and the canon only stays clean if those kinds stay distinct.

**The Hearth** is the runtime surface. It is the terminal-facing workshop seat where the Circle gathers, where sessions stay visible, where tools are close at hand, and where work can be taken up without pretending that the terminal itself is the whole system. The Hearth is not a domain. It is the active surface built from `session`, `orchestrate`, and `tools`.

**The Circle of Ten** is the role overlay of the canonical domains:

- **The Smiths** keep the house of `tasks`
- **The Weavers** keep the house of `pipeline`
- **The Conductors** keep the house of `orchestrate`
- **The Artificers** keep the house of `tools`
- **The Archivists** keep the house of `memory`
- **The Scribes** keep the house of `session`
- **The Wardens** keep the house of `check`
- **The Wayfinders** keep the house of `nexus`
- **The Catchers** keep the house of `sticky`
- **The Keepers** keep the house of `admin`

**The Impulse** is runtime motion. It is what notices ready work, picks it up without waiting for ceremony, and advances it through governed chains. It is motion under discipline, not ad-hoc restlessness.

**Conduit** is the runtime relay path. It speaks through LAFS envelopes and A2A delegation only. No private side channel earns canon status. Conduit lives through `orchestrate`, `session`, and `nexus`. `sticky` may hold drafted or promoted handoff material, but it is not the live relay lane.

**Watchers** are runtime patrols. They are not a rival class of hidden daemon kingdoms. They are long-running Cascades through the `pipeline`, aided by `orchestrate`, `check`, and `admin`, and they exist to patrol health, continuity, retries, and gate state while the work remains live.

**The Sweep** is the quality patrol form of Cascade. It is the repeated review-fix-review motion that keeps defects, regressions, and rotten assumptions from taking root.

**Refinery** is the convergence gate within that same live motion: the place where branches, patches, and parallel outcomes are proven fit to join and advance.

**Looming Engine** is the decomposition service. It is Tessera-driven decomposition that turns reusable pattern cards into Looms, Threads, and executable routes without abandoning the Warp that holds quality and sequence together.

**Living BRAIN** is the memory overlay in active circulation. It is not merely the vault below the city, but the neural pathwaying that emerges from observation, similarity, reinforcement, contradiction, and decay. It keeps memory from becoming a museum.

**The Proving** is the validation ground of the runtime. Gates, artifacts, provenance, specifications, and outcomes all arrive here to be tested against reality rather than optimism.

If a thing cannot be shown to have a distinct runtime responsibility, it has not earned a canon name yet. Canon exists to clarify the machinery, not to perfume it.

These names do not introduce new domains, transports, or private protocols. They are the live workshop overlay on the same four great systems and the same ten canonical domains.

Once the language is seen this way, the ten domains stop feeling like admin tables and start feeling like houses in the same city.

The `tasks` domain is the house of Threads. It is where loose work first becomes graspable and where the smallest strands are tracked, bound, and advanced.

The `pipeline` domain is the house of Looms, Tapestries, and the first shaping of Cascade. It is where Threads are held under tension, where frames become patterns, and where work gains formal stage and progression.

The `orchestrate` domain is the conductor’s balcony above the Cascade channels. It decides what moves now, what waits, what splits, what converges, and what must be re-routed when the water hits stone.

The `tools` domain is the forge-bench of Cogs. This is where the small metal powers live: callable capabilities, provider-facing utilities, tool catalogs, and the sharp little mechanisms the larger system depends on.

The `memory` domain is the deep archive beneath Tome. It keeps the durable substance from which usable canon can later be rendered.

The `session` domain is the lit worktable. It holds the immediate context, the open tools, the present focus, and the notes that only matter while the hands are still warm.

The `sticky` domain is the provisional shelf of the Catchers. It catches fast notes, draft handoffs, and provisional captures before they are promoted into a Thread, Session Note, Task Note, or BRAIN Observation. It is not the live agent-to-agent message path. In surface language, it may be presented as the Capture Shelf while the protocol slug remains `sticky`.

The `check` domain is the gatehouse. It does not weave, turn, or compose. It judges whether the thing may pass.

The `nexus` domain is the star road itself, carrying Looms, Tapestries, Tesserae, and Tome-worthy knowledge across project boundaries without losing origin.

Cross-project relay behavior lives under `nexus.share.*` operations. It is the public shelf and caravan route, where useful patterns, entries, and mechanisms become available beyond their place of birth.

The `admin` domain is the hearthkeeper’s office, unseen until something goes wrong, and therefore more important than most people realize.

The whole model holds because the names are no longer pretending to be the same type of thing.

Loom is a frame.
Tessera is a pattern card.
Cogs are teeth.
Cascade is motion through gates.
Tome is illuminated memory.

And the work itself moves through them in a sequence that feels less like taxonomy and more like craft:

A thought lands first as a Sticky Note before it can vanish.
If it matters, it is pulled into a Thread.
Related Threads are mounted on a Loom.
Several Looms together reveal a Tapestry.
A Tessera captures that Tapestry’s reusable design.
Cogs give the design working teeth through discrete Clicks.
Cascade carries the live work through real thresholds.
Tome keeps what mattered in a form worth returning to.

All of it turns around the NEXUS Core.

That is the language the system deserves.
