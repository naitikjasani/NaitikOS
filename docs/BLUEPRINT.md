# NaitikOS — Engineering Blueprint

**Version** 1.0 · **Date** 2 August 2026 · **Status** Pre-implementation · **Audience** Founding engineering team

---

## How to read this document

This is a foundation document, not a feature list. It is written to be handed to senior engineers who will implement it without further clarification, and to be re-read in year three when the original reasoning has been forgotten.

Three conventions:

- **Decisions are stated, not surveyed.** Where there was a real trade-off, the rejected option and the reason for rejecting it are recorded inline. If you disagree in future, you will at least know what you are overturning.
- **Section 14 is not an appendix.** It is a live critique of everything above it. Three revision rounds have already been folded back into sections 1–13; what remains in §14 is the residue of known weakness. Read it before you disagree with anything.
- **Constraints are load-bearing.** The single-user constraint, the twenty-year constraint, and the solo-maintainer constraint each eliminate large classes of otherwise-reasonable architecture. They are cited by name throughout.

### Table of contents

1. [Product Vision](#1-product-vision)
2. [Product Scope](#2-product-scope)
3. [Information Architecture](#3-information-architecture)
4. [Module Breakdown](#4-module-breakdown)
5. [Technical Architecture](#5-technical-architecture)
6. [Repository Structure](#6-repository-structure)
7. [Feature-First Folder Structure](#7-feature-first-folder-structure)
8. [Design System Architecture](#8-design-system-architecture)
9. [Database Blueprint](#9-database-blueprint)
10. [AI Architecture](#10-ai-architecture)
11. [Developer Experience](#11-developer-experience)
12. [Roadmap](#12-roadmap)
13. [Risks](#13-risks)
14. [Critical Review](#14-critical-review)

### The three constraints that shape everything

**C1 — Single user, forever.** There is exactly one human writing to this database. This is not a limitation to be designed around; it is a gift. It removes multi-tenancy, permission models, CRDT conflict resolution, row-level security as a load-bearing mechanism, horizontal scaling, and roughly 60% of what makes a normal product hard. Every time an architecture decision gets complicated, check whether the complexity is being imported from a multi-user assumption that does not apply.

**C2 — Twenty years of daily use.** The application is disposable. Next.js will not exist in its current form in 2046, and neither will any framework chosen today. The *data* is the asset. Every decision is therefore evaluated on: what happens to this in year twelve, when the framework has been replaced twice and the original author has forgotten why it works this way?

**C3 — One maintainer with a demanding day job.** The system must survive three-week gaps in attention. It must not require operational babysitting. Every background job, every scheduled task, every piece of infrastructure is a liability that must justify itself. Cleverness that cannot be re-understood in ten minutes after a two-month absence is a defect.

---

## 1. Product Vision

### 1.1 Mission

To become the single, trusted, permanent record of one person's life — and to turn that record into decisions they would not otherwise have made.

### 1.2 Vision

Most people carry their life in fragments: a health app that knows their weight but not their mood, a notes app that knows their goals but not their progress, a bank app that knows their spending but not what triggered it. Each fragment is individually useful and collectively useless, because the answers that matter live in the gaps between them.

NaitikOS closes the gaps. Not by being a bigger app, but by being a *substrate* — one timeline, one identity, one set of facts — over which every domain is merely a lens.

The end state, ten years out: a person can ask *"why has my skin been worse since March?"* and receive an answer grounded in their own dermatology history, medication changes, sleep debt, training load, dietary shifts, and stress markers — with the evidence attached, the confidence stated, and the uncertainty admitted. Not because a model guessed well, but because the system has been quietly, faithfully recording the truth for a decade and knows how to look.

### 1.3 Core Principles

These are ranked. When two conflict, the higher number yields.

**P1 — Capture cost approaches zero.**
The single greatest cause of death for personal-tracking systems is data-entry burden. Every logging interaction has a hard budget: under five seconds, under three taps, from a cold start. Anything that cannot meet that budget must be derived, imported, inferred, or cut. A beautiful module with no data in it is worse than no module, because it teaches you the system is a museum.

**P2 — The data outlives the application.**
The schema, the export format, and the semantics of a recorded fact are the durable artifacts. The UI is scaffolding. This principle forces: plain Postgres over proprietary stores, migration files committed to git as a permanent changelog, a complete export at any moment, and no fact whose meaning depends on application code to interpret.

**P3 — One substrate, many lenses.**
There is no "gym database" and no "skin database." There is one observation log and one entity graph. *Gym* and *Skin* are queries with a UI attached. This is what makes cross-domain insight possible at all, and it is the single decision that most distinguishes NaitikOS from sixteen apps in a trenchcoat.

**P4 — Deterministic first, generative second.**
Statistics are computed by code. Language models explain, rank, and narrate — they never discover a correlation, never compute a number, and never assert a fact that did not come from a query. A model that invents a plausible correlation in a health context is not a bug; it is a category of harm. The boundary is architectural, not a prompt instruction.

**P5 — Never diagnose. Always prepare.**
The system does not tell its user what is wrong with them, what to take, or what to stop taking. It surfaces patterns and hands them to the professional who is qualified to interpret them. The deliverable of a medical insight is *a better question for your next appointment*, printed and ready. This is a product principle, not a legal disclaimer, and it is enforced in the AI layer's output schema.

**P6 — Silence is a feature.**
No streaks that shame. No badges. No red numbers. No push notification that exists to drive engagement rather than to serve a decision. The system is a tool with an owner, not a product with a user. A day with nothing worth saying is a day the system stays quiet. This is especially load-bearing given the operator's anxiety disorder: an app that manufactures urgency is a health risk, not a health tool.

**P7 — Private by construction, not by policy.**
This database will contain psychiatric medication history, body photographs, and therapy notes. There is no privacy policy that makes third-party analytics acceptable here. The architecture must make leakage *impossible*, not *prohibited*: no analytics SDKs, encrypted media at rest with keys the platform does not hold, and no sensitive content crossing an inference boundary without explicit per-action consent.

**P8 — Every screen answers one question.**
If you cannot state a screen's question in a single sentence — *"what do I do next?"*, *"is this working?"*, *"what changed?"* — the screen does not ship. This is the antidote to the Notion failure mode, where flexibility metastasises into an unusable surface area.

**P9 — Boring technology, ruthlessly applied.**
Postgres, TypeScript, HTTP. The novelty budget is spent entirely on the AI layer and the interaction design. Nothing else gets to be interesting. Per C3, the maintainer must be able to debug this at 11pm after a full workday.

### 1.4 Success Metrics

Deliberately few. Vanity metrics are actively harmful in a single-user product because there is no one to impress.

| Tier | Metric | Definition | Target by day 180 |
|---|---|---|---|
| **North Star** | Compounding Days | Days in the trailing 90 with a completed Daily Close | ≥ 75 / 90 |
| Health | Median capture latency | Cold start → logged observation persisted, p50 | < 5 s |
| Health | Derived-fact ratio | Observations arriving from import/derivation ÷ all observations | ≥ 0.6 |
| Value | Acted-on insights | Insights marked *acted on* ÷ insights surfaced, trailing 30d | ≥ 0.25 |
| Value | Consultation packs used | Medical timeline exports taken to an actual appointment | ≥ 1 per clinical visit |
| Trust | Correction rate | Facts edited or retracted after entry ÷ all facts | < 0.02 |
| **Counter-metric** | Time in app | Median daily foreground minutes | **≤ 6 min, and falling** |

The counter-metric is not decorative. If daily time-in-app is rising, the system is failing — it means capture is getting more expensive or insight is requiring more digging. Treat a sustained rise as a P1 defect.

### 1.5 North Star, and why

**Compounding Days: the count of days in the trailing 90 on which a Daily Close was completed.**

A Daily Close is a single, bounded, sub-sixty-second ritual — the day's minimum viable record. Its exact contents are defined in §4.1.

This is the North Star because **every other capability in this document is downstream of data density.** Correlation detection needs continuity. The knowledge graph needs edges. The prediction engine needs a baseline. The medical timeline needs a record. A system with brilliant analysis over eleven days of data is a demo; a system with mediocre analysis over four years of data is irreplaceable.

It is expressed as a trailing-90 count rather than a streak on purpose. A streak creates a cliff: miss day 34 and the incentive collapses, which is precisely the anxiety-amplifying dynamic P6 prohibits. A trailing window is forgiving of a bad week and unforgiving of a bad quarter — which is the correct shape.

**Anti-goal:** the North Star must never be pursued by making the Daily Close longer or richer. If Compounding Days rises while median capture latency also rises, the metric has been gamed against its own purpose.

---

## 2. Product Scope

### 2.1 MVP — v0.1, "The Spine"

**Thesis: prove the substrate and the ritual before building a single additional domain.**

The MVP is deliberately, uncomfortably narrow. It contains three of the sixteen domains. This is the most important scoping decision in the document and the one most likely to be regretted in week two and vindicated in month four.

**In scope:**

- **The substrate.** Observation log, entity tables, bitemporal medical events, audit trail, full export. The complete §9 data model — *all* of it, even for domains not yet surfaced. The schema is the expensive thing to change later; the UI is not.
- **The Daily Close.** The sixty-second ritual. Mood, energy, sleep, one free-text line, and any domain-specific quick-adds that are active.
- **Three domains only:**
  - *Mind* — mood, anxiety level, medication adherence (Venlafaxine XR, Escitalopram), free-text journal.
  - *Body/Gym* — workout logging with an exercise library, sets/reps/load, bodyweight.
  - *Body/Skin* — daily skin state, routine adherence, standardised progress photography.
- **Timeline.** Read-only chronological view of everything recorded, filterable by domain and date.
- **One deterministic insight family.** Adherence tracking and streak-break detection. No LLM in the MVP path at all.
- **Auth, PWA shell, offline write queue, dark mode.**
- **Export.** A single command produces a portable archive of every fact. This ships in the MVP or it never ships.

**Why these three domains:** they are the operator's three stated top priorities (muscle, skin, mental health), they exercise three structurally different data shapes (time-series scalar, nested structured records, and media-with-protocol), and they are the three most likely to produce a cross-domain correlation worth finding — sleep and anxiety against training volume and skin state is a genuinely interesting question on day 90.

**Explicitly deferred from MVP:** all AI features, nutrition, finance, tasks, calendar, career, learning, documents, teeth, shopping, goals-as-a-module.

**Definition of done:** thirty consecutive days of real use by the operator, with a Compounding Days count of ≥ 25 and no manual database intervention required.

### 2.2 V2 — "The Connections"

Ships only after the MVP clears its definition of done. If Compounding Days is below 25 at day 30, V2 does not start — the MVP is fixed instead.

- **Nutrition** — with the hard requirement that logging a meal takes under ten seconds. This means a personal food library, a recent/frequent list, meal templates, and natural-language parsing (§10.6). If a generic food-database search is the primary interaction, the module has failed P1 and should not ship.
- **Health core** — vitals, lab results (Vitamin D tracking is an immediate concrete need), the full medication register, appointments.
- **Teeth** — procedure history (multiple root canals is a real longitudinal record worth keeping), hygiene routine, appointment cadence.
- **Goals** — the cross-cutting outcome layer. Not a module with its own data, but a projection over observations from every domain.
- **The AI layer, first light.** The deterministic detector suite (§10.6), the context engine, and *narration only* — the model explains findings it did not discover. Plus the Ask surface over the graph.
- **Document vault** — prescriptions, lab PDFs, with OCR and full-text search.
- **Consultation Pack** — the export that goes to a doctor. This is the single highest-value feature in V2 and the clearest proof that P5 is a product principle rather than a hedge.

### 2.3 V3 — "The Compounding"

- **Work** — career log, tasks, learning, calendar integration (read-only first).
- **Money** — finance, subscriptions, shopping. Deliberately last: it is the domain with the best existing third-party tools and the weakest cross-domain linkage.
- **Appearance** — the aggregate lens over skin, physique, grooming, and hair.
- **Prediction engine** — conservative, well-calibrated, humble (§10.9).
- **Wearable ingestion** — Apple Health / Google Fit import. Pull-based, batch, never a live stream.
- **Weekly and monthly reviews** — model-drafted, human-edited, permanently archived as first-class documents.
- **Life Timeline** — the zoomed-out view: years, not days.

### 2.4 Future Vision — v4 and beyond

- **Local model inference** for the routine classification and parsing paths, eliminating the last routine egress of personal text.
- **Longitudinal reports** — the five-year physical, generated from your own record.
- **Signed medical attestations** — cryptographically verifiable "this record has not been altered since date X," which becomes genuinely valuable in a twenty-year medical record.
- **A second user** — spouse or family member — as *separate instances*, never shared tenancy. See §2.5.
- **Successor format.** By year five, publish the export schema as a documented, versioned, application-independent specification. The final act of P2 is making the data readable by software that does not exist yet.

### 2.5 What must never be built

This list has the same authority as the rest of the document. Adding to it is easy; removing from it requires justification in writing.

| Never | Because |
|---|---|
| **Social features** — sharing, feeds, friends, leaderboards, comparison to cohort | Corrupts the incentive from *accurate* to *flattering*. The moment a record can be seen, it stops being honest, and an honest record is the entire product. |
| **Multi-tenancy / SaaS-ification** | Violates C1, and C1 is what makes the architecture tractable. A second user gets a second instance. Sharing a schema between two humans imports permissions, audit scoping, and conflict resolution for zero benefit. |
| **Gamification** — streaks with penalties, badges, points, guilt notifications | Violates P6. With a documented anxiety disorder in the user profile, manufactured urgency is an adverse event, not an engagement tactic. |
| **Diagnosis, dosage advice, or treatment recommendation** | Violates P5. Non-negotiable, enforced structurally in §10.10, not by prompt. |
| **A chatbot as the primary interface** | Conversation is a terrible interface for a sub-five-second capture (P1) and an unreliable one for a number you need to trust (P4). Ask is *a* surface, deliberately not *the* surface. |
| **Third-party analytics, crash reporting with payloads, or session replay** | Violates P7. Body photographs and psychiatric history do not go through Sentry. Self-hosted, payload-scrubbed telemetry only. |
| **Manual entry for anything derivable** | Violates P1. If it can be computed, imported, or inferred, a text input for it is a design failure. |
| **Real-time wearable streaming** | Enormous operational burden (C3) for data whose value is entirely longitudinal. A nightly batch pull captures ~100% of the value at ~5% of the cost. |
| **Custom ML model training** | The dataset is n=1. Classical statistics on a single subject is well-understood, interpretable, and debuggable; a bespoke model is none of those and will be abandoned. |
| **A native mobile app before the PWA is genuinely loved** | Doubles the surface area to serve a distribution problem that does not exist for an audience of one. Revisit only if a platform capability (HealthKit background delivery, Live Activities) becomes load-bearing. |
| **An in-app "everything" search that queries live LLM context** | Expensive, slow, non-deterministic, and unnecessary. Postgres full-text plus vector similarity answers this correctly and cheaply. |
| **Configurable dashboards / user-defined widgets** | The Notion trap. There is one user, and that user's needs are known. Opinionated layouts, changed by editing code, not by drag-and-drop. |

---

## 3. Information Architecture

### 3.1 The organising idea

Sixteen top-level modules in a sidebar is how personal systems die. The user opens the app, sees fourteen mostly-empty sections, feels the weight of everything unmaintained, and closes it.

NaitikOS instead has **four surfaces and five pillars.** Surfaces are *modes of engagement* — how you are relating to your data right now. Pillars are *lenses* over the shared substrate (P3). A module is never a silo; it is a saved query with a purpose-built UI.

The four surfaces:

| Surface | The one question it answers | Frequency |
|---|---|---|
| **Today** | What do I do now, and what do I record? | Multiple times daily |
| **Pillars** | How is this area of my life actually going? | Weekly |
| **Timeline** | What happened, and when? | Occasionally, and it matters enormously when it does |
| **Ask** | Why? | Rarely, deeply |

Plus two utility surfaces — **Library** (reference data the system uses) and **Settings** — which are infrastructure, not destinations.

Default route is `/today`. There is no home page distinct from Today; a separate landing page is a page whose question is "where do I go?", which P8 forbids answering with navigation.

### 3.2 Complete navigation hierarchy

```
/                                   → redirect → /today

TODAY  ─────────────────────────────────────────────────────────
/today                              Today                        [default]
  ├─ Now panel                        what's due, right now
  ├─ Daily Close                      the 60-second ritual (modal)
  ├─ Quick capture rail               ≤3-tap logging, context-aware
  ├─ Today's signal                   at most ONE insight card
  └─ Open loops                       unfinished items, capped at 5

/today/close                        Daily Close (deep link / full page)
/today/capture/:kind                Quick capture sheet (mood|weight|meal|set|photo|note)

PILLARS  ────────────────────────────────────────────────────────
/body                               Body — overview
  /body/gym                           Gym
    /body/gym/log                       Session logger (live)
    /body/gym/history                   Past sessions
    /body/gym/exercises                 Exercise library
    /body/gym/exercises/:id             Exercise detail + all-time progression
    /body/gym/programs                  Training programs
    /body/gym/programs/:id              Program detail
    /body/gym/volume                    Volume & intensity analysis
  /body/nutrition                     Nutrition                          [V2]
    /body/nutrition/log                 Today's intake
    /body/nutrition/foods               Personal food library
    /body/nutrition/foods/:id           Food detail
    /body/nutrition/meals               Meal templates
    /body/nutrition/targets             Macro targets & bulk planning
    /body/nutrition/trends              Intake trends
  /body/composition                   Weight, measurements, physique photos
    /body/composition/photos            Physique progress gallery
  /body/skin                          Skin
    /body/skin/state                    Daily skin log
    /body/skin/photos                   Standardised progress photography
    /body/skin/photos/compare           Side-by-side comparison
    /body/skin/routine                  AM/PM routine & adherence
    /body/skin/products                 Product register + reaction history
    /body/skin/regions                  Per-region tracking (face/chest/back)
    /body/skin/treatments               Treatment courses (e.g. isotretinoin)
  /body/teeth                         Teeth                              [V2]
    /body/teeth/procedures              Procedure history (incl. root canals)
    /body/teeth/hygiene                 Routine & adherence
    /body/teeth/appointments            Dental appointments
  /body/health                        Health core                        [V2]
    /body/health/vitals                 Vitals & measurements
    /body/health/labs                   Lab results
    /body/health/labs/:panel            Panel detail + reference ranges over time
    /body/health/conditions             Conditions register
    /body/health/medications            Medications & supplements
    /body/health/medications/:id        Medication detail + adherence + side effects
    /body/health/appointments           Appointments
    /body/health/symptoms               Symptom log
  /body/sleep                         Sleep
  /body/appearance                    Appearance — aggregate lens        [V3]

/mind                               Mind — overview
  /mind/mood                          Mood & energy tracking
  /mind/anxiety                       Anxiety episodes & triggers
  /mind/journal                       Journal
    /mind/journal/:id                   Entry
    /mind/journal/prompts               Guided prompts
  /mind/therapy                       Therapy sessions & notes           [V2]
  /mind/practices                     Meditation, breathwork, grounding
  /mind/meds                          Psychiatric medication lens        → /body/health/medications, filtered

/work                               Work — overview                     [V3]
  /work/career                        Career log, reviews, wins, artifacts
  /work/tasks                         Tasks
  /work/projects                      Projects
  /work/learning                      Learning
    /work/learning/queue                Reading & course queue
    /work/learning/notes                Notes & synthesis
  /work/calendar                      Calendar (read-only import first)
  /work/focus                         Deep-work sessions & energy mapping

/money                              Money — overview                    [V3]
  /money/accounts                     Accounts & balances
  /money/transactions                 Transactions
  /money/budgets                      Budgets
  /money/subscriptions                Recurring commitments
  /money/shopping                     Shopping list & purchase history
  /money/networth                     Net worth over time

/life                               Life — overview
  /life/goals                         Goals                              [V2]
    /life/goals/:id                     Goal detail: target, trajectory, evidence
    /life/goals/review                  Goal review ritual
  /life/reviews                       Weekly / monthly / annual reviews  [V3]
    /life/reviews/:id                   A specific review
  /life/documents                     Document vault                     [V2]
    /life/documents/:id                 Document viewer + extracted text
  /life/people                        People & relationships             [V3]
  /life/places                        Places & travel                    [V3]

TIMELINE  ───────────────────────────────────────────────────────
/timeline                           Life timeline — chronological
  /timeline?scale=day|week|month|year|life
  /timeline?domain=…&from=…&to=…
/timeline/medical                   Medical timeline (clinical view)     [V2]
/timeline/medical/pack              Consultation Pack builder            [V2]
/timeline/:date                     A single day, fully expanded

ASK  ────────────────────────────────────────────────────────────
/ask                                Ask — conversational lens            [V2]
  /ask/:threadId                      A saved line of enquiry
/insights                           Insight inbox                        [V2]
  /insights/:id                       Insight detail: evidence, method, confidence
  /insights/archive                   Dismissed & acted-on history

LIBRARY  ────────────────────────────────────────────────────────
/library                            Library — reference data
  /library/exercises                  Canonical exercise definitions
  /library/foods                      Canonical food definitions         [V2]
  /library/products                   Skincare & supplement products
  /library/protocols                  Personal protocols & SOPs
  /library/metrics                    Metric registry: units, ranges, meaning
  /library/tags                       Tag vocabulary

SETTINGS  ───────────────────────────────────────────────────────
/settings                           Settings
  /settings/profile                   Identity, demographics, clinical context
  /settings/appearance                Theme, density, motion
  /settings/capture                   Quick-capture rail configuration
  /settings/notifications             Reminders — opt-in only
  /settings/integrations              Imports: Apple Health, calendar, bank
  /settings/ai                        AI: model tier, consent scopes, spend cap
  /settings/privacy                   Encryption, media keys, redaction
  /settings/data                      Export, import, backup, audit log
  /settings/data/export               Export builder
  /settings/data/audit                Full audit trail viewer
  /settings/developer                 Feature flags, diagnostics, schema version

SYSTEM  ─────────────────────────────────────────────────────────
/auth/sign-in                       Sign in
/auth/callback                      OAuth callback
/offline                            Offline fallback shell
/error                              Error boundary
/404                                Not found
```

### 3.3 Navigation rules

1. **Depth is capped at three.** `/body/skin/photos` is legal; a fourth level is a query parameter or a modal, never a route segment. Deeper hierarchies are unnavigable on mobile and unmaintainable in code.
2. **Every pillar overview is a dashboard of its children, and is itself a lens.** `/mind` is not a folder; it answers *"how is my mental health trending?"* using data that also appears under Body (medication) and Work (stress load).
3. **Cross-cutting entities appear in multiple pillars and are stored once.** Medication is the canonical example: it is clinical data (Body/Health), psychiatric context (Mind), and an event on the medical timeline. One row, three lenses. If you find yourself duplicating a table to serve a second pillar, P3 has been violated.
4. **Quick capture is global.** A floating action available on every route, keyboard-shortcut driven on desktop (`c` then a domain key), reachable from the PWA shortcut menu on mobile. Capture must never require navigation.
5. **Timeline is the escape hatch.** Any entity anywhere links to its position on the timeline; the timeline links back to every entity. This is the connective tissue that makes the system feel like one thing.
6. **`[V2]` and `[V3]` routes do not exist in the shipped MVP.** Not hidden, not disabled, not greyed out — absent. A visible-but-empty module teaches the user that the system is a graveyard (P1's corollary).

---

## 4. Module Breakdown

Format for each module: **Purpose** (the single question) · **Features** · **Relationships** (what it reads and writes across the substrate) · **Dependencies** (what must exist first) · **Future expansion**.

### 4.0 Cross-cutting: the Daily Close

Not a module — the ritual that feeds all of them. Specified here because everything else depends on it.

**Purpose:** capture the day's minimum viable record in under sixty seconds, every day, forever.

**Contents (MVP):** mood (1–5, single tap) · energy (1–5) · anxiety (1–5) · sleep duration and quality · medication taken (toggle per active medication) · skin state (1–5) · one free-text line, optional · anything the quick-capture rail flagged as missed.

**Design constraints:**
- Single screen, no scrolling on a phone. If it does not fit, something must be cut.
- Every field is optional. A partial close counts as a close. This is deliberate: a system that rejects incomplete data trains you to skip it entirely on a bad day, and bad days are the most clinically interesting days you have.
- Never more than eleven interactive elements.
- Adding a field requires removing a field. The Close is a fixed budget, not a growing form.

**Relationships:** writes observations across Mind, Body/Sleep, Body/Skin, and medication adherence. Reads the active medication register and the quick-capture configuration.

### 4.1 Body › Gym

**Purpose:** *Am I getting stronger, and is my training actually progressing?*

**Features:** live session logger with rest timer; exercise library with per-exercise all-time progression; set logging (weight, reps, RPE, notes); program definition and adherence; volume/intensity/frequency analysis by muscle group; personal-record detection; deload suggestion based on volume trend; session templates; superset and drop-set support.

**Relationships:** *writes* workout sessions, set observations, PR events, bodyweight. *Reads* bodyweight for relative-strength calculation, sleep and mood for readiness context, nutrition for surplus context (V2). *Emits* training-load signals consumed by the insight engine, which is what makes "your skin flares two days after high-volume leg sessions" computable at all.

**Dependencies:** exercise library (Library), observation substrate, media storage for form video (V3).

**Future expansion:** velocity-based training if hardware arrives; auto-regulation from readiness score; form-check video with pose estimation; coach export.

**Design note for a beginner lifter:** the logger must default to *last session's numbers* for the same exercise, so the primary interaction is confirming or nudging rather than typing. Typing a weight from scratch every set is a P1 violation.

### 4.2 Body › Skin

**Purpose:** *Is my skin improving, what is driving it, and what have I already tried?*

**Features:** daily state log per region (face, chest, back — the operator's three affected regions); standardised progress photography; side-by-side and time-lapse comparison; AM/PM routine definition with adherence; product register with introduction dates and reaction history; treatment-course tracking with a permanent record of past courses (isotretinoin history); flare annotation with suspected trigger; scar tracking as distinct from active lesions.

**The photography protocol is the module.** Photographs taken under inconsistent lighting, distance, angle, or time of day are not merely lower quality — they are *actively misleading*, because apparent change is dominated by capture variance rather than skin change. The capture flow therefore enforces: a ghost overlay of the previous photo for alignment; a fixed target time-of-day window with a warning outside it; device flash forced to a consistent state; EXIF captured and stored; a lighting-consistency warning derived from median luminance of a fixed facial region compared to the trailing baseline. Photos failing protocol are stored but flagged, and excluded from comparison views by default.

**Relationships:** *writes* skin state observations, photos, product events, treatment courses. *Reads* nutrition (dairy, sugar, whey — directly relevant to a bulking vegetarian-plus-eggs diet), sleep, stress and anxiety markers, training (sweat and friction load), medication changes. *Writes to* the medical timeline for treatment courses and dermatology appointments.

**Dependencies:** encrypted media pipeline, product library, treatment/medical-event model.

**Future expansion:** automated lesion counting on standardised photos (deterministic CV, computed locally, never a generative model); product-ingredient conflict checking; a dermatologist-ready export.

### 4.3 Body › Nutrition — V2

**Purpose:** *Am I hitting the intake my goals require, without spending my life logging food?*

**Features:** meal logging via personal food library first, natural-language second, search last; macro and calorie targets tied to a bulking phase; meal templates for repeated meals; per-meal timing; hydration; supplement tracking; vegetarian-plus-eggs protein-source analysis; trend view against target.

**The ten-second rule.** Most nutrition apps fail because logging is a database search. NaitikOS inverts the hierarchy: (1) *recents and frequents* — one tap, covers the large majority of real intake for a person who eats broadly the same things; (2) *meal templates* — "usual breakfast," one tap; (3) *natural language* — "3 eggs, 100g oats, scoop whey," parsed to structured items with a confirmation step; (4) *search* — the fallback, not the default. If a food is eaten twice, it should never need searching again.

**Relationships:** *writes* meal observations, nutrient totals, hydration. *Reads* bodyweight trend and training volume for target calibration. *Feeds* skin (dietary triggers), gym (surplus adequacy for a bulk), mood and energy (glycaemic patterns), and Vitamin D status.

**Dependencies:** food library, natural-language parsing (§10.6), nutrient reference data.

**Future expansion:** barcode scanning; receipt import; recipe decomposition; micronutrient sufficiency analysis against lab results — which is the payoff, since it lets "your Vitamin D is low and your intake explains it" become a computed statement rather than a guess.

### 4.4 Body › Health core — V2

**Purpose:** *What is my clinical state, what am I taking, and what has actually happened to me?*

**Features:** vitals; lab results with reference ranges and per-analyte trends; conditions register with onset and status; complete medication register including dosage schedule, adherence, side effects, and start/stop reasons; appointments with pre-visit question lists and post-visit notes; symptom log; the medical timeline; the Consultation Pack.

**Bitemporality is mandatory here** (§9.5). *When something happened* and *when you recorded it* are different facts, and in a medical record they must both be preserved. Learning in October that a condition began in March must not rewrite history — the March onset is recorded, and the fact that you did not know until October is also recorded. Any other design produces a record that quietly lies to a clinician.

**Relationships:** the hub of the medical timeline. *Reads from* every Body module and Mind. *Writes* the authoritative medication register consumed by Mind, Skin, and adherence detection across the system.

**Dependencies:** bitemporal event model, document vault (lab PDFs), unit and reference-range registry.

**Future expansion:** FHIR-compatible export; lab-provider API import; pharmacogenomics if ever relevant; interaction checking against a licensed drug database — surfaced as *"discuss with your doctor,"* never as a warning that implies clinical authority (P5).

### 4.5 Body › Teeth — V2

**Purpose:** *What has been done to my teeth, and am I protecting the work?*

Small module, real long-term value. A person with multiple root canals has a dental history that will matter for decades and that no dental practice will reliably retain across relocations, insurers, or practitioner changes.

**Features:** per-tooth procedure history using standard notation; hygiene routine and adherence; appointment cadence with recall reminders; sensitivity and pain log; cost tracking (links to Money in V3); imaging storage.

**Relationships:** *writes* to the medical timeline. *Reads* nutrition (sugar), medication (dry mouth is a documented side effect of several SSRIs and SNRIs — a real and directly relevant cross-domain link for this user).

**Dependencies:** medical event model, document vault.

**Future expansion:** dental imaging comparison; a treatment-plan tracker; the same Consultation Pack pattern applied to dentistry.

### 4.6 Body › Composition & Sleep

**Composition** — *is my body changing in the direction I intend?* Bodyweight with a trend line rather than raw noise (a seven-day moving average is the honest number for a bulk); circumference measurements; physique photography under the same protocol discipline as Skin; rate-of-gain analysis against the bulk target. Reads nutrition and training; writes to Gym for relative-strength calculation.

**Sleep** — *am I recovering?* Duration, quality, timing, consistency, and disturbances. Manual in the MVP, imported in V3. Feeds essentially everything: mood, anxiety, training readiness, skin. Sleep is the highest-leverage cross-domain variable in the entire system and is therefore in the MVP's Daily Close despite Sleep not being a full module until later.

### 4.7 Mind

**Purpose:** *How am I actually doing, and what moves it?*

Given the operator's clinical context — anxiety disorder, active Venlafaxine XR and Escitalopram — this module carries the highest duty of care in the system, and its design principles differ from every other module.

**Features:** mood and energy tracking; anxiety episode logging with intensity, duration, trigger, and coping response; medication adherence and side-effect tracking as a *lens* onto the Health register; journal with optional guided prompts; practice logging (meditation, breathwork, grounding); therapy session notes and between-session action items; trend analysis over clinically meaningful windows.

**Design principles unique to Mind:**
- **No negative framing, ever.** No red. No "you missed." No downward-arrow-in-alarm-colour. State is reported neutrally; deterioration is reported factually and calmly.
- **No causal claims about mental state.** "Your mood has averaged 2.4 this week against a baseline of 3.5" is a fact. "Your mood is low because you skipped the gym" is a claim the system is not entitled to make.
- **Crisis-state awareness.** Sustained severe readings surface one thing only: the user's own pre-configured crisis plan and contacts, entered by them when well. Not an insight. Not a suggestion. Not a model-generated message. A stored plan, shown back.
- **Medication changes are annotated on every chart in the system.** A mood trend without a "started Escitalopram" marker is a misleading chart.
- **Journal content is the most sensitive data in the system** and is subject to the strictest AI consent scope (§10.10).

**Relationships:** reads sleep, training, nutrition, and work load. Writes to the medical timeline. Medication data lives in Health; Mind reads it.

**Dependencies:** medication register, observation substrate, the AI safety layer before any AI touches this module.

**Future expansion:** validated instrument administration (GAD-7, PHQ-9) on a schedule, with results as first-class clinical observations — a genuinely useful thing to hand a psychiatrist; therapist-shared export with granular consent; trigger-pattern analysis; medication-change effect analysis with proper washout windows.

### 4.8 Work — V3

*Am I building the career I want, and what does it cost me?*

**Career** — a running log of accomplishments, artifacts, feedback, and reviews. Solves a real recurring problem: reconstructing a year of work at review time from memory. Every shipped thing gets one line on the day it ships.
**Tasks** — deliberately minimal. Not a competitor to a dedicated task manager. Its purpose is linkage: a task attached to a goal, a project, or a health action.
**Projects** — the container above tasks, linked to career artifacts.
**Learning** — queue, progress, notes, synthesis. Links to Career for skill development.
**Calendar** — read-only import in V3. Its value is context: the load, travel, and meeting density that explains a bad week in every other domain.
**Focus** — deep-work sessions and energy mapping across the day, cross-referenced with sleep and mood.

Relationships: work load is a major input to Mind, Sleep, and Gym adherence. This pillar is the missing variable that explains a great many patterns in the others, which is why it earns its place despite being the least "quantified-self" of the five.

### 4.9 Money — V3

*Where does it go, and is it aligned with what I want?*

Accounts, transactions with categorisation, budgets, subscriptions, shopping, net worth. Last in priority: excellent third-party tools exist, and the cross-domain linkage is thinner than the others. Where it does link, it links well — supplement and skincare spend against outcomes, food spend against nutrition quality, and the correlation between financial stress and anxiety episodes, which is worth knowing.

Import over entry, absolutely (P1). Manual transaction logging will not be sustained and should not be designed for.

### 4.10 Life › Goals — V2

**Purpose:** *Am I moving toward what I said mattered?*

Goals are **not a module with its own data**. A goal is a declaration plus a projection over observations that already exist. "Build muscle" is: a target rate of bodyweight gain, a target trend in key-lift volume, and a rate-of-progress computation over data Gym and Composition already write. Recording progress separately from the underlying observations would create two sources of truth and guarantee drift.

**Features:** goal definition with a measurable target and a horizon; automatic progress derivation; trajectory projection with honest confidence intervals; the review ritual; goal archaeology (why did this stop mattering?); explicit conflict detection between goals — a bulk and a visible-abs goal are in tension, and the system should say so rather than let both quietly fail.

**Relationships:** reads from every module. Writes only goal definitions and review notes.

**Future expansion:** milestone decomposition; effort-versus-outcome analysis across goals; annual goal retrospectives that draw on the full record.

### 4.11 Life › Documents — V2

*Where is the paperwork, and what does it say?*

Encrypted storage for prescriptions, lab reports, insurance, receipts, and identity documents. OCR to extract text; full-text and semantic search; linkage to the entities they evidence (a lab PDF attaches to the lab-result observations it produced); expiry tracking; a permanent, immutable archive.

The design goal is that a lab PDF dropped into the vault becomes structured lab observations with the source document permanently attached as evidence — so the number in your chart can always be traced back to the piece of paper it came from. Provenance is not optional in a medical record.

### 4.12 Life › Reviews — V3

*What actually happened, and what did I learn?*

Weekly, monthly, and annual reviews. Model-drafted from the record, human-edited, permanently archived as first-class documents. The draft is the labour-saving part; the editing is the value. A review the user did not edit is a review they did not do, and the system should treat an unedited draft as incomplete rather than as a completed review.

### 4.13 Insights & Ask — V2

*What should I know that I did not think to ask, and why is this happening?*

**Insight inbox** — at most one insight surfaced on Today per day; the rest queue. Each insight carries its evidence, its method, its confidence, and a plain statement of what it does *not* prove. Dismissible, and dismissals train the ranking. An insight the user cannot audit is an insight they should not trust.

**Ask** — the conversational surface over the graph. Deliberately not the primary interface (see §2.5). Its value is the question you cannot express as a filter: *"what changed in the six weeks before my skin got worse?"* Every answer cites the observations it drew on, and every number in an answer comes from a query the system ran, not from the model's recall.

---
## 5. Technical Architecture

### 5.0 The layering rule

One rule governs the entire codebase, and it exists to satisfy C2:

> **Domain logic must be able to compile and run with zero framework imports.**

`packages/core` may not import React, Next.js, Drizzle, Supabase, or anything with a version number that will change. It contains types, invariants, unit conversions, statistical detectors, and pure derivation functions. It is testable in milliseconds and portable to whatever replaces the current stack in 2034.

Everything above it — the web app, the ORM, the hosting — is replaceable scaffolding. When Next.js is superseded, the rewrite is a UI rewrite, not a product rewrite. This single constraint is worth more over twenty years than every other technical decision in this section combined.

```
┌──────────────────────────────────────────────────────────┐
│  apps/web            Next.js · React · Tailwind          │  replaceable
├──────────────────────────────────────────────────────────┤
│  packages/api        Route handlers · contracts · authz   │  replaceable
├──────────────────────────────────────────────────────────┤
│  packages/db         Drizzle schema · migrations · repos  │  semi-durable
├──────────────────────────────────────────────────────────┤
│  packages/core       Domain model · invariants · stats    │  ★ DURABLE
├──────────────────────────────────────────────────────────┤
│  PostgreSQL          The actual asset                     │  ★★ PERMANENT
└──────────────────────────────────────────────────────────┘
```

### 5.1 Frontend

| Concern | Choice | Reasoning |
|---|---|---|
| Framework | **Next.js (App Router)** | Server Components collapse the data-fetching layer for read-heavy dashboards; route handlers remove the need for a separate API service (C3). |
| Language | **TypeScript, `strict` + `noUncheckedIndexedAccess`** | Non-negotiable at C2 horizons. The types are documentation that cannot rot silently. |
| UI runtime | **React 19** | Server Components, Actions, and `useOptimistic` — the last is directly load-bearing for P1, since a logged set must appear instantly regardless of network. |
| Styling | **Tailwind CSS v4** | CSS-first configuration means the design tokens live in CSS custom properties (§8.1), readable by any future framework. Tailwind is a build-time convenience over a portable token layer, not a lock-in. |
| Components | **shadcn/ui** | Source-in-repo, not a dependency. At a twenty-year horizon, owning the component source is strictly better than depending on a library that may be abandoned. Radix primitives underneath give correct accessibility for free. |
| Server state | **TanStack Query** | Cache, retry, background refetch, and — critically — a persistence layer that doubles as the offline read cache (§5.7). |
| Client state | **Zustand** | Strictly ephemeral UI state: sheet open, rail configuration, active timer. **Zustand never holds server data.** That boundary is enforced in review; violating it produces two sources of truth and is the most common way this pairing goes wrong. |
| Forms | **React Hook Form + Zod** | The same Zod schema validates the form, the route handler, and the domain object. One definition, three enforcement points. |
| Charts | **Recharts**, wrapped | Never used directly in a feature. Every chart goes through `packages/design-system/charts`, so the entire charting library can be swapped in one place (§8.9). |
| PWA | **Serwist** | Actively maintained Workbox successor with first-class Next.js App Router support. |

### 5.2 Backend

**No separate backend service.** Next.js route handlers and Server Actions are the API. A standalone service would be operationally correct for a team and operationally fatal for C3.

The rule that keeps this from becoming a mess: **route handlers are transport, not logic.** A handler parses, authenticates, delegates to a domain service, and serialises. Zero business rules. If a handler exceeds roughly thirty lines, logic has leaked into transport.

```
Request → route handler
            ├─ parse & validate    (Zod contract, shared with client)
            ├─ authenticate        (session → single-user assertion)
            ├─ delegate            (feature service in packages/core)
            ├─ persist             (repository in packages/db)
            └─ serialise           (Zod response contract)
```

**Server Actions** are used for mutations originating in a form. **Route handlers** are used for everything the offline outbox replays, because the outbox needs a stable, idempotent, addressable HTTP endpoint — Server Actions are not a good replay target.

**Typed contracts without tRPC.** Zod schemas in `packages/api/contracts` are imported by both client and server; a thin `apiClient` wrapper infers request and response types from them. This delivers most of tRPC's ergonomics with one fewer framework-coupled dependency, and the contracts remain readable if the transport is ever replaced.

**Background work.** Exactly one scheduled entry point — a nightly job at 03:00 local — which runs derivation, detectors, and rollups in sequence. One cron, idempotent, safe to re-run, and manually triggerable from `/settings/developer`. Every additional scheduled job must justify itself against C3.

### 5.3 Database

**PostgreSQL, everywhere, always.** Supabase-hosted in production; Postgres in Docker locally.

**Deviation recorded:** an earlier scoping conversation proposed seeded SQLite for local development. That is rejected. Dual-dialect Drizzle schemas are a permanent tax, and more decisively, `pgvector` and Postgres full-text search — both load-bearing in §10 — have no SQLite equivalent. Dialect drift between development and production is exactly the class of bug that costs a weekend and cannot be reproduced. One dialect, one `docker compose up`.

| Concern | Choice |
|---|---|
| ORM | **Drizzle** — SQL-shaped, no runtime magic, and migrations are plain SQL files committed to git. Under P2, that migration directory is the schema's permanent changelog. |
| Extensions | `pgvector` (semantic search), `pg_trgm` (fuzzy food/exercise lookup), `pgcrypto`, `btree_gist` (temporal exclusion constraints) |
| Time | **`timestamptz` exclusively**, stored UTC. Every observation additionally stores the IANA zone it was captured in. A workout at "7am" during travel is a materially different fact from one at 7am at home, and discarding the zone destroys information you cannot recover. |
| Numerics | **`numeric` for anything measured.** No floats for weight, dosage, or lab values. A rounding artifact in a medication dosage is unacceptable. |
| IDs | **UUIDv7** — time-ordered, so index locality is preserved without exposing a sequence, and client-generatable, which the offline outbox requires. |
| Money | Integer minor units plus an ISO-4217 currency code. Never a float. |

**Backups.** Supabase's automated backups are the floor, not the plan. A weekly `pg_dump` plus encrypted media snapshot is written to independent storage under a different provider and a different credential. **A backup that has never been restored is a hypothesis, not a backup** — a scripted restore drill into a scratch database runs quarterly and is a calendar commitment, not an intention.

### 5.4 Authentication

Single user (C1), which makes this simpler than instinct suggests — and the instinct to over-engineer it should be resisted.

- **Supabase Auth**, email magic link plus **passkey (WebAuthn) as the preferred factor**. Passkeys give phishing resistance and a better mobile experience than typing a code, which matters for a system opened several times a day.
- **A hardcoded allowlist of exactly one email address**, checked server-side on every request. Sign-up is disabled at the provider. This is the actual authorization model, and its simplicity is a feature.
- **Row Level Security is enabled on every table as defence in depth** — but it is explicitly *not* the primary authorization mechanism. Authorization lives in the API layer where it is testable, readable, and version-controlled. Encoding domain rules in RLS policies is a maintenance trap at C2 horizons: policies are hard to test, hard to diff meaningfully, and hard to reason about two years later.
- **No client-direct-to-database access.** This forgoes Supabase's headline feature deliberately. Going through the API layer means invariants live in one place, the offline outbox has one replay target, and — critically for C2 — Supabase is being used as *hosted Postgres with auth and storage*. Migrating to any other Postgres host becomes a connection-string change plus an auth swap, rather than a rewrite.
- **Session lifetime is long** (30 days, sliding). Re-authenticating a personal daily-use tool constantly is a P1 violation. Sensitive operations — export, encryption-key access, deletion — require step-up re-authentication regardless of session age.

### 5.5 Storage

Three tiers, by sensitivity:

| Tier | Contents | Treatment |
|---|---|---|
| **Public** | App assets, icons | CDN, cacheable, unremarkable |
| **Private** | Documents, receipts, non-body imagery | Supabase Storage, private bucket, short-lived signed URLs (≤ 60 s), server-mediated access only |
| **Sensitive** | Skin photos, physique photos, medical imaging, journal attachments | **Client-side envelope encryption before upload.** The storage provider holds ciphertext it cannot read. |

**Envelope encryption for the sensitive tier.** A per-object AES-256-GCM data key is generated client-side, the object is encrypted in the browser, the data key is wrapped with a master key derived from the user's passphrase via Argon2id, and only the wrapped key is stored. The master key is held in memory for the session and never transmitted.

The consequences are real and must be accepted deliberately: **lose the passphrase and the photos are unrecoverable**, the server cannot generate thumbnails (so thumbnails are generated client-side at capture and stored encrypted alongside), and server-side image analysis is impossible without an explicit client-side decrypt-and-send step. Every one of those costs is worth paying. This is a database of shirtless body photographs documenting a skin condition; "the storage provider promises not to look" is not an acceptable control, and the recovery path is a user-printed recovery code stored offline, established at first setup.

**Media pipeline:** capture → client-side EXIF normalisation and orientation fix → downscale to a fixed long-edge → derive a perceptual hash for duplicate detection → encrypt → upload → store the metadata row with dimensions, capture time, zone, protocol-compliance flags, and the wrapped key.

### 5.6 Caching

| Layer | Mechanism | Notes |
|---|---|---|
| Browser memory | TanStack Query | Domain-appropriate `staleTime`: today's data 30 s, historical data 24 h (it cannot change), reference library data 7 d. |
| Browser disk | Query persister → IndexedDB | Doubles as the offline read cache (§5.7). Explicitly excludes sensitive media. |
| Service worker | Serwist | App shell precached; API responses network-first with a cache fallback. |
| Server | Postgres materialised views | Daily and weekly rollups per metric, refreshed by the nightly job. Turns a five-year trend chart into an index scan over a few thousand rows instead of an aggregation over millions of observations. |
| Model | Anthropic prompt caching | The stable profile prefix (§10.4) is cached across requests. Details and economics in §10.11. |

**Next.js route caching is disabled for all personal data.** Every data route is dynamic. Serving one user's stale data to that same user is a correctness bug in a system whose entire premise is an accurate record, and the performance win does not exist at n=1.

### 5.7 Offline

The PWA must be fully usable in a gym basement with no signal. That is the actual, concrete requirement, and it is the one that dictates the design.

**Rejected: full local-first replication** (SQLite-WASM plus a sync engine, or an ElectricSQL-class system). It solves a harder problem than the one that exists, and the operational and conceptual cost violates C3.

**Adopted: outbox writes plus a persisted read cache.**

```
WRITE   optimistic UI update (useOptimistic)
          → append to IndexedDB outbox { clientId, idempotencyKey, payload, hlc }
          → drain on connectivity / visibility / periodic-sync
          → server upsert on idempotencyKey (replay-safe by construction)
          → reconcile, invalidate, drop from outbox

READ    TanStack Query persisted cache
          → offline: serve from cache, banner states data age
          → online: stale-while-revalidate
```

Four properties make this correct rather than merely convenient:

1. **Client-generated UUIDv7 IDs.** A record created offline has its permanent identity from the moment it exists. No temporary IDs, no re-keying, no reconciliation of references.
2. **Idempotency keys on every mutation.** The outbox may replay any request any number of times; the server deduplicates. Retry safety is structural, not hopeful.
3. **Hybrid logical clocks** on every write. Physical time on a phone is untrustworthy — timezone changes, clock drift, manual adjustment. An HLC gives a total causal order that survives all three.
4. **Single-user last-write-wins, per field.** C1 earns this. With one writer, concurrent-edit conflicts are the narrow case of the same record edited on two of that person's own devices while both were offline. Field-level LWW resolves it correctly in essentially every real instance, and the loser is preserved in the audit trail rather than discarded — so even the rare wrong resolution is recoverable. Building CRDTs for this would be importing multi-user complexity into a single-user system for no benefit.

**Outbox durability is a hard requirement.** A failed drain must never silently discard a write. Entries persist until acknowledged; entries that fail repeatedly surface in a visible "unsynced" state with a manual retry. Losing a logged workout because the drain failed quietly would end the user's trust in the system, and trust is the whole product.

### 5.8 Sync

Sync is the outbox drain plus reconciliation. Beyond §5.7:

- **Per-device sync watermark.** Each device tracks the highest server sequence it has seen; reconnection requests the delta rather than a full refetch.
- **Deletes are tombstones.** Nothing is hard-deleted (P2, §9.4). A delete is a state transition, so it replicates like any other change and can be undone.
- **Schema-version negotiation.** Every sync request carries the client's schema version. A client older than the server's minimum supported version is told to update rather than allowed to write records the server would misinterpret. Over twenty years there will be a stale phone in a drawer; this is what stops it corrupting the record when it wakes up.
- **Clock skew is bounded and surfaced.** Skew beyond five minutes between client and server is flagged in diagnostics rather than silently absorbed.

### 5.9 Notifications

**Opt-in per category, off by default, no exceptions** (P6).

- **Web Push** via VAPID. On iOS this requires the PWA to be installed to the home screen — a genuine platform constraint that must be communicated honestly during onboarding rather than discovered as a bug.
- **Categories:** Daily Close reminder (one, at a user-chosen time) · medication reminder (per medication schedule) · appointment reminder · insight ready (default off) · sync failure (default on — this one is a correctness signal, not engagement).
- **Hard prohibitions:** no streak notifications. No "we miss you." No notification whose content is a metric intended to induce guilt. No more than three notifications in any 24-hour period, enforced server-side as a rate limit rather than left to good intentions.
- **Scheduling** is part of the single nightly job, which enqueues the next day's notifications. No separate scheduler process (C3).

### 5.10 AI layer

Fully specified in §10. Architecturally it is a **sidecar, not a dependency**: every feature in the application must function correctly with the AI layer entirely disabled. The kill switch is a single flag in `/settings/ai`, and the acceptance test for the flag is that the whole product still works with it off.

### 5.11 Analytics

**No third-party analytics. Ever.** (P7.)

Product analytics for a single-user application is largely theatre in any case; the operator can simply be asked. What is genuinely needed is *usage telemetry to protect the metrics in §1.4*:

- An `app_event` table in the same Postgres — capture latency, screen transitions, sync failures, error occurrences.
- Event names and numeric measurements only. **No payloads, ever.** The schema cannot represent user content, which makes leakage impossible rather than prohibited.
- A single internal dashboard at `/settings/developer` renders it.
- Ninety-day retention, then aggregate and discard.

### 5.12 Error handling

**Domain layer:** functions that can fail return an explicit `Result<T, DomainError>`. Domain errors are a closed, enumerated union — `ValidationError`, `NotFound`, `ConflictError`, `PreconditionFailed` — with structured fields. Exceptions are reserved for genuine bugs, not for expected outcomes.

**API layer:** domain errors map to HTTP status codes in exactly one place. Every error response carries a stable machine-readable `code`, a human `message`, and a `traceId`.

**UI layer:** error boundaries per pillar, so a failure in Skin never blanks Today. Every mutation has a defined failure state. **Failure never loses user input** — if a save fails, the entered data stays on screen and enters the outbox.

**A specific rule for this product:** never show a raw error for a *logging* action. The user just recorded something about their body; the correct response to a backend failure is "saved locally, will sync" — which is true, because the outbox has it — not a red toast that makes them wonder whether their workout is gone.

### 5.13 Logging

- **Structured JSON**, one event per line, with `traceId`, `spanId`, `userId`, and `schemaVersion` on every entry.
- **Redaction by construction.** Sensitive fields are wrapped in a `Sensitive<T>` branded type whose serialiser emits `[redacted]`. The logger physically cannot serialise a journal entry, because the type system will not produce the string. Relying on a redaction *list* fails the moment someone adds a field and forgets — relying on a *type* fails loudly at compile time.
- **Levels:** `error` (needs attention) · `warn` (degraded, self-healing) · `info` (state transitions) · `debug` (development only, stripped from production builds).
- **Retention:** 30 days hot, 1 year aggregated, then discarded.
- **The audit log is not the application log.** Audit (§9.4) is domain data, lives in Postgres, and is retained forever. Application logs are operational exhaust and expire.

### 5.14 Security

**Threat model, honestly stated.** The realistic adversaries are: (1) a compromised third-party dependency exfiltrating data — mitigated by having almost no third-party runtime dependencies with network access, plus a strict CSP; (2) a provider-side breach — mitigated by client-side encryption of the sensitive tier, so the provider holds ciphertext; (3) device theft — mitigated by passkeys, session expiry, and passphrase-gated media decryption; (4) the operator's own future carelessness — mitigated by making the secure path the default path.

Controls:

- **Transport:** TLS everywhere, HSTS with preload.
- **CSP:** strict, nonce-based, `default-src 'self'`, no `unsafe-inline`, no `unsafe-eval`. Explicit allowlist for the model API endpoint and nothing else.
- **At rest:** provider encryption for the whole database; additional application-level encryption for the sensitive tier (§5.5).
- **Secrets:** never in the repo. Environment variables in development, provider secret store in production. A pre-commit secret scanner is mandatory, not advisory.
- **Dependencies:** lockfile committed; automated vulnerability scanning in CI; a deliberately small dependency budget. Every new runtime dependency is a decision, and "does this need network access?" is the first question asked of it.
- **Input:** Zod validation at every boundary. Parameterised queries only — Drizzle enforces this structurally.
- **Rate limiting:** on auth and on AI endpoints, primarily as a spend-control measure.
- **No AI training on this data.** Zero-retention configuration where the provider supports it, and no fine-tuning, ever.
- **Export is a security feature.** The ability to leave at any moment with everything is what makes trusting a single provider acceptable.

### 5.15 Deployment

| Environment | Purpose | Data |
|---|---|---|
| `local` | Development | Synthetic seed data, generated, never real |
| `preview` | PR verification | Synthetic seed data — **never production** |
| `production` | The real system | Real |

**Preview deployments must not be able to reach production data.** Separate Supabase project, separate credentials, enforced by the absence of the production connection string in the preview environment rather than by convention. A PR preview that touches a real medical record is an incident.

- **Hosting:** Vercel for the application, Supabase for Postgres, auth, and storage.
- **Migrations** run as a discrete, gated step before deployment — never automatically on boot. An application that migrates its own database on startup will eventually migrate it during a rollback.
- **Rollback:** application rollback is instant via the platform. **Database rollback is not assumed to exist** — every migration must be forward-compatible with the previous application version, so a rollback never strands the schema. This is the single most important operational discipline in the document, because it is the one whose absence causes unrecoverable failures.
- **Exit plan, documented and tested annually:** `pg_dump` + storage sync + `docker compose up` reproduces the entire system on any machine. Vendor lock-in is measured by how long it takes to leave, and that number should be known, not guessed.

### 5.16 Monitoring

Proportionate to C3 — enough to know something is wrong, not so much that it becomes a second system to maintain.

- **Uptime:** external HTTP check every five minutes against a health endpoint that verifies database connectivity.
- **Nightly job:** must write a completion record. Absence of the record by 05:00 raises an alert. A silent failure of the derivation job degrades every insight in the system and is invisible without this check.
- **Backup verification:** automated weekly assertion that a backup exists and is non-trivially sized; quarterly scripted restore drill.
- **AI spend:** hard monthly cap enforced in code with a soft warning at 70%. Requests beyond the cap fail closed with a clear message rather than generating a surprise bill.
- **Error rate:** self-hosted aggregation from `app_event`; alert on a sustained rise.
- **Sync health:** outbox depth and age. An outbox entry older than 24 hours is an alert, because it means data the user believes is saved is not.
- **Data-integrity assertions**, run nightly: no observation dated in the future; no medication with an end date before its start; no orphaned media rows; no observation referencing an unregistered metric key. These catch the class of bug that silently corrupts a longitudinal record and is otherwise discovered years later.

---

## 6. Repository Structure

### 6.1 Shape and tooling

A **pnpm workspace monorepo with Turborepo**. Justified even at one application, because the point is not multiple apps — it is *enforcing the layering rule in §5.0*. A package boundary makes "core must not import React" a build error rather than a code-review reminder. Over twenty years, the boundary is the whole value.

```
naitikos/
├── apps/
│   └── web/
├── packages/
│   ├── core/
│   ├── db/
│   ├── api/
│   ├── ai/
│   ├── design-system/
│   ├── shared/
│   └── config/
├── docs/
├── prompts/
├── scripts/
├── tests/
├── assets/
├── .github/
├── docker-compose.yml
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### 6.2 Every folder, and why it exists

#### `apps/` — deployable artifacts

Anything that can be built and run on its own. Today that is one Next.js application; the folder exists anyway, because the day a CLI or an ingestion worker is needed, its location is already decided and no restructuring is required.

```
apps/web/
├── app/                        Next.js App Router — routing ONLY
│   ├── (today)/                Route group per surface (§3.2)
│   ├── (pillars)/
│   ├── (timeline)/
│   ├── (library)/
│   ├── (settings)/
│   ├── api/                    Route handlers — transport only
│   ├── layout.tsx
│   └── manifest.ts             PWA manifest
├── features/                   ★ where the application actually lives
├── components/                 App-level composition only
├── hooks/                      App-level cross-cutting hooks
├── lib/                        App wiring: providers, query client, SW registration
├── public/
└── styles/
```

**The critical rule:** `app/` contains routing and nothing else. A page file imports a feature's exported screen component and renders it. Twelve lines, typically. This keeps the application decoupled from the routing framework — when the router changes, `app/` is rewritten and `features/` is untouched. That is C2 applied to the frontend.

#### `packages/core/` — ★ the durable layer

Domain model, invariants, unit conversions, statistical detectors, derivation functions. **Zero framework imports, enforced by an ESLint boundary rule that fails the build.**

```
packages/core/
├── domain/          Entities, value objects, invariants (per domain)
├── observations/    The observation substrate model
├── temporal/        Bitemporal helpers, HLC, timezone-aware date logic
├── units/           Unit system and conversion — kg/lb, mg/mcg, mmol/mg-dL
├── statistics/      Correlation, changepoint, trend, moving averages
├── detectors/       Deterministic insight detectors (§10.6)
├── derivation/      Pure functions: observations → derived facts
└── errors/          The closed DomainError union
```

Why it must be separate: it is the only part of the system intended to survive two decades. Isolating it means it can be tested exhaustively, reasoned about in isolation, and carried forward across every rewrite.

The `units/` subpackage deserves specific mention. Unit confusion in a medical record is a real, documented category of harm. Every measured quantity is a `Quantity { value: Decimal, unit: Unit }`, never a bare number, and conversion is total and tested. There is no path by which milligrams become micrograms.

#### `packages/db/` — persistence

```
packages/db/
├── schema/          Drizzle table definitions, one file per domain
├── migrations/      ★ Generated SQL, committed, append-only, never edited
├── repositories/    Query implementations behind core-defined interfaces
├── views/           Materialised view definitions
├── seed/            Synthetic data generators for dev and test
└── client.ts
```

`migrations/` is the schema's permanent changelog and the physical embodiment of P2. A migration that has been applied to production is immutable — corrections come as new migrations, never as edits. In year eight, this directory is how anyone reconstructs why the schema looks the way it does.

Repositories exist so `core` can define `interface ObservationRepository` without knowing Drizzle exists — dependency inversion, which is what actually makes the durable layer durable.

#### `packages/api/` — contracts and transport

```
packages/api/
├── contracts/       Zod request/response schemas — imported by BOTH sides
├── handlers/        Handler implementations, thin
├── client/          Typed fetch client inferred from contracts
├── middleware/      Auth, rate limit, tracing, idempotency
└── errors/          Domain error → HTTP mapping
```

`contracts/` is the reason this is a package rather than a folder in the app: it is imported by client and server, and the shared import is what makes the type safety real rather than aspirational.

#### `packages/ai/` — the intelligence layer

```
packages/ai/
├── context/         Context Engine: retrieval, ranking, budgeting
├── memory/          Memory tiers (§10.1)
├── graph/           Knowledge graph construction and traversal
├── embeddings/      Local embedding generation and vector search
├── engines/         Insight, recommendation, prediction, goal
├── guardrails/      ★ The medical safety layer (§10.10)
├── schemas/         Structured output schemas
└── client/          Model client, caching, budget enforcement
```

Separate from `core` because it has network dependencies and non-deterministic behaviour, and `core` must have neither. Separate from `apps/web` because it must be runnable headlessly by the nightly job and testable without a browser.

`guardrails/` is deliberately a sibling of `engines/` rather than a utility inside it. It is a boundary every engine output crosses, and its position in the tree should say so.

#### `packages/design-system/` — the visual layer

```
packages/design-system/
├── tokens/          ★ Source of truth: JSON → CSS vars + TS types
├── primitives/      shadcn-derived: Button, Input, Dialog, Sheet…
├── patterns/        Composed: StatTile, MetricCard, TrendChart, EmptyState
├── charts/          The ONLY place a charting library is imported
├── icons/           Curated icon set with a stable name→glyph map
├── motion/          Motion tokens and shared variants
└── styles/          Tailwind preset, global CSS
```

Separate from the app because it is the answer to "how do we redesign in year six without rewriting features?" Features import `MetricCard`; they never import Tailwind classes for a card. When the visual language changes, the design system changes and features do not.

`charts/` being the sole import site for the charting library is what makes replacing Recharts a one-package change rather than a repo-wide search.

#### `packages/shared/` — genuinely universal utilities

Result types, branded types, `Sensitive<T>`, ID generation, date formatting, type guards, assertion helpers.

**Guarded aggressively.** `shared` is where dumping grounds are born. The admission test: *would this be equally at home in a completely different product?* If not, it belongs in a feature or in `core`. This test is applied in review, and the package is audited quarterly for things that have drifted in.

#### `packages/config/` — shared configuration

TypeScript base configs, ESLint config including the boundary rules, Prettier, Tailwind preset, Vitest base config.

Exists so that "core may not import React" is written once, as a lint rule, and enforced everywhere automatically. Configuration duplicated across packages drifts; configuration in a package does not.

#### `docs/` — durable reasoning

```
docs/
├── BLUEPRINT.md            This document
├── adr/                    Architecture Decision Records, numbered, immutable
├── domain/                 Per-domain modelling notes
├── runbooks/               Restore drill, migration, incident, key rotation
├── api/                    Generated contract reference
└── decisions/              Product decision log
```

ADRs matter more here than in most projects. In year seven, "why is medication history bitemporal?" must have a findable, dated answer written by someone with the context. ADRs are append-only; a superseded ADR is marked superseded and left in place, because the reasoning that was later overturned is itself information.

`runbooks/` exists because C3 means the operator will be executing a database restore having not thought about the system for two months. The runbook is written for that person, not for the person who built it.

#### `prompts/` — prompts as versioned source

```
prompts/
├── system/          Base system prompts per engine
├── tasks/           Task-specific templates
├── schemas/         Structured output JSON schemas
├── evals/           ★ Golden test cases with expected properties
└── CHANGELOG.md
```

Prompts are **source code and are versioned as such** — never inline string literals. A prompt change alters system behaviour exactly as a code change does and must be diffable, reviewable, and revertible.

`evals/` is what makes prompt changes safe. A prompt edit runs against golden cases and asserts properties: that no diagnosis is present, that every number in the output traces to a supplied observation, that required citations exist. A prompt change failing evals fails CI, exactly like a broken test.

#### `scripts/` — operational tooling

Seed, export, import, backup, restore-drill, key-rotation, migration-generation, embedding-backfill, health-check. Every recurring manual operation becomes a script the first time it is performed twice. Under C3, a documented manual procedure will be executed wrongly; a script will not.

#### `tests/` — cross-cutting tests

```
tests/
├── e2e/             Playwright: critical user journeys
├── integration/     Full-stack against a real Postgres in Docker
├── fixtures/        Shared synthetic data
└── setup/
```

Unit tests live beside the code they test, inside feature slices (§7). This directory holds only tests that span package boundaries and therefore have no single natural home.

#### `assets/` — non-code source material

Source SVGs, brand assets, font licences, illustration sources, design-tool exports. Kept out of `public/` because these are *sources*, not shipped artifacts — the `.svg` a build step optimises into `public/` belongs here.

#### `config/` — root-level environment configuration

Environment schemas validated with Zod at boot, feature-flag defaults, `docker-compose.yml`, and cron definitions. Environment variables are validated at startup and the application refuses to boot on a missing or malformed variable — failing at boot with a clear message is dramatically better than failing at 3am inside the nightly job.

### 6.3 On `components/`, `hooks/`, and `services/`

The initial folder list named these as top-level directories. **They are deliberately not top-level here**, and the reason is the central organising claim of §7.

A top-level `components/` directory becomes a bag of two hundred files with no expressible relationship to each other. Six months in, nobody knows whether `SkinPhotoCard` is used once or forty times, whether deleting it is safe, or where its logic lives. The same fate awaits `hooks/` and `services/`.

Instead, they exist **at two scopes**:

| Scope | Location | Contains |
|---|---|---|
| Feature | `features/<name>/components/` | Everything used by exactly one feature — the overwhelming majority |
| Application | `apps/web/components/` | Composition used by three or more features: `AppShell`, `PillarNav`, `QuickCaptureRail` |
| Design system | `packages/design-system/` | Domain-agnostic visual primitives |

The promotion rule is explicit: **a component becomes app-level on its third consumer, and becomes a design-system primitive only when it contains no domain knowledge.** Promotion is a deliberate act with a code review, not a default.

`services/` follows the same logic. Feature services live in the feature slice; the ones that are genuinely domain-wide are `core` services. There is no third category, and a top-level `services/` folder would invent one.

---

## 7. Feature-First Folder Structure

### 7.1 Why features rather than layers

Layer-first organisation (`components/`, `hooks/`, `services/`, `types/` at the top) optimises for a question nobody asks — *"show me all the hooks"* — and pessimises the question asked constantly: *"where is everything about skin photos?"*

At the scale of sixteen domains, layer-first produces a codebase where every change touches five directories, nothing can be deleted with confidence because its blast radius is unknowable, and the module boundaries that exist in the product exist nowhere in the code.

Feature-first inverts it. A feature is a vertical slice with an explicit public API. Under C3 specifically, the ability to load one directory into working memory and understand a whole domain is worth more than any other organisational property.

### 7.2 The anatomy of a feature

```
apps/web/features/skin/
├── index.ts                    ★ THE PUBLIC API — the only legal import path
│
├── components/
│   ├── SkinStateLogger.tsx
│   ├── PhotoCaptureFlow.tsx
│   ├── PhotoComparisonView.tsx
│   ├── RoutineAdherenceCard.tsx
│   ├── ProductRegister.tsx
│   └── __tests__/
│
├── hooks/
│   ├── useSkinState.ts             read model
│   ├── useLogSkinState.ts          mutation + optimistic update
│   ├── usePhotoCapture.ts          capture protocol state machine
│   ├── useRoutineAdherence.ts
│   └── __tests__/
│
├── services/
│   ├── skinStateService.ts         orchestration, no React
│   ├── photoProtocolService.ts     ★ protocol validation (§4.2)
│   ├── adherenceService.ts
│   └── __tests__/
│
├── api/
│   ├── contracts.ts                Zod schemas — imports packages/api
│   ├── client.ts                   typed calls
│   └── handlers.ts                 route handler implementations
│
├── store/
│   └── captureStore.ts             Zustand: EPHEMERAL UI STATE ONLY
│
├── types/
│   ├── skin.types.ts               feature-local types
│   └── index.ts
│
├── validators/
│   ├── skinState.schema.ts         Zod — the single source of validation truth
│   ├── photoMetadata.schema.ts
│   └── __tests__/
│
├── screens/
│   ├── SkinOverviewScreen.tsx      what app/ routes render
│   ├── SkinPhotosScreen.tsx
│   └── SkinRoutineScreen.tsx
│
├── constants.ts
└── README.md                       ★ what this feature owns, and what it doesn't
```

### 7.3 What each subfolder is for

| Folder | Responsibility | Rule |
|---|---|---|
| `index.ts` | The public API | Exports screens, a small number of shared components, and public types. **Nothing else is importable from outside.** Enforced by lint. |
| `components/` | Feature-specific UI | Presentational where possible. Data arrives via props or the feature's own hooks. |
| `hooks/` | React binding | The bridge between services and components. Where TanStack Query lives. No business logic — hooks *call* services. |
| `services/` | Orchestration | Plain TypeScript, no React. Coordinates API calls, invokes `core` domain functions, handles multi-step flows. Directly unit-testable. |
| `api/` | The network boundary | Contracts, client, handlers together. Colocating them means a contract change surfaces both sides in one diff — the single most effective defence against client/server drift. |
| `store/` | Ephemeral UI state | Zustand only. **Never server data.** If a store field could be refetched from the server, it is in the wrong place. |
| `types/` | Feature-local types | Types crossing feature boundaries move to `packages/core`. |
| `validators/` | Zod schemas | One definition validating form, request, and domain object. |
| `screens/` | Route-level composition | The only components `app/` imports. Assemble components, wire hooks, handle layout. |
| `README.md` | Orientation | Six sentences: what it owns, what it reads from others, what it emits, what it deliberately does not do. |

### 7.4 The rules that keep it from decaying

**R1 — Features import each other only through `index.ts`.**
`import { SkinOverviewScreen } from '@/features/skin'` is legal. `import { photoProtocolService } from '@/features/skin/services/photoProtocolService'` is not, and fails lint. Without this, the boundary is decorative.

**R2 — Features must not import each other's internals, and should rarely import each other at all.**
When Skin needs nutrition data, it does not import the Nutrition feature. It queries the *observation substrate* (P3). Features are lenses over shared data, not modules that call each other. This is what prevents the dependency graph from becoming a mesh.

**R3 — Shared logic moves down, never sideways.**
Two features needing the same thing means it belongs in `packages/core`, not in one feature importing the other. Sideways dependencies are how a feature-first codebase quietly becomes a layered one with extra steps.

**R4 — A feature owns its data model but not the substrate.**
Skin defines what a skin observation *means*; the observation table belongs to `core`. Features never own tables that another feature legitimately needs to read.

**R5 — Cross-cutting reads go through the substrate, always.**
Skin needing training volume queries `core/observations` with a metric key. It does not call into Gym. This is the technical enforcement of P3 and the single most important rule in this section.

**R6 — A feature can be deleted in one commit.**
The test of whether the boundaries are real: remove the directory, remove its routes, remove its metric-key registrations. If anything else breaks, the boundary was fictional. This is verified for real at least once during development, on a throwaway branch, because a boundary you have never tested is a boundary you do not have.

### 7.5 The feature map

```
features/
├── today/          The Daily Close, quick capture, the Now panel
├── gym/            Sessions, exercises, programs, volume
├── nutrition/      Meals, foods, targets                        [V2]
├── composition/    Weight, measurements, physique
├── skin/           State, photos, routine, products, treatments
├── teeth/          Procedures, hygiene                          [V2]
├── health/         Vitals, labs, conditions, medications        [V2]
├── sleep/          Duration, quality, consistency
├── mind/           Mood, anxiety, journal, practices
├── career/         Work log, artifacts, reviews                 [V3]
├── tasks/          Tasks and projects                           [V3]
├── learning/       Queue, notes, synthesis                      [V3]
├── calendar/       Import, load analysis                        [V3]
├── finance/        Accounts, transactions, budgets              [V3]
├── goals/          Definitions and projections                  [V2]
├── documents/      Vault, OCR, search                           [V2]
├── timeline/       Chronological views, medical timeline
├── insights/       Inbox, detail, evidence                      [V2]
├── ask/            Conversational surface                       [V2]
├── reviews/        Weekly, monthly, annual                      [V3]
├── library/        Reference data management
└── settings/       All configuration
```

Note that this list is *longer* than the pillar list, because features are implementation units while pillars are navigational groupings. `/body/skin` is served by the `skin` feature; `/body` is served by a thin composition in `apps/web/components` that renders summaries the pillar features export. Conflating the two would force either bloated features or a navigational structure dictated by code layout — and navigation should be dictated by the user's questions (P8).

---

## 8. Design System Architecture

### 8.1 Token architecture

Three tiers, strictly ordered. **A component may only reference tier 3.**

```
TIER 1 — PRIMITIVES        raw values, no meaning
  --color-slate-500: oklch(55% 0.02 250);
  --space-4: 1rem;
  --duration-fast: 150ms;

TIER 2 — SEMANTIC          meaning, theme-dependent
  --color-surface: var(--color-slate-50);
  --color-text-primary: var(--color-slate-900);
  --color-accent: var(--color-indigo-600);
  --color-positive / --color-caution / --color-critical

TIER 3 — COMPONENT         component-scoped contracts
  --card-bg: var(--color-surface-raised);
  --card-border: var(--color-border-subtle);
  --metric-value-color: var(--color-text-primary);
```

Why three: tier 1 alone means a redesign edits every component. Tier 2 alone means a component cannot be adjusted without affecting everything sharing its semantic token. Tier 3 gives per-component escape hatches without leaking raw values upward. This is the structure that makes a year-six redesign a token change rather than a rewrite.

**Tokens are authored as JSON and generated** into CSS custom properties, TypeScript constants, and the Tailwind preset. One source, three consumers, no drift. Under P2 the JSON is the portable artifact — readable by whatever styling technology exists in 2038.

**OKLCH for all colour.** Perceptually uniform lightness means a programmatically generated dark theme is actually legible, and contrast ratios behave predictably rather than requiring per-colour hand-tuning.

### 8.2 Colour semantics — and a product constraint

The semantic palette is deliberately restrained, because this application displays health data to someone with an anxiety disorder (P6), and colour is the fastest emotional channel in a UI.

| Token | Use | Explicitly not for |
|---|---|---|
| `--color-accent` | Interactive elements, primary actions, the current selection | Emphasis on data |
| `--color-positive` | Confirmed completion, target met | "Good" health readings |
| `--color-caution` | Requires attention, expiring, unsynced | "Concerning" readings |
| `--color-critical` | Destructive actions, genuine errors | **Never a health metric. Ever.** |
| `--color-neutral-{1..4}` | Data visualisation, default state | — |

**The rule: health data is never coloured by valence.** A mood of 2 is not red. A missed medication dose is not red. Body-fat percentage is not red. Health data is rendered in neutral or sequential palettes; deviation is communicated through *position relative to a baseline*, not through alarm colour. Colour-as-judgement turns a tool into a critic, and a critic is not something you open every day.

The one deliberate exception: sync failure and data loss risk use `--color-caution`, because those are *system* states requiring user action, not statements about the user.

### 8.3 Typography

A two-family system:

- **Interface:** Inter Variable. Chosen for tabular figures, extensive Unicode coverage, and legibility at small sizes.
- **Numeric:** the same family with `font-variant-numeric: tabular-nums` applied by default to every measured value. Non-tabular figures make columns of numbers jitter, which reads as instability in a data-dense product.
- **Long-form:** a serif — Source Serif 4 — for journal entries and reviews. This is not decoration: a visual mode-switch between *recording data* and *writing reflectively* is a genuine cognitive cue, and journaling is a core Mind interaction.

Scale — a modular scale at 1.2, mapped to semantic roles rather than sizes:

```
display   36 / 40   -0.02em   600      hero metric on a pillar overview
title-1   24 / 32   -0.01em   600      screen title
title-2   20 / 28   -0.01em   600      section
title-3   16 / 24    0        600      card
body      15 / 24    0        400      default
body-sm   13 / 20    0        400      secondary
caption   12 / 16    0.01em   500      labels, units, timestamps
metric-l  32 / 36   -0.02em   600 tab  primary metric value
metric-m  20 / 24   -0.01em   600 tab  secondary metric
mono      13 / 20    0        400      IDs, codes, technical
```

Fonts are self-hosted and subset. No third-party font CDN — that is both a P7 leak and a rendering dependency on someone else's uptime.

### 8.4 Spacing and layout

A 4px base grid, exposed as `--space-0` through `--space-24`. Every margin, padding, and gap references a token; arbitrary values fail lint.

**Density is a first-class setting.** `comfortable` (default) and `compact` swap the spacing scale via a data attribute on the root. A person reviewing five years of lab results wants compact; the same person logging a set mid-workout wants comfortable. Supporting both from one token layer costs almost nothing and is only possible because spacing was tokenised from day one.

Layout primitives — `Stack`, `Inline`, `Grid`, `Container` — take token-typed gaps. Ad-hoc flexbox in feature code is discouraged, because layout consistency is what makes a sixteen-domain application feel like one product rather than sixteen.

Breakpoints: `sm 640 · md 768 · lg 1024 · xl 1280`. **Mobile-first without qualification** — the phone is where capture happens, and capture is the product (P1). Desktop is the analysis surface and gets progressive enhancement, never the reverse.

### 8.5 Iconography

A single curated set — Lucide — accessed through a named map in `design-system/icons`, never imported directly by features.

The indirection buys three things: the icon set can be replaced in one file; every icon has a semantic name (`icon.medication`, not `Pill`) so meaning survives a set change; and unused icons are trivially auditable. Icons never appear without a text label or an `aria-label`, and never as the sole carrier of meaning.

Sizes are tokenised at 16 / 20 / 24 / 32, aligned to the type scale so an icon beside text always sits on the same optical baseline.

### 8.6 Motion

Motion is functional. It communicates causality, continuity, and state change — never delight for its own sake.

```
--duration-instant  100ms   state feedback (toggle, press)
--duration-fast     150ms   micro-interactions
--duration-normal   250ms   sheets, dialogs, transitions
--duration-slow     400ms   page-level, deliberate

--ease-out          cubic-bezier(0.16, 1, 0.3, 1)     entering
--ease-in           cubic-bezier(0.7, 0, 0.84, 0)     exiting
--ease-in-out       cubic-bezier(0.87, 0, 0.13, 1)    moving
--ease-spring       spring(1, 90, 12, 0)              physical/draggable
```

`prefers-reduced-motion` is honoured globally, implemented once at the motion-provider level rather than per-component. Under reduced motion, transforms become opacity changes and durations collapse to `instant`.

**Nothing animates on data load.** Charts do not draw themselves in. A number that animates while you are trying to read it is a number you cannot read, and animated data entry subtly implies the value is being computed rather than retrieved. Skeletons do not shimmer; they hold layout.

### 8.7 Dark mode

Dark is the **default**, with light available. This is a real decision, not a preference: the application is opened last thing at night for the Daily Close and in a dimly lit gym. Defaulting to light and requiring a setting change is optimising for the wrong context.

Implemented as a semantic-token remap, not a class-based override — every tier-2 token has a dark value; tier 3 and components are unchanged. Both themes are contrast-audited in CI (§8.13).

Dark-mode specifics that are easy to get wrong and are therefore specified: never pure black (`oklch(15% …)` base — pure black causes OLED smearing on scroll and excessive contrast fatigue); elevation is conveyed by lightness, not shadow, since shadows are near-invisible on dark surfaces; and chart colours are a *distinct* palette rather than the light palette inverted, because saturated hues that read correctly on white vibrate unpleasantly on dark.

### 8.8 Cards

Cards are the primary container. Four variants, and no more, because container proliferation is how visual systems lose coherence:

| Variant | Use |
|---|---|
| `flat` | Grouping without emphasis. No border, no shadow — the default. |
| `outlined` | Distinct entity. 1px subtle border. |
| `raised` | Elevated content — modals, popovers. Subtle shadow. |
| `interactive` | Whole card is a target. Hover and focus states, cursor affordance. |

Every card composes `Card`, `CardHeader`, `CardBody`, `CardFooter` with tokenised internal spacing. Every card supports an empty state; **an empty card is a designed state, not a blank rectangle.** Given that this system will legitimately have empty modules for long periods, empty states are a primary design surface rather than an afterthought — each one states what would appear here and offers the single action that would populate it.

### 8.9 Charts

Charts are the highest-risk area of the design system, because a misleading chart in a health application produces a wrong decision about a body.

> **Binding note for implementation:** when the chart layer is actually built, the `dataviz` skill is the source of truth for the palette formula, its accessibility validator, mark specifications, and interaction rules. This section specifies the *architecture and the invariants*; that skill specifies the *execution*, and its palette must be adopted rather than reinvented.

**Architecture.** Exactly one package imports the charting library. Features import `<TrendChart>`, `<DistributionChart>`, `<AdherenceGrid>`, `<ComparisonChart>` — never Recharts. The chart components accept a normalised series shape defined in `core`, which means the entire library is swappable and, more importantly, that every chart in the application shares one set of behaviours.

**Chart selection is prescribed, not chosen per-instance:**

| Question | Form |
|---|---|
| How has one metric moved over time? | Line with a trend band |
| How much of something, per period? | Bar |
| Did I do the thing, on which days? | Adherence grid (calendar heatmap) |
| How do two metrics relate? | Scatter with a fitted line and an explicit r value |
| What is the composition of a total? | Stacked bar — **never a pie** |
| How does now compare to then? | Small multiples, shared y-axis |

**Non-negotiable invariants:**

1. **Y-axis truncation must be labelled.** A weight chart from 74–76 kg is legitimate and useful, and it is also visually dramatic. The axis break is explicitly marked. An unlabelled truncated axis is a lie told in a health application.
2. **Annotations for interventions.** Every time-series chart renders medication starts and stops, treatment courses, and travel as vertical markers. A mood chart without the "started Escitalopram" marker is actively misleading.
3. **Missing data is shown as missing.** Gaps are gaps. Lines break. Interpolation across a week of no data is fabrication.
4. **Confidence must be visible where it exists.** Trend lines carry a band. A projection is rendered dashed with an interval.
5. **Colour never encodes valence** (§8.2). Sequential palettes for magnitude, categorical for series, diverging only around a genuine, labelled midpoint.
6. **Every chart has a table.** A toggle reveals the underlying values. This serves screen-reader users, satisfies "what exactly was that number," and — usefully — forces the data to be correct before the visual is trusted.
7. **Charts are readable at 360px wide.** Mobile is not a degraded case; it is the common case.

### 8.10 Forms

Forms are where P1 is won or lost, so the defaults are aggressive:

- **The right keyboard, always.** Numeric inputs get `inputmode="decimal"`. Getting this wrong adds two seconds to every entry, forty times a week, forever.
- **Steppers over text entry** for bounded values. Logging a set is `+2.5 kg`, not typing `62.5`.
- **Last value pre-filled** wherever a sensible prior exists. Confirming beats typing.
- **Inline validation on blur**, never on keystroke. Validating while someone types is hostile.
- **Autosave for anything long-form.** Journal entries save continuously. Losing a written reflection to a navigation is unforgivable.
- **Every input has a visible label.** Placeholder-as-label is an accessibility failure and disappears exactly when the user needs it.
- **Units are displayed, always,** and are a display concern — values are stored canonically (§6.2, `core/units`).

Field types are standardised: `TextField`, `NumberField`, `QuantityField` (value + unit), `ScaleField` (the 1–5 tap used throughout the Daily Close), `DateField`, `TimeField`, `SelectField`, `ComboboxField`, `ToggleField`, `TextAreaField`, `PhotoField`, `TagField`.

### 8.11 Tables

For dense historical data: labs, transactions, session history.

Column definitions are declarative and typed. Sticky headers and a sticky first column. Numeric columns right-aligned with tabular figures. Sortable and filterable, with state in the URL so a view can be bookmarked and returned to. Row density follows the global density setting. Pagination is virtualised — a five-year transaction history is tens of thousands of rows.

**On mobile, tables become card lists.** A horizontally scrolling table on a phone is a table nobody reads. The same column definitions drive both renderings, so there is no second implementation to keep in sync.

### 8.12 Dialogs, sheets, and overlays

| Component | Use | Placement |
|---|---|---|
| `Dialog` | Focused task requiring confirmation | Centred, modal |
| `Sheet` | Contextual detail or capture | Bottom on mobile, right on desktop |
| `Popover` | Lightweight secondary content | Anchored |
| `Tooltip` | Supplementary label — never essential information | Anchored |
| `Toast` | Transient confirmation | Bottom, auto-dismissing |
| `AlertDialog` | Destructive confirmation | Centred, requires explicit action |

All built on Radix, so focus trapping, focus restoration, escape handling, and scroll locking are correct without reimplementation. Sheets are the primary mobile pattern — bottom sheets are reachable one-handed, which matters when logging a set with a phone in one hand.

**Destructive actions never rely solely on a confirm dialog.** Deletion is soft (§9.4) and produces an undo toast. Confirmation dialogs train people to click through them; undo actually protects data.

### 8.13 Accessibility

Not a checklist item. The operator will use this at 6am half-awake, in a gym with sweaty hands, and in bed at night with a dimmed screen. Accessibility here is ordinary usability under realistic conditions.

**Enforced targets:**

- **WCAG 2.2 AA minimum; AAA for body text** (7:1). Contrast is verified in CI — token pairings are computed and asserted, in both themes, so a failing pairing cannot be merged. This is a test, not a review comment.
- **Touch targets ≥ 44×44px**, with ≥ 8px separation. Non-negotiable for gym use.
- **Full keyboard operability.** Every action reachable, visible focus rings using a dedicated `--focus-ring` token, logical tab order, skip links.
- **Screen reader support.** Semantic HTML first, ARIA only where semantics are insufficient. Live regions for async results. Charts expose their data table.
- **Motion.** `prefers-reduced-motion` honoured globally (§8.6).
- **Text scaling.** Layout survives 200% browser zoom without horizontal scroll — which requires relative units and no fixed heights on text containers.
- **Colour independence.** No information conveyed by colour alone; every colour-coded state carries a shape, icon, or label. This also happens to be what makes charts legible when printed for a doctor.

**Automated in CI:** axe-core on every route, contrast assertions on the full token matrix, and a keyboard-navigation E2E path through the Daily Close — the one flow that must never regress.

---
## 9. Database Blueprint

*No SQL in this section — entities, relationships, and the reasoning behind them. Physical definitions live in `packages/db/schema`.*

### 9.1 The central decision: two kinds of data

The most consequential modelling choice in the system is recognising that "life data" is actually two different things with different rules.

| | **Observations** | **Entities** |
|---|---|---|
| What | Something that was true at a moment | Something that exists and changes |
| Examples | Bodyweight 74.2 kg at 07:12 · mood 3 · a set of 8 reps at 60 kg | An exercise · a medication · a goal · a product |
| Mutability | **Immutable.** Never updated, never deleted. | Mutable, with full version history |
| Correction | A superseding observation that references the original | An update, with the prior version retained |
| Volume | High, monotonically growing forever | Low, bounded |
| Purpose | The historical record | The vocabulary the record is written in |

**Observations are append-only.** This is not a stylistic preference; it is what makes a twenty-year record trustworthy. If a weight from 2027 can be silently edited in 2031, then no number in the system can be relied upon and the entire premise fails. Corrections are additive: a new observation marks the old one superseded, both persist, and the timeline can be replayed as it was known at any past moment.

Everything else in this section follows from that split.

### 9.2 Entity catalogue

#### Identity & configuration
`profile` — one row, forever. Demographics, clinical context, timezone, locale, units preference.
`setting` — key/value with typed schema. Theme, density, capture rail configuration, AI consent scopes, notification preferences.
`feature_flag` — runtime toggles, including the AI kill switch.
`crisis_plan` — the Mind module's pre-written safety plan and contacts (§4.7). Deliberately its own entity so it is never mixed with settings and never accidentally cleared.

#### The substrate
`metric` — **the registry, and the most important table in the system.** Every measurable thing is registered before it can be observed: a stable key (`body.weight`, `mind.mood`, `gym.set.load`), canonical unit, value type, valid range, aggregation semantics (sum, mean, last, max), and a human description. Unregistered metric keys are rejected on write.

This registry is what makes P3 real. Skin can query training volume without knowing Gym exists, because both speak the metric vocabulary. It is also the thing that makes the data self-describing in year fifteen — a bare `74.2` is meaningless, but `74.2` joined to its metric row is a complete fact.

`observation` — the spine. Metric key, value, unit, `observed_at` (with IANA zone), `recorded_at`, source, confidence, optional subject reference to the entity it concerns, optional context payload, superseded-by pointer.

`observation_source` — where a fact came from: manual entry, device import, derivation, document extraction, or model inference. **Provenance is mandatory, not optional.** A derived value must be distinguishable from a measured one forever, and a model-inferred value must be distinguishable from both.

`sample` — high-frequency device data, kept structurally separate from `observation`. Reasoning in §9.7.

`tag` / `entity_tag` — a controlled vocabulary applied across every domain, enabling cross-cutting queries like "everything tagged *travel*."

#### Temporal and medical — bitemporal (§9.5)
`medical_event` — the supertype of everything clinically significant. Type, valid-time interval, transaction-time interval, severity, confidence, source, narrative.
`condition` — diagnosis, onset, status, resolution. *Anxiety disorder, Vitamin D deficiency, acne vulgaris.*
`medication` — the register. Substance, form, strength, prescriber, indication, start, stop, and — importantly — the *reason* for stopping.
`medication_schedule` — dose, frequency, timing, with its own validity interval so a dose change is a new schedule rather than an edit that erases the old dose.
`medication_event` — taken, skipped, delayed. Feeds adherence.
`side_effect` — reported effect, suspected medication, severity, onset. Linked but never asserted as causal by the system.
`lab_panel` / `lab_result` — panel with collection date and lab identity; per-analyte results with value, unit, reference range as printed on the report, and flag. **Reference ranges are stored per result, not looked up** — ranges vary by laboratory and change over time, and a 2027 result compared against a 2035 range is a clinical error.
`appointment` — provider, specialty, date, pre-visit questions, post-visit notes, outcomes.
`procedure` — what was done. *Root canal on tooth 36, 2024-03.*
`treatment_course` — a bounded therapeutic intervention with start, end, dosing, and outcome. *Isotretinoin, dates, cumulative dose, response.* This is the entity that makes "what have I already tried, and did it work?" answerable a decade later, which is precisely the question no clinic will be able to answer for you.

#### Body
`exercise` (library) · `workout_session` · `workout_set` · `program` / `program_block` — training structure.
`body_measurement` — circumferences, distinct from bodyweight which is a plain observation.
`skin_state` / `skin_region_state` — daily state per region.
`skincare_product` / `product_event` — the register, with introduction and discontinuation dates. Product events are what make "my chest acne worsened three weeks after starting that moisturiser" a computable question.
`routine` / `routine_step` / `routine_log` — a generic routine engine reused by skincare, dental hygiene, and supplements. One implementation, three consumers — the alternative is three near-identical adherence systems.

#### Nutrition — V2
`food` / `food_nutrient` · `meal` / `meal_item` · `meal_template` · `nutrition_target`.
Foods are versioned: a nutrition-label change creates a new version, and historical meals keep pointing at the version that was true when eaten.

#### Mind
`anxiety_episode` — intensity, duration, trigger, coping response, outcome.
`journal_entry` — content, prompt reference, mood at time of writing. **Highest sensitivity classification in the system.**
`practice_session` — meditation, breathwork, grounding.
`therapy_session` — date, themes, action items, follow-up. Content is user-authored only; nothing here is ever model-generated.

Mood, energy, and anxiety *levels* are plain observations. Only things with internal structure become entities.

#### Cross-cutting
`goal` / `goal_target` / `goal_progress_snapshot` — definition, measurable target, and periodic snapshots. Snapshots exist so the *trajectory as it was believed at the time* is preserved even after the underlying data is corrected.
`insight` / `insight_evidence` — a surfaced finding with its supporting observation references, method, confidence, and disposition.
`review` — weekly, monthly, annual. Draft, edited content, and edit state.
`document` / `document_extraction` — the vault plus extracted text and structured extractions with confidence.
`media_object` — §9.8.
`note` — free-form, attachable to any entity.

#### AI (§10)
`embedding` — vector, source reference, model identity and version, chunk metadata.
`graph_node` / `graph_edge` — the knowledge graph.
`memory_fact` — durable derived facts about the user.
`ai_interaction` — every model call: purpose, model, token counts, cost, latency, consent scope, and an output hash. **Complete auditability of everything the AI layer has ever done** is a requirement, not a nicety.

#### Operations
`audit_log` (§9.4) · `app_event` (§5.11) · `sync_state` · `idempotency_record` · `job_run` · `schema_migration`.

### 9.3 Relationships — the shape of the graph

```
                          ┌──────────┐
                          │ profile  │  (exactly one, forever)
                          └────┬─────┘
                               │
     ┌─────────────────────────┼─────────────────────────┐
     │                         │                         │
┌────▼─────┐            ┌──────▼──────┐          ┌───────▼──────┐
│  metric  │◄───────────│ observation │─────────►│    source    │
│ registry │  every obs │  APPEND     │  every   │  provenance  │
└──────────┘  declares  │  ONLY       │  obs has └──────────────┘
              a metric  └──────┬──────┘  a source
                               │
                subject_ref (polymorphic, optional)
                               │
     ┌──────────┬──────────────┼──────────────┬──────────┐
     ▼          ▼              ▼              ▼          ▼
 workout_    skin_        medication      meal      journal_
  session   region_st.       event                    entry
     │          │              │              │          │
     └──────────┴──────┬───────┴──────────────┴──────────┘
                       │  clinically significant events
                       ▼
              ┌─────────────────┐
              │  medical_event  │  BITEMPORAL
              │  (supertype)    │
              └────────┬────────┘
                       │
       ┌───────────┬───┴────┬────────────┬──────────┐
       ▼           ▼        ▼            ▼          ▼
   condition  medication  lab_panel  procedure  treatment_
                                                  course
                       │
                       ▼
              ┌─────────────────┐
              │ medical timeline│  ── the clinical read model
              └─────────────────┘

  CROSS-CUTTING (read from everything, own almost nothing)
       goal ──────► projection over observations
       insight ───► references observations as evidence
       document ──► evidences observations
       graph ─────► nodes reference entities; edges reference observations
```

Four load-bearing properties:

1. **Every observation names a registered metric.** No free-floating numbers.
2. **Every observation names its source.** No unattributable facts.
3. **The subject reference is polymorphic and optional.** A bodyweight has no subject; a set belongs to a session. Enforced by application-level validation per metric rather than by database polymorphism, which Postgres handles badly.
4. **Cross-cutting entities read widely and write narrowly.** Goals own definitions, not progress. Insights own findings, not data. This is what stops derived state from becoming a second, drifting source of truth.

### 9.4 Audit, soft deletion, and versioning

**`audit_log` is append-only and permanent.** Every mutation to every entity writes: entity type and ID, operation, actor, timestamp, the before state, the after state, and the change reason where one was supplied. Never pruned. It is the answer to "when did this change, and to what?" at any point in the next twenty years, and it is the recovery mechanism of last resort.

**Nothing is hard-deleted.** Deletion sets a deleted-at timestamp and a reason. Three motivations: undo becomes trivial; deletes replicate correctly through the offline outbox as ordinary state transitions; and referential integrity across a twenty-year record is preserved even when something is removed from view. Hard deletion exists only as an explicit, audited purge operation for genuine data-removal requirements.

**Entity versioning is row-level.** Mutable entities carry a monotonic version, incremented on write and used for optimistic concurrency. The full prior state lives in `audit_log`, which avoids maintaining shadow history tables for every entity — the audit log already contains the information, and one mechanism is better than two.

**Schema versioning** is the migration directory (§6.2) plus a `schema_migration` table. Migration rules: forward-only; never edited once applied; every migration forward-compatible with the previous application version (§5.15); data migrations separate from structural migrations, and idempotent.

### 9.5 Bitemporality — and where it stops

Two independent time axes:

- **Valid time** — when the fact was true in the world.
- **Transaction time** — when the system was told.

They diverge constantly in medicine. A lab drawn on 12 March, reported on 19 March, entered on 24 March is three different dates, all of them true, all of them sometimes the one that matters. A condition diagnosed in October with an onset the clinician backdates to March means the March onset is now recorded, but the system *did not know it in April* — and a timeline that pretends otherwise is falsifying the record.

**Bitemporality applies to `medical_event` and its subtypes only.** This is a deliberate boundary. Full bitemporality everywhere would double the conceptual complexity of every query in the system for benefit that exists almost exclusively in the clinical domain. A bodyweight observation needs `observed_at` and `recorded_at` — two timestamps, not two intervals — and that is sufficient.

The capability this buys: reconstructing the medical record *as it was understood on any past date*. When a clinician asks "what did you know when you made that decision?", the system can answer truthfully.

### 9.6 Indexing strategy

Indexes are designed for the actual query shapes, which at n=1 are well known in advance:

| Access pattern | Index |
|---|---|
| Recent observations for a metric | Composite on (metric key, `observed_at` descending) — the workhorse |
| Everything on a given day | `observed_at` descending, with a date-truncated expression index for the timeline |
| Observations for a subject | Composite on (subject type, subject ID, `observed_at`) |
| Active entities | Partial indexes with `deleted_at IS NULL` — excludes tombstones from every hot path |
| Current medications | Partial on active-schedule rows |
| Overlapping validity intervals | GiST with `btree_gist` — also enforces exclusion constraints preventing two active schedules for the same medication |
| Fuzzy food/exercise lookup | Trigram on name, for typo tolerance |
| Full-text over journal and documents | Generated `tsvector` column with GIN |
| Semantic search | HNSW on the embedding column |
| Audit reconstruction | Composite on (entity type, entity ID, timestamp) |

Two guardrails: **no index is added without a measured query**, and index bloat is reviewed annually. At n=1 the temptation is to over-index because storage is free; the actual cost is write amplification on the outbox drain, which is exactly the path where latency is user-visible.

### 9.7 Time series — and the volume split

The volume arithmetic matters, because it determines whether this needs special handling at all.

Human-generated observations: roughly 50 per day at heavy use. Over twenty years, **under 400,000 rows.** This is a rounding error for Postgres. It needs no partitioning, no time-series extension, no special treatment whatsoever. Plain tables with good indexes will serve five-year trend queries in milliseconds.

Device-generated samples are a different problem entirely: continuous heart rate at one-minute resolution is over half a million rows per year on its own, and a wearable emitting several such streams reaches tens of millions over twenty years.

**They therefore live in different tables.** `observation` stays human-scale, queryable, indexed for correlation work, and never partitioned. `sample` is device-scale, monthly-partitioned, and subject to a retention policy: full resolution for 90 days, then downsampled to hourly aggregates and the raw rows dropped.

This split is worth the extra table. Mixing them would force partitioning and retention complexity onto the human record — the part that must remain simple, complete, and forever — in order to accommodate device data whose value beyond 90 days is entirely in its aggregates anyway.

**Materialised rollups** (§5.6) cover daily and weekly aggregates per metric, refreshed nightly, so long-range charts read a small table rather than aggregating the full history.

### 9.8 Photo and media storage

`media_object` carries: storage key, media type, byte size, dimensions, perceptual hash, `captured_at` with zone, device identity, and the wrapped encryption key (§5.5).

For protocol-governed photography (skin, physique) it additionally carries the **capture protocol block**: region, pose identifier, distance category, lighting condition, flash state, time-of-day bucket, alignment-reference to the prior photo in the series, and a computed protocol-compliance score.

The compliance score is what makes a photo series analytically usable rather than merely nostalgic. Comparison views default to compliant photos only, with non-compliant ones available behind a toggle and clearly marked. A series where lighting varies more than skin does is a series that will produce confident, wrong conclusions.

Media rows are never orphaned: a nightly integrity check asserts that every storage object has a row and every row has an object, because a photo series with silent gaps is worse than one with none.

### 9.9 Documents

`document` — file reference, type, issuer, issue date, expiry, and linkage to the entities it evidences.
`document_extraction` — extracted text, structured extractions with per-field confidence, extraction method, and model version where applicable.

The design goal stated in §4.11 is realised here: a lab PDF becomes lab-result observations whose source is a document extraction pointing at the document, with the extraction confidence retained. **Every derived number can be traced back to the page it came from.** A number in a medical record without provenance is an assertion; with provenance it is evidence.

### 9.10 Export — the P2 obligation

Export is a first-class feature with a schema of its own, shipped in the MVP (§2.1).

A complete export produces: every table as newline-delimited JSON with a documented schema; all media, decrypted, with a manifest; a human-readable Markdown rendering of the medical timeline; a `schema.json` describing every table, column, and metric with its semantics; and a `README` explaining the format to a person who has never seen this system.

Two properties make it a real exit rather than a gesture:

1. **The export is self-describing.** Someone in 2046 with the archive and no application can understand it. The metric registry travels with the data, so every number carries its meaning.
2. **The export includes a decryption utility.** Encrypted media that can only be read by an application that no longer runs is not exported data. A standalone script plus the passphrase must be sufficient.

Export runs monthly, automatically, to independent storage, and is verified. A quarterly drill re-imports an export into a scratch database and asserts row-count and checksum equality — the same discipline as the backup restore drill, for the same reason.

---

## 10. AI Architecture

### 10.0 The governing constraint

> **The model never computes, discovers, or asserts. It retrieves, explains, ranks, and drafts.**

Every number the user sees came from a SQL query. Every correlation came from a statistical test in `packages/core/statistics`. Every trend came from a deterministic fit. The language model's job is to make those findings *legible*, to prioritise them, and to hold a conversation about them.

This is P4, and it is enforced structurally rather than by instruction. Engines emit structured objects containing references to observation IDs and computed values; the model receives those objects and produces prose. A prompt saying "don't make up numbers" is a hope. An architecture where the model is never given the opportunity is a guarantee.

The cost of getting this wrong in a health context is not an embarrassing output. It is a person changing their medication behaviour because a language model produced a fluent, plausible, invented correlation.

### 10.1 Memory

Four tiers, distinguished by lifetime and how they are constructed.

| Tier | Contents | Lifetime | Built by |
|---|---|---|---|
| **Working** | The current Ask thread; the context pack assembled for this request | One request or session | Context Engine, per call |
| **Episodic** | The observation log itself — what actually happened | Forever | The user, by living |
| **Semantic** | Derived stable facts: baselines, typical ranges, established patterns, preferences | Until invalidated | Nightly derivation |
| **Procedural** | Protocols the user follows: routines, programs, capture protocols, personal rules | Until edited | The user, explicitly |

Semantic memory is the tier that makes the system feel like it knows you. Facts such as *"resting baseline mood is 3.4"*, *"trains four days a week, push/pull/legs/upper"*, *"vegetarian plus eggs"*, *"skin flares typically lag a trigger by 48–72 hours"* are **derived deterministically, stored as rows with supporting evidence and a confidence, and expire when their evidence window closes.** They are never model-generated free text, because a semantic memory that drifted from the data would silently poison every downstream inference — and would be undetectable.

Anthropic's memory tool is deliberately **not** used for this. Model-managed memory files are appropriate for agents operating over unstructured workspaces; here the memory *is* a database, and it should be queried as one.

### 10.2 Knowledge graph

Nodes are entities: conditions, medications, foods, exercises, products, symptoms, activities, places, people. Edges are typed, directional, evidenced, and weighted — and critically, every edge stores the observations that support it and the statistical method that produced it.

Edge types:

```
PRECEDES         (temporal, with a lag distribution)
CORRELATES_WITH  (statistical, with r, n, p, and the window)
PRESCRIBED_FOR   (clinical, from the record)
CONTAINS         (compositional — food → nutrient)
PART_OF          (structural — exercise → muscle group)
TRIGGERS         (user-asserted, marked as belief, never inferred)
TREATS           (clinical)
CO_OCCURS_WITH   (statistical)
```

The distinction between `TRIGGERS` and `CORRELATES_WITH` is doing real work. `TRIGGERS` is the user's belief, recorded as a belief; `CORRELATES_WITH` is a computed association. Conflating them would let a hunch harden into a fact through repetition — which is exactly how people acquire wrong ideas about their own bodies.

**No edge is ever labelled causal.** The graph contains temporal precedence, statistical association, and clinical relationships from the medical record. Causation is a claim only a clinician makes.

Graph construction runs nightly, incrementally, from the observation log. Edges are recomputed as evidence accumulates and are removed when they no longer meet threshold — which means the graph gets *quieter* as data accumulates and spurious early associations wash out, which is the correct behaviour.

### 10.3 Embeddings

**Anthropic provides no first-party embeddings endpoint.** The vector layer is therefore an independent decision, and the right answer here is determined by P7 rather than by convenience.

**Decision: embeddings are generated locally and never leave the machine.**

The content requiring embedding is journal entries, therapy notes, symptom descriptions, and medical documents — categorically the most sensitive text in the system. Sending it to a third-party embedding API purely to build a search index would mean the most private data in the database has the widest egress footprint. That is unacceptable, and it is avoidable.

| Aspect | Choice |
|---|---|
| Model | A small quantised sentence-transformer (BGE-small class), 384 dimensions, ONNX runtime |
| Where | The nightly job process — see the runtime note below |
| Storage | `pgvector`, HNSW index |
| Chunking | Semantic, ~512 tokens with overlap; journal entries chunked by paragraph with entry-level context retained |
| Versioning | Every vector records its model and version; a model change triggers a full backfill rather than mixing vector spaces |

**Runtime note, stated plainly because it is a real constraint:** local ONNX inference does not fit a serverless function — the model weights and memory ceiling make it impractical on Vercel. The nightly job therefore requires a persistent runtime. The pragmatic options are a small always-on machine (a Fly.io micro-VM is sufficient) or a scheduled job on the operator's own hardware. This is called out because discovering it during implementation would be an unpleasant surprise, and because it is the one piece of infrastructure in this design that C3 does not get for free.

**Hybrid retrieval** is the default: `pg_trgm` and full-text for lexical matching, `pgvector` for semantic, results fused by reciprocal rank. Pure vector search is poor at exact terms — drug names, lab analytes, product names — which are precisely the terms that matter most here.

### 10.4 Context Engine

The Context Engine is the highest-value engineering in the AI layer. Retrieval quality determines answer quality far more than model choice does.

It assembles a **budgeted context pack** for every model call. Never a dump of everything; always a deliberate selection with an explicit token budget.

```
1. CLASSIFY      What kind of question is this?
                 (temporal · causal · status · comparative · clinical · reflective)

2. RESOLVE       Which entities, metrics, and time windows are implicated?
                 Deterministic extraction plus graph traversal.

3. RETRIEVE      Structured  → SQL over observations and entities
                 Semantic    → vector search over journal/documents
                 Graph       → neighbours of resolved entities, depth ≤ 2
                 Temporal    → medical events in the window

4. RANK          Recency · relevance · statistical strength · user-marked importance

5. BUDGET        Fit to the token budget. Prefer structured summaries
                 over raw rows. Never silently truncate — state what was omitted.

6. ASSEMBLE      ┌ STABLE PREFIX (cacheable) ────────────────┐
                 │ profile · clinical context · active meds  │
                 │ semantic memory · protocols · metric reg. │
                 ├ VOLATILE ─────────────────────────────────┤
                 │ retrieved observations · findings · query │
                 └───────────────────────────────────────────┘
```

The stable/volatile split is a first-class design concern, not an optimisation afterthought. The prefix is byte-identical across calls so it caches; anything time-varying — timestamps, the question itself, retrieved rows — sits strictly after the cache boundary. A `new Date()` interpolated into the profile block would silently destroy cache hits across every request in the system, which is the classic way this goes wrong.

**Structured summaries beat raw rows.** Ninety days of mood observations should reach the model as *"mean 3.4, sd 0.8, trend −0.02/day, 6 days missing, 3 values below 2 clustered in week 7"* — not as ninety rows. It is more informative, an order of magnitude cheaper, and it prevents the model from doing arithmetic, which is exactly what §10.0 forbids.

### 10.5 Recommendation Engine

Deliberately conservative. Recommendations are rule-based, drawn from the user's own established protocols and their own historical data — not from population norms and not from model judgement.

Categories: **protocol adherence** (a routine step consistently missed) · **data gaps** (a metric that has stopped being recorded) · **timing** (an appointment cadence overdue, a lab worth repeating given a known deficiency) · **experiment suggestions** (a variable held constant long enough that varying it would be informative).

Every recommendation carries: the rule that produced it, the observations that triggered it, an expected effect where one is known from the user's own history, and a dismissal path that suppresses that rule permanently.

**No recommendation touches medication, dosage, or clinical decisions** (P5, §10.10). The nearest permissible output is *"your Vitamin D was last measured 11 months ago and was below range — worth raising at your next appointment,"* which is a scheduling observation, not clinical advice.

### 10.6 Insights Engine — and the multiple-comparisons problem

**Two stages, strictly separated.**

**Stage 1 — deterministic detection.** Pure functions in `packages/core/detectors`, no model involvement, fully unit-tested against synthetic data with known properties:

| Detector | Detects |
|---|---|
| Changepoint | A statistically significant shift in a metric's level or variance |
| Correlation | Association between two metrics over a window, with lag search |
| Adherence | Deviation from an established routine or medication schedule |
| Streak | Sustained continuation or a break in one |
| Threshold | A metric crossing a user-defined or reference bound |
| Cycle | Weekly or monthly periodicity |
| Anomaly | A value outside the personal historical distribution |
| Stagnation | A goal metric flat for longer than its expected progression |
| Divergence | Two metrics that historically moved together separating |

**Stage 2 — narration and ranking.** The model receives detector output as structured objects and produces plain-language explanation and priority ordering. It cannot introduce a finding, because it is not given the data to find one in.

**The statistical honesty problem — and this is the most important paragraph in §10.**

Running nine detector families across dozens of metric pairs, nightly, over a single subject, will generate spurious findings continuously. With enough metrics, *something* always correlates. A naive implementation of the above would produce a confident, plausible, wrong insight most days — and because each one would be individually well-evidenced, the user would have no way to tell. This would not be a minor quality issue; it would make the entire insight surface untrustworthy, and an untrustworthy insight surface in a health application is worse than none.

Five controls, all mandatory:

1. **Minimum-N gates per detector**, set from the statistical power actually required. Correlation requires at least 30 paired observations and a lag window supported by the data. Below the gate, the detector reports *insufficient data* — which is itself displayed, because "not enough data yet" is honest and builds trust.
2. **False-discovery-rate control.** Benjamini–Hochberg across the full nightly detector battery, not per-detector. The comparison count is known — it is the size of the battery — so this is straightforward and there is no excuse for omitting it.
3. **Hypothesis pre-registration.** Metric pairs eligible for correlation testing are declared in advance, in a registry, based on plausible mechanism — sleep against mood, training volume against skin state, nutrition against energy. Exploratory all-pairs testing runs at a much stricter threshold and its output is labelled *exploratory* wherever it appears.
4. **Out-of-sample confirmation.** A correlation is not surfaced on first detection. It is held, and re-tested against subsequent data. Only a finding that survives a second independent window is promoted to the inbox. This single rule eliminates the large majority of spurious findings at the cost of some latency — a trade that is obviously correct for a system with a twenty-year horizon.
5. **No insights before day 60.** The system explicitly states it is still gathering baseline. An early wrong insight costs more trust than sixty days of silence.

Every insight displays its n, its effect size, its confidence, and — as a required field in the output schema — **an explicit statement of what it does not prove.** An insight the user cannot audit is an insight they should not act on.

### 10.7 Medical timeline

A read model over bitemporal medical events (§9.5), rendered clinically rather than chronologically-flat: conditions as intervals, medications as bars with dose changes marked, labs as points with reference ranges, procedures as events, treatment courses as spans with outcomes.

**The Consultation Pack is the payoff.** For a given specialty and date range it produces a printable, paginated document: relevant history, current medications with adherence, pertinent recent labs with trends, symptom timeline, treatments already attempted with outcomes, and a page of questions.

The questions are model-drafted from detector output and the user's own record, then user-edited. They are framed as questions, always — *"my Vitamin D was 18 ng/mL in March and I've been supplementing since; should we retest?"* This is P5 as a deliverable rather than a disclaimer: the system's clinical output is a better conversation with a qualified human.

### 10.8 Life timeline

The zoomed-out counterpart, scaling from day to decade. Composed of eras (life phases), chapters (jobs, relocations, relationships), events (discrete, significant), and metric bands (continuous variables rendered as a background against which events sit).

Its value is entirely in the long run. At year one it is a novelty; at year ten it is the only place a person can see their own life as a shape — which is a genuinely rare artifact and arguably the most durable thing this system will produce.

### 10.9 Prediction Engine

**Deliberately humble.** Classical, interpretable methods only: linear and loess trend extrapolation with prediction intervals, seasonal decomposition where a cycle is established, and simple state models for adherence probability.

**No machine learning.** n=1 with a few hundred observations per metric is not a machine-learning problem; it is a statistics problem, and treating it as the former produces an unexplainable, unvalidatable, unmaintainable model that will be abandoned (C3).

Predictions must state their interval and their assumptions, must degrade to *"insufficient data"* rather than guessing, and must be retrospectively scored — every prediction is stored and compared against what actually happened, with the calibration record visible to the user. **A prediction engine that does not report its own track record is asking for trust it has not earned.**

Permitted: goal trajectory, bodyweight projection under current intake, next-session load progression, adherence-risk flagging. **Prohibited: any prediction about a clinical outcome, a symptom course, or a medication response.**

### 10.10 The safety layer

`packages/ai/guardrails` sits between every engine and every surface. It is a hard boundary, not a prompt.

**Structural controls:**

- **Every AI output conforms to a schema** enforced via structured outputs. Free-form model text never reaches the user unvalidated.
- **Insight and recommendation schemas contain no field capable of expressing a diagnosis, a dosage, or a treatment change.** The representation makes the harmful output unrepresentable, which is stronger than any instruction.
- **Numeric fields are references, not values.** The model emits an observation ID; the application renders the number from the database. The model is never the source of a figure the user reads.
- **Post-generation validation** scans for prohibited patterns — diagnostic language, dosage instructions, discontinuation advice, urgency framing — and blocks rather than sanitises. A blocked output is logged as a defect and drives a prompt eval case.

**Consent scopes**, per data class, individually revocable in `/settings/ai`, all defaulting to off:

| Scope | Covers | Default |
|---|---|---|
| `metrics` | Numeric observations, aggregates | Off |
| `clinical` | Conditions, medications, labs | Off |
| `journal` | Journal and therapy content | Off — **the strictest** |
| `media` | Any image content | Off, and per-invocation confirmed |

A scope that is off means the Context Engine cannot retrieve that class at all — enforced at retrieval, not at prompt assembly, so there is no path by which a prompt-construction bug leaks it.

**Crisis handling.** Detected crisis indicators route to exactly one behaviour: display the user's own stored crisis plan (§9.2). No model call. No generated message. No suggestion. The system's entire contribution in that moment is to show the person what they wrote for themselves when they were well — which is both safer and more useful than anything a model could produce.

### 10.11 Model selection and economics

Verified against the current model catalogue as of this document's date.

| Model | ID | Context | Input / Output per MTok |
|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | 1M | $5 / $25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3 / $15 (intro $2 / $10 through 2026-08-31) |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 / $5 |

**Routing by task, not by preference:**

| Task | Model | Effort | Why |
|---|---|---|---|
| Parse "3 eggs, 100g oats, scoop whey" → structured items | Haiku 4.5 | — | High volume, narrow, latency-sensitive, in the P1 capture path |
| Classify and tag a journal entry | Haiku 4.5 | — | Bounded classification |
| Extract structure from a lab PDF | Sonnet 5 | medium | Accuracy matters; runs in batch |
| Narrate a nightly insight | Sonnet 5 | medium | Quality prose over structured findings |
| Draft a weekly review | Sonnet 5 | high | Longer synthesis, still bounded |
| Ask — conversational enquiry | **Opus 5** | high | Multi-hop reasoning over the graph; the surface where quality is most visible |
| Consultation Pack synthesis | **Opus 5** | xhigh | Highest stakes output in the system |
| Monthly deep review | Opus 5 | xhigh | Runs twelve times a year; cost is irrelevant, quality is not |

**API specifics that this design depends on:**

- **Adaptive thinking** (`thinking: { type: "adaptive" }`) with `output_config.effort` as the depth control. Note that on Opus 5 thinking is on by default and `max_tokens` bounds thinking plus response together — a tight `max_tokens` carried over from a non-thinking model will truncate mid-answer.
- **Structured outputs** via `output_config.format` for every engine. This is the enforcement mechanism for §10.10, not a convenience.
- **Sampling parameters are unavailable** on Opus 5 and Sonnet 5 — behaviour is steered by prompt and effort. Any design assuming a temperature knob is invalid.
- **Refusal handling.** Opus 5 can return `stop_reason: "refusal"` on a 200 response. Health and body content sits adjacent to categories that occasionally trip safety classifiers, so `stop_reason` is checked before reading content on every call, and `fallbacks: "default"` is enabled so a declined request is re-served rather than surfacing as a failure to the user.
- **Batch API at 50%** for the entire nightly pipeline. Nothing overnight is latency-sensitive, so nothing overnight pays full price.

**Prompt caching, stated accurately.** Cache reads cost ~0.1× and writes 1.25× at the 5-minute TTL; the minimum cacheable prefix on Opus 5 is 512 tokens. The important nuance: **caching does essentially nothing for the nightly batch**, because those calls are hours apart and every one would be a cache write. It is valuable in exactly one place — an Ask session, where several turns share the same profile prefix within minutes. The architecture is built for it (§10.4) because Ask is where interactive cost concentrates, but the savings should not be claimed for the batch path.

**Budget.** A hard monthly cap in code, enforced before the call, with a soft warning at 70% and a fail-closed message beyond it (§5.16). Every call is recorded in `ai_interaction` with its token counts and cost, and the spend breakdown by task type is visible in settings. Realistic steady-state, given batch pricing and Haiku-tier routing of the high-volume paths, is single-digit dollars per month — but the cap exists because the failure mode of an unbounded loop is a bill, and a bill is a reason to turn the system off.

---

## 11. Developer Experience

Calibrated to C3: one maintainer, intermittent attention, no code-review partner. The discipline therefore has to be automated, because a process that depends on remembering will not survive a three-week gap.

### 11.1 Branch strategy

**Trunk-based with short-lived branches.** `main` is always deployable.

```
main ─────●────────●────────●────────●────────►
           \      /          \      /
            ●────●            ●────●
         feat/skin-photos   fix/outbox-drain
```

Branch naming: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, `spike/`. Branches live under three days — longer means the work was not decomposed. `spike/` branches are explicitly disposable and never merge.

No `develop` branch, no release branches, no GitFlow. Those exist to coordinate humans, and there is one human.

**`main` is protected even so.** CI must pass; force-push is disabled. The protection is not against a colleague — it is against a tired maintainer at midnight, which is a more likely adversary.

### 11.2 Commit convention

Conventional Commits, enforced by a commit-msg hook.

```
<type>(<scope>): <subject>

<body — why, not what>

<footer — refs, breaking changes>
```

Scopes are feature or package names. Types: `feat` `fix` `refactor` `perf` `docs` `test` `chore` `migration`.

Two project-specific rules:

- **`migration` is its own type**, because schema changes deserve to be findable in the log without reading diffs. In year eight, `git log --grep '^migration'` is the fastest route to the schema's history.
- **The body explains why.** In a solo project the commit log is the only record of reasoning that exists at the granularity of a change. *"fix(outbox): drain on visibilitychange — periodic sync unreliable on iOS"* is worth writing; *"fix bug"* is a note to nobody.

### 11.3 Code style

Prettier for formatting — zero configuration debate. ESLint for correctness with a small set of project-specific rules that carry real weight:

| Rule | Enforces |
|---|---|
| `boundaries/element-types` | The layering rule (§5.0). `core` cannot import React. Fails the build. |
| `no-restricted-imports` | Feature internals are unreachable from outside (§7.4 R1). |
| `no-restricted-syntax` | No raw `Date` arithmetic — the timezone-aware helpers in `core/temporal` are mandatory. |
| Custom: `no-bare-quantity` | A measured value must be a `Quantity`, never a bare number (§6.2). |
| Custom: `no-sensitive-log` | `Sensitive<T>` cannot be passed to a logger. |

Naming: `PascalCase` components and types, `camelCase` functions and variables, `SCREAMING_SNAKE` constants, `kebab-case` files except components. Booleans read as assertions (`isSynced`, `hasConsent`). Functions with side effects use imperative verbs; pure derivations use `get`/`derive`/`compute`.

The last two custom rules are worth the effort of writing. They encode the two invariants most likely to be violated by a tired future maintainer, and they are the kind of thing that a code review would catch if a code review existed.

### 11.4 Testing

A weighted pyramid, deliberately not uniform:

| Layer | Tool | Coverage target | Applies to |
|---|---|---|---|
| Unit — domain | Vitest | **95%** | `core` — statistics, detectors, units, temporal |
| Unit — feature | Vitest | 70% | Services and hooks |
| Component | Testing Library | Critical paths | Capture flows, forms |
| Integration | Vitest + real Postgres | Every API route | Handlers, repositories, migrations |
| E2E | Playwright | 6 journeys | The flows that must never break |
| Contract | Zod round-trip | 100% | Every API contract |
| Accessibility | axe-core | Every route | Automated, blocking |
| Prompt eval | Custom harness | Every prompt | Golden cases with property assertions |

`core` is held to 95% because it is the durable layer and its bugs are the expensive kind — a wrong unit conversion or a broken correlation function corrupts conclusions silently, for years, and the corruption is discovered long after the data has been acted on.

**The six E2E journeys:** complete a Daily Close · log a full workout offline and verify sync · capture a protocol-compliant skin photo · export and verify completeness · restore from backup · navigate the Daily Close by keyboard only.

**Property-based testing** for the statistics module specifically. Correlation, changepoint, and trend functions are tested against generated series with known properties — a detector that finds a changepoint in pure noise is a bug that example-based tests will not catch and that would otherwise reach production as a plausible-looking insight.

**Prompt evals run in CI.** Golden cases assert properties, not exact strings: no diagnostic language, every number traceable to a supplied observation, required citations present, output schema valid. A prompt change failing evals fails the build, exactly like a broken test — because a prompt change *is* a behaviour change.

### 11.5 CI/CD

```
push / PR
  ├─ install (cached)
  ├─ lint · typecheck · format ────────┐
  ├─ unit tests                        │ parallel
  ├─ integration (Postgres service)    │
  ├─ build                             │
  └─ ─────────────────────────────────-┘
        ├─ E2E (Playwright, on preview deploy)
        ├─ accessibility (axe, all routes)
        ├─ prompt evals
        ├─ bundle size budget
        └─ security: dependency audit · secret scan

merge to main
  ├─ migration dry-run against a production clone   ★ gate
  ├─ apply migrations
  ├─ deploy
  ├─ smoke test
  └─ tag
```

The migration dry-run against a restored production clone is the most important gate in the pipeline. It is the difference between discovering a destructive migration in CI and discovering it in the only copy of a five-year medical record.

Bundle-size budgets are enforced and fail the build. A PWA that must work on gym wifi has a performance budget that is a functional requirement, not an aspiration.

### 11.6 Documentation

| Artifact | Purpose | Cadence |
|---|---|---|
| `BLUEPRINT.md` | This document | Reviewed quarterly |
| ADRs | Why a decision was made | One per significant decision, immutable |
| Feature `README` | What a slice owns | Written with the feature, updated with it |
| Runbooks | How to perform an operation | Written the second time an operation is performed |
| Contract reference | Generated from Zod | Automatic |
| `CHANGELOG` | What shipped | Generated from commits |

**The runbook rule earns its place under C3.** Any operation performed twice manually gets a runbook or a script. The operator executing a restore in eighteen months will have forgotten everything, and the runbook is written for that person — with exact commands, expected output, and what to do when it goes wrong.

### 11.7 Review process

Solo development still gets review; it is just differently sourced.

1. **Self-review before merge, against a written checklist.** Not "does it work" — does it satisfy P1's latency budget, is the layering respected, is the migration reversible, does the failure mode lose data, is the accessibility path intact.
2. **Automated review as the second reviewer.** An AI code review on every PR, prompted specifically for this project's invariants: layering violations, unhandled failure modes, missing idempotency, potential data loss, accessibility regressions.
3. **A 24-hour cooling period for anything touching the substrate, migrations, encryption, or the AI safety layer.** Written, then reviewed the next day with fresh eyes. The categories are chosen because they are the ones where a mistake is expensive and not immediately visible.
4. **Quarterly architecture review** against this document. What drifted, and was the drift correct? Drift that turned out to be right becomes an ADR amending the blueprint; drift that was expedient gets scheduled for correction.

### 11.8 Release strategy

Semantic versioning, with meaning adapted to a single-user product: **major** = a schema change requiring migration or a breaking export-format change; **minor** = a new feature; **patch** = a fix.

Continuous deployment to production on merge — there is no staging audience to protect, and the preview environment plus the CI gates carry the risk.

**Feature flags for anything touching the substrate**, so a bad path can be disabled without a rollback. **Every release is tagged, and every tag is reproducible** from the repo plus a lockfile.

**A schema-change release is a distinct event**, never bundled with feature work. It gets its own PR, its own dry-run, its own deploy, and a verified backup taken immediately before. This is the one place the process is deliberately heavier than it needs to be, because it is the one place where a mistake is permanent.

---

## 12. Roadmap

Dates are anchored to this document, 2 August 2026. Week 1 begins Monday 3 August 2026.

The roadmap has a shape worth naming: **weeks 1–4 build almost no features.** They build the substrate, the ritual, and one domain. This will feel slow. It is the correct trade, because every domain added after the substrate is right is cheap, and every domain added before it is a migration waiting to happen.

### Week 1 — 3–9 August 2026 · Foundation

*Goal: an authenticated shell writing real observations to a real database.*

- Monorepo, Turborepo, pnpm workspace, all packages scaffolded with boundary lint rules active from commit one.
- Postgres in Docker; Supabase project provisioned; Drizzle configured.
- **The complete §9 schema** — all of it, including domains not shipping for a year. The schema is the expensive thing to change; the UI is not.
- Metric registry seeded with the MVP's metrics.
- Auth: passkey plus magic link, single-email allowlist.
- Design system tier 1 and 2 tokens; six primitives; both themes.
- App shell, routing skeleton, dark mode.
- CI: lint, typecheck, unit, integration against Postgres.

**Exit:** sign in, write an observation through the API, read it back. Deployed.

### Week 2 — 10–16 August 2026 · The ritual

*Goal: the habit exists before any analytics does.*

- **The Daily Close.** Complete, polished, sub-sixty-seconds. This is the week's actual deliverable and everything else is supporting.
- Quick-capture rail with keyboard shortcuts.
- Observation write path with optimistic UI.
- **Offline outbox** — IndexedDB queue, idempotency keys, drain on reconnect, visible unsynced state.
- PWA: manifest, service worker, installable, offline shell.
- Timeline, read-only.
- **Export v1** — ships now, not later. It is the P2 obligation and it is easiest to build while the schema is small.

**Exit:** the operator completes a Daily Close on a phone, in aeroplane mode, and it syncs. Daily use starts here — the North Star clock starts on 16 August.

### Week 3 — 17–23 August 2026 · Gym

*Goal: the first full domain, end to end.*

- Exercise library, seeded.
- Live session logger — rest timer, last-session prefill, RPE, one-handed operation.
- Session history, per-exercise progression, PR detection.
- Bodyweight with a seven-day trend line.
- Program definition and adherence.
- Volume analysis by muscle group.
- Chart architecture: `TrendChart` and `AdherenceGrid` in the design system, with the invariants of §8.9 implemented.

**Exit:** a real training session logged in the gym, on a phone, without friction. If the logger is annoying to use under fatigue, week 4 is spent fixing it rather than moving on.

### Week 4 — 24–30 August 2026 · Mind and Skin

*Goal: the two remaining MVP domains, and the first cross-domain view.*

- Mind: mood, energy, anxiety episodes, journal, medication adherence for the two active medications.
- Skin: daily state per region (face, chest, back), routine definition and adherence, product register.
- **Encrypted media pipeline** and the photo capture protocol — ghost overlay, EXIF capture, compliance flagging, client-side encryption. Built correctly now, because retrofitting encryption onto an existing photo library is genuinely painful.
- Adherence detection — the only insight family in the MVP, fully deterministic.
- Pillar overviews for `/body` and `/mind`.
- Accessibility audit and remediation across all shipped routes.

**Exit:** MVP feature-complete. Then thirty days of use with no new features — the validation window, ending 29 September 2026.

### V1 — 30 August to 29 September 2026 · Validation

**No new features.** Use it daily and fix what actually hurts.

Instrument: capture latency, Daily Close completion, drop-off points, sync failures. **Gate: Compounding Days ≥ 25 of 30 by 29 September.** If the gate is missed, October is spent on capture friction, not on V2. This gate is real, and the discipline to honour it is the difference between a system that lasts and a graveyard of half-built modules.

### V2 — October to December 2026 · Intelligence and clinical depth

- **October:** Health core — vitals, labs, conditions, the full medication register, appointments. Document vault with OCR. Vitamin D tracking as the first end-to-end clinical loop, from lab PDF to trend to consultation question.
- **November:** Nutrition, subject to the ten-second rule (§4.3). Teeth. Goals as projections.
- **December:** The AI layer, first light — local embeddings, knowledge graph, context engine, deterministic detector suite with the §10.6 statistical controls, narration only. The Ask surface. The Insight inbox. **The Consultation Pack**, which is V2's highest-value deliverable.

**Gate:** at least one insight the operator acted on, and at least one Consultation Pack taken to an actual appointment.

### V3 — 2027 · Compounding

- **Q1:** Work — career log, tasks, learning, calendar import. Sleep as a full module. Weekly reviews.
- **Q2:** Money. Appearance as an aggregate lens. Monthly and annual reviews.
- **Q3:** Wearable import (batch). Prediction engine with calibration tracking. Life Timeline.
- **Q4:** Consolidation. Performance over a year of real data. The first annual review. Full restore-and-export drill. Blueprint revision informed by a year of contact with reality.

### Beyond

**2028:** local inference for routine classification, removing the last routine egress of personal text. Signed medical attestations.
**2029+:** the five-year longitudinal report — the artifact this whole system exists to eventually produce. Publication of the export format as a versioned, application-independent specification, which is the final discharge of P2.

---

## 13. Risks

Ordered by expected cost, not by likelihood.

### 13.1 Product risk — the one that actually kills this

| Risk | L | I | Mitigation |
|---|---|---|---|
| **Abandonment after 3–6 weeks** | **High** | **Fatal** | The single most likely failure. Mitigations: the sub-60s Close; the ten-second fallback (§14.R1); the North Star measuring exactly this; the V1 gate that stops feature work if the habit does not form; the dormancy-and-return design (§14.R2). |
| Empty-module syndrome | High | High | V2/V3 routes do not exist in the MVP (§3.3). Three domains only. Empty states are designed, never blank. |
| Insight surface produces nothing useful | Medium | High | The §10.6 statistical controls; the 60-day silence; V2 gated on one acted-on insight. |
| Capture friction creeps upward | Medium | High | Time-in-app as an explicit counter-metric. Every new Close field requires removing one. |
| The operator's priorities change at 25 | High | Low | The substrate is domain-agnostic by design (P3). New domains are new lenses, not new systems. This is what the architecture bought. |

### 13.2 Technical risk

| Risk | L | I | Mitigation |
|---|---|---|---|
| **Data loss** | Low | **Fatal** | Append-only observations; soft delete; permanent audit log; automated backups; **quarterly tested restore**; monthly independent export. The restore drill is the control that matters — the others are hypotheses without it. |
| Silent data corruption | Medium | Severe | Nightly integrity assertions (§5.16); provenance on every fact; property-based tests on derivation. |
| Migration destroys data | Low | Fatal | Forward-compatibility requirement; dry-run against a production clone; verified backup immediately prior; migrations never bundled with features. |
| Offline sync loses a write | Medium | High | Durable outbox, never silently dropped; idempotency; visible unsynced state; outbox-age alerting. |
| Local embedding runtime doesn't fit serverless | **High** | Medium | Already surfaced (§10.3). Requires a persistent runtime — resolved by design, not discovered in implementation. |
| Framework obsolescence | Certain (20y) | Medium | §5.0. `core` is framework-free; the UI is expected to be rewritten two or three times. |
| Supabase vendor risk | Medium | Medium | Used as hosted Postgres. No client-direct access, no Edge Functions in the core path, no proprietary features load-bearing. Annual exit drill measures the actual migration cost. |
| Solo bus factor | Certain | High | Documentation written for a stranger; runbooks; ADRs; export means the data survives regardless of the code. |

### 13.3 UX risk

| Risk | L | I | Mitigation |
|---|---|---|---|
| The app becomes a source of anxiety | **Medium** | **Severe** | P6 throughout: no streaks, no red health data, no guilt notifications, hard notification rate limit, Mind-specific design constraints (§4.7). Given the documented anxiety disorder, this is a safety consideration, not a preference. |
| Sixteen domains overwhelm | High | High | Four surfaces, five pillars, progressive rollout, one screen one question. |
| Photo capture becomes a chore | Medium | Medium | Ghost overlay makes alignment fast; protocol warnings advisory, not blocking (§14.R3). |
| Insight fatigue | Medium | Medium | One insight per day maximum, on Today. Everything else queues silently. |

### 13.4 Performance risk

| Risk | L | I | Mitigation |
|---|---|---|---|
| Timeline slows as history grows | Medium | Medium | Virtualisation; materialised rollups; the volume split (§9.7) keeping human observations under ~400k rows. |
| Device sample tables grow unbounded | High (post-wearables) | Medium | Separate partitioned table; 90-day full resolution then downsample. |
| PWA cold start on poor connectivity | Medium | High | Bundle budgets in CI; precached shell; RSC minimising client JS; offline-first reads. |
| Vector search degrades | Low | Low | HNSW; the corpus is small by any normal standard. |

### 13.5 Scaling risk

Largely absent by construction — and it is worth stating that explicitly, because the instinct to design for scale is strong and here it would be pure waste. n=1 means no concurrency, no multi-tenancy, no horizontal scaling. Twenty years of human observations is a few hundred thousand rows. The real scaling axes are **complexity** (mitigated by scope discipline and the never-build list) and **maintainer attention** (mitigated by C3 governing every operational choice).

### 13.6 Privacy risk

| Risk | L | I | Mitigation |
|---|---|---|---|
| **Sensitive media exposed via provider breach** | Low | **Severe** | Client-side envelope encryption. The provider holds ciphertext. |
| Journal content reaching a model unintentionally | Medium | Severe | Consent scopes enforced at *retrieval*, not at prompt assembly. Off by default. |
| Leakage via logs or telemetry | Medium | High | `Sensitive<T>` makes it a type error. `app_event` schema cannot represent content. |
| Third-party dependency exfiltration | Low | Severe | Strict CSP, minimal dependency surface, no analytics SDKs, audited lockfile. |
| Passphrase loss → permanent media loss | **Medium** | High | Printed recovery code at setup, stored offline. An accepted, explicit trade for real encryption. |
| Device theft | Low | High | Passkeys, session expiry, passphrase-gated media decryption. |

### 13.7 Medical risk

The most consequential category, and the one with the least tolerance for imprecision.

| Risk | L | I | Mitigation |
|---|---|---|---|
| **A model-generated finding influences a medication decision** | Low | **Severe** | §10.10: output schemas cannot express a dosage or treatment change; numbers are references, not values; post-generation blocking; P5 throughout. |
| **A spurious correlation is believed** | **High without controls** | Severe | §10.6: FDR control, minimum-N gates, pre-registration, out-of-sample confirmation, 60-day silence, mandatory "what this does not prove". |
| Inaccurate record misleads a clinician | Low | Severe | Provenance mandatory; derived and inferred values visually distinct from measured; bitemporality preserves what was known when; corrections never overwrite. |
| Missed clinical deterioration | Low | Severe | The system is explicitly not a monitoring device and states so. Threshold alerts on user-configured bounds only, always framed as "discuss with your doctor". |
| Unit error in a dosage or lab value | Low | Severe | `Quantity` types, total conversions, `numeric` not float, custom lint rule against bare quantities. |
| Crisis state mishandled | Low | Severe | No model involvement. The user's own stored plan, displayed. |

### 13.8 Future migration risk

| Risk | Mitigation |
|---|---|
| Framework rewrite | §5.0 layering. The rewrite is a UI rewrite. |
| Provider migration | `pg_dump` + storage sync + compose file. Annual drill measures the real number. |
| Schema evolution over 20 years | Additive changes preferred; append-only observations; metric registry versioned; bitemporality where meaning changes over time. |
| Export format obsolescence | Self-describing NDJSON + schema + README. Published as a spec by year five. |
| Encryption scheme obsolescence | Algorithm identifier stored per object; a re-encryption path exists from day one; key rotation runbook. |
| **The successor problem** — nobody can read this in 2046 | The final and least tractable risk. Answer: the export is plain text, the schema is self-describing, the semantics travel with the data. The application is expected to die; the archive is not. |

---

## 14. Critical Review

Three rounds. Each identified real weaknesses; each round's fixes have been **folded back into sections 1–13 rather than left as commentary**, and the section references below point to where. What remains at the end of §14.4 is residual risk that has been accepted deliberately rather than solved.

### 14.1 Round one — the plan is too big and too optimistic

**Finding 1 — the four-week MVP is not deliverable.** Substrate, Daily Close, PWA, offline outbox, three domains, encrypted media, capture protocol, and export, by one engineer with a demanding backend job, in four calendar weeks. Counting honestly, week 4 alone contains an encrypted media pipeline and a computer-vision-adjacent capture protocol. This was optimism, not a plan.

*Fixed:* the roadmap now front-loads ruthlessly — week 2's only real deliverable is the Daily Close, and the substrate schema is built once in week 1 for all sixteen domains precisely so no later week pays for it. Week 4 remains the heaviest, and §14.4 records the fallback: if week 4 slips, skin *photography* defers to v0.2 while skin *state* ships. Deferring photos is acceptable; deferring encryption is not, which is why encryption is built in week 4 with the photos rather than retrofitted.

**Finding 2 — nothing in the design accounts for the ritual failing.** The blueprint asserted a sixty-second Close and then assumed compliance. Every personal tracking system dies somewhere between day 18 and day 30, and a plan whose North Star is daily completion must design for the day the user does not want to.

*Fixed:* two additions. **The ten-second fallback** — a single tap recording "today was fine / today was rough," which counts as a partial Close. A degraded record on a bad day is infinitely more valuable than a gap, and bad days are the most clinically interesting days in the dataset. **The dormancy-and-return design** — after a gap of three or more days the system offers optional backfill and says nothing about the gap. No guilt copy, no "you missed 4 days," no recovery streak. The trailing-90 North Star (§1.5) already encodes this; the interaction design now matches it.

**Finding 3 — the AI layer as originally specified would have produced confident nonsense.** Nine detector families, dozens of metric pairs, run nightly against n=1. This generates spurious findings continuously and every one would look individually well-evidenced. This was the most serious defect found in any round: it would not have failed loudly, it would have quietly made the insight surface untrustworthy, which is worse.

*Fixed:* §10.6 now carries five mandatory statistical controls — Benjamini–Hochberg FDR across the whole nightly battery, minimum-N gates per detector, pre-registered hypothesis pairs with exploratory findings labelled as such, out-of-sample confirmation before any promotion to the inbox, and no insights at all before day 60. Every insight must state what it does not prove. This is the single most valuable change made to the document.

**Finding 4 — bitemporality was specified too broadly.** Applying two time axes to every entity would have doubled the conceptual load of every query for benefit concentrated almost entirely in clinical data.

*Fixed:* §9.5 now scopes bitemporality explicitly to `medical_event` and its subtypes. Everything else uses `observed_at` plus `recorded_at`, which is sufficient.

**Finding 5 — the counter-metric contradicted the product.** "Median daily time in app ≤ 6 minutes, falling" is right for capture and wrong for journaling, reviews, and Ask, all of which are deliberate reflective sessions that *should* take time.

*Fixed:* §1.4 measures capture-and-check time; deliberate reflective sessions are excluded from the counter-metric. Time spent thinking is not friction.

### 14.2 Round two — the technical claims do not all survive scrutiny

**Finding 6 — local embeddings were hand-waved.** "Generate embeddings locally in the nightly job" is correct on privacy grounds and quietly assumes infrastructure that does not exist. ONNX runtime with model weights does not fit a Vercel serverless function; the memory ceiling and cold-start cost make it impractical. The design as written had a hole where a runtime should be.

*Fixed:* §10.3 now states the constraint plainly and names the resolution — a persistent runtime is required, either a micro-VM or scheduled execution on the operator's own hardware. §13.2 carries it as a known risk with a High likelihood of being hit during implementation. It is better to have this argument now than in week eleven.

**Finding 7 — the prompt-caching economics were overstated.** The document implied caching would reduce nightly batch cost. It will not: those calls are hours apart, so every one is a cache write at 1.25×, not a read at 0.1×.

*Fixed:* §10.11 now states this accurately. Caching matters for Ask sessions, where several turns share a prefix within minutes, and nowhere else. Batch cost is controlled by the Batch API's 50% discount and by routing high-volume work to Haiku, which is a real saving rather than a claimed one.

**Finding 8 — "features never import each other" is violated by the pillar overviews.** `/body` renders summaries from Gym, Skin, Nutrition, and Health. Either it imports four features, breaking R2, or those summaries live somewhere ill-defined.

*Fixed:* §7.5 resolves it — pillar overviews are thin compositions in `apps/web/components` that render summary components each feature *exports through its public API*. The rule holds because the import goes through `index.ts` and the composition is app-level, which is exactly the case §6.3's promotion rule was written for. The tension is real and is now documented rather than hidden.

**Finding 9 — the photo protocol is partly unenforceable.** A luminance-based lighting check will produce false warnings, and a warning that is wrong even twenty percent of the time is a warning that gets ignored within a fortnight, taking the credible warnings with it.

*Fixed:* §4.2 and §9.8 now make protocol checks **advisory and recorded, never blocking**. The ghost overlay is the primary mechanism, because it actually works — it makes the correct behaviour easier than the incorrect one, which is the only reliable form of enforcement. Compliance is scored and stored, comparison views filter on it, and the user is never prevented from taking a photo.

**Finding 10 — export claimed portability that encryption removes.** An export containing encrypted media that only this application can decrypt is not an exit.

*Fixed:* §9.10 requires the export to bundle a standalone decryption utility. Passphrase plus script must be sufficient, with no dependency on the application.

### 14.3 Round three — questioning the premises

**Finding 11 — is the sixteen-domain scope right at all, or is it a 21-year-old's snapshot?** The domain list is indexed to the operator's life right now. At 27 there may be a partner, a child, a mortgage, a chronic condition, a different career. A system that modelled *these sixteen things* would age badly.

*Assessed and accepted.* The architecture already answers this and the answer is P3. Because domains are lenses over a shared substrate rather than independent systems, a new domain is a set of metric-registry entries, a feature slice, and a route. The schema does not change. This is the concrete return on the substrate investment, and it justifies the four weeks spent on foundations before any feature. §13.1 records it as high-likelihood, low-impact — which is a comfortable place to be, and is only comfortable because of a decision made in week 1.

**Finding 12 — is "one app for everything" actually better than best-of-breed tools?** Honest answer: **for most domains, no.** A dedicated finance app will beat the Money pillar. A dedicated task manager will beat Tasks. The integration thesis only pays where cross-domain correlation is genuinely valuable.

*Fixed, by scope discipline.* This is why Money is last (§2.3), why Tasks is deliberately minimal (§4.8), and why the MVP is the three domains with the strongest cross-domain linkage and the weakest third-party alternatives. The honest framing: NaitikOS should own the domains where *integration* is the value, and it should not compete on features in domains where it cannot win. §2.5 should be read with this in mind — the never-build list is partly a list of fights not worth having.

**Finding 13 — the Ask surface may be a solution looking for a problem.** How often does a person genuinely ask their life database a question? Possibly monthly. It is expensive to build and prominent in the IA.

*Assessed.* Ask stays, deferred to V2, deliberately not the primary interface (§2.5). But its success metric should be honest: if Ask is used fewer than twice a month by mid-2027, it should be demoted from a top-level surface to an entry point on the Insight inbox. Recorded here as a decision to revisit rather than as settled.

**Finding 14 — the design system is over-specified for one user.** Three token tiers, a density setting, two themes, chart invariants — this is a design system for a product team.

*Assessed and defended.* Two reasons it survives. Twenty years means at least two visual redesigns, and a token architecture is what makes those affordable. And the accessibility and chart invariants are not polish — a misleading chart in a health application produces a wrong decision about a body, and a 44px touch target is a functional requirement for logging a set with sweaty hands. §8.9's chart invariants in particular earn their specification.

**Finding 15 — quarterly restore drills will not happen.** C3 says the maintainer has a demanding job and intermittent attention. A quarterly manual drill is exactly the kind of commitment that gets skipped twice and then forgotten, and its absence is invisible until the day it matters.

*Fixed:* the drill is a **script** (`scripts/restore-drill`), not a procedure, and it is invoked by the same nightly job infrastructure on a quarterly schedule, writing its result to `job_run`. A missing or failed drill record raises the same alert as a missing nightly job (§5.16). The rule generalises and is now explicit in §11.6: under C3, any recurring operation that depends on human memory will not happen, so it must be automated or it must be assumed absent.

### 14.4 Residual risk — accepted, not solved

Five things this blueprint does not solve. They are listed so that nobody mistakes their absence for an oversight.

1. **Habit formation is not an engineering problem.** Everything reasonable has been done — sixty-second ritual, ten-second fallback, no guilt, forgiving North Star, a validation gate that stops the project if the habit does not form. If the operator does not want to do this every day, no architecture rescues it. This remains the highest-probability failure mode and it is largely outside the reach of anything in this document.

2. **Week 4 is still the riskiest week.** Encrypted media plus capture protocol plus two domains. The documented fallback is to ship skin *state* and defer skin *photography* to v0.2, keeping encryption in scope. Photos deferred is recoverable; photos stored unencrypted is not.

3. **The nightly job needs a persistent runtime, and that is the one piece of infrastructure C3 does not get for free.** Named in §10.3 and §13.2. It is a known, bounded cost — a micro-VM — rather than an unknown, but it is real and it will need attention that nothing else in the design requires.

4. **Insight value at n=1 is unproven.** The statistical controls in §10.6 ensure findings are *honest*. They cannot ensure findings are *interesting*. It is entirely possible that after two years the correct conclusion is that the deterministic detectors produce three genuinely useful findings a year and the rest is noise. That would still be a good outcome — three real findings about your own body is more than most people ever get — but the V2 gate exists to force the question rather than let the insight surface accumulate unexamined.

5. **Twenty years is longer than any of these judgements can see.** Postgres and plain text are the two bets most likely to survive it, and both were chosen for that reason. The rest of this document should be expected to be substantially wrong by 2036 — and the layering in §5.0 exists precisely so that being wrong about the application does not mean being wrong about the record.

### 14.5 Verdict

**This is startup-quality, with three conditions.**

It is startup-quality in the sense that matters: the foundational decisions — append-only observations, a metric registry, framework-free domain logic, deterministic-before-generative, bitemporal medical events, encryption at the sensitive tier, and export as a shipped feature — are the ones that are expensive to retrofit and cheap to get right now. Those are correct, and they are correct for reasons stated rather than assumed.

The three conditions, in order:

1. **Honour the V1 gate.** If Compounding Days is below 25 on 29 September 2026, October is spent on capture friction and not on V2. The temptation to build the next module while the habit is still fragile is the most likely way this fails, and it will feel productive right up until it doesn't.

2. **Do not add a domain before its predecessor is genuinely used.** The never-build list (§2.5) protects against the wrong features. Only discipline protects against the right features arriving too early.

3. **Never weaken §10.0 or §10.10.** The moment a language model is permitted to compute a number or assert a clinical relationship, this stops being a trustworthy medical record and becomes a plausible-sounding one. Every other principle here is a preference that could be revisited. That one is a boundary.

---

*End of blueprint. Next revision due at the V1 gate, 29 September 2026.*
