# Orchestra UX North Star

## UX objective

Orchestra should make multi-agent project execution feel clear, calm, and steerable.

The interface should help a user understand work in motion at a glance, then act with confidence.

## Experience statement

A user opening Orchestra should feel:
- oriented immediately
- aware of what is active and what is waiting
- able to drill into detail without getting lost
- able to intervene without breaking flow
- confident that the system remembers prior work and session context

The UX should turn orchestration complexity into operational clarity.

## Primary UX jobs

The product should make these actions easy:
1. select the current project context
2. scan the overall state of work
3. identify what needs attention now
4. inspect a specific task, agent, role, or session
5. send a message or comment with clear intent
6. decide whether to interrupt or queue work
7. resume from prior context instead of reconstructing it

## Interaction principles

### 1. Scan first, inspect second

Top-level views should support fast scanning before deep reading.

Users should be able to identify:
- active sessions
- blocked tasks
- busy vs idle agents
- queue depth
- pending user review

without opening multiple nested panels.

### 2. State should be explicit

The UI should prefer visible state over implied state.

Examples:
- show whether a session is active, idle, resumed, or disconnected
- show whether a message will interrupt or queue
- show whether a task is waiting on a user, an agent, or a role queue
- show when a lane is being resumed versus started fresh

### 3. Important actions must feel intentional

Actions that alter live work should be deliberate and legible.

Examples:
- interrupting an agent should be an explicit choice
- moving a task between lanes should clearly show the consequence
- resuming a session should identify which session is being resumed

### 4. Keep hierarchy shallow

The product should avoid burying operational detail behind too many layers.

Preferred pattern:
- global navigation
- page-level secondary navigation when needed
- detail pane or main content area

Avoid deep nesting, stacked cards inside cards, or modal-heavy flows for routine work.

### 5. Continuity should be visible

Users should be able to see that the system remembers prior work.

Examples:
- lane history should show prior session usage
- session views should make resumption obvious
- comments and intervention should appear in context with the task or session they affect

### 6. Dense, not crowded

Orchestra should present a lot of useful information without feeling noisy.

Density should come from:
- clear typography
- consistent spacing
- crisp labels
- restrained status color
- structured lists and panes

not from cramming controls everywhere.

## Information architecture north star

### Primary navigation

The primary navigation should stay narrow and stable:
- project switcher at the top
- Tasks
- Agents
- Sessions
- Settings at the bottom

This creates a predictable frame for the app.

### Page responsibilities

#### Tasks
The task area should become the command center for workflow progress.

It should emphasize:
- lane position
- ownership
- comments
- lane history
- retry/review/intervention state

#### Agents
The agents area should unify persistent agents and transient roles into one workforce view.

It should emphasize:
- who is busy
- what each worker is doing
- queue depth
- active session access
- capacity and backlog pressure

Roles should be visually distinct from agents while still belonging to the same operational surface.

#### Sessions
The sessions area should be the clearest path into live execution.

It should emphasize:
- session list and status
- transcript or event stream
- subscription state
- message input
- resume actions

This is the first area that should feel fully alive.

#### Settings
Settings should hold lower-frequency configuration and developer/operator visibility.

It should include:
- workflow management
- logs
- later, global defaults and configuration surfaces

## Visual design direction

### Overall feel

The product should be:
- light
- crisp
- clean
- operational
- mature

It should not feel playful, glossy, or heavily branded.

### Color

Guidance:
- avoid blue as the primary accent
- use a warm or neutral accent for identity
- reserve stronger colors for semantic states such as success, warning, and error
- use color sparingly so important state stands out

### Surfaces

Guidance:
- prefer flat or gently elevated surfaces
- use whitespace and separators more than nested containers
- keep borders subtle but present
- avoid dashboard-card overload

### Typography

Guidance:
- support fast scanning with strong hierarchy
- use concise labels and restrained helper text
- let dense operational views remain readable at a glance

### Motion and feedback

Guidance:
- keep motion subtle and informative
- use it to confirm state changes, not decorate the interface
- prioritize responsiveness over flourish

## UX patterns to encourage

### Side-by-side context and action

Whenever possible, let the user see the thing they are acting on while taking the action.

Examples:
- session transcript beside message input
- task details beside comments and lane controls
- worker list beside workload detail

### Inline status signaling

Status should be visible where the user is already looking.

Examples:
- chips for active subscription state
- queue counts on workers or roles
- clear user-review badges on tasks
- inline markers for resumed sessions

### Reversible or inspectable workflows

When work fails, loops back, or needs intervention, the UX should explain what happened and where the work goes next.

Users should not have to mentally simulate the workflow engine.

## UX pitfalls to avoid

- chat transcripts becoming the only source of truth
- too many equally loud UI elements competing for attention
- hiding key status behind hover, disclosure, or modal flows
- relying on color alone to communicate state
- ambiguous actions that change live work without clear intent
- forcing users to reconstruct history from scattered views

## North-star scenarios

### Scenario 1: Morning scan
A user opens Orchestra and within seconds sees:
- one session active
- two tasks waiting for user review
- one role queue backing up
- no blocked repositories

They know where to start without clicking through the whole app.

### Scenario 2: Mid-flight intervention
A user sees that an agent is active on a task but needs redirecting. They add a comment and explicitly choose to interrupt the agent. The UI makes that decision visible and the session view reflects the interruption clearly.

### Scenario 3: Failed validation loop
A task fails validation and returns to implementation. The UI shows that the implementation lane is resuming its prior session, so the user understands continuity is preserved.

### Scenario 4: Session-first usage
Before the rest of the orchestration model is complete, the user can already create, resume, watch, and message a session through a clean Sessions UI. This experience should feel coherent, not temporary.

## UX decision filter

When evaluating a UX choice, ask:
1. Can a user scan this quickly?
2. Is the current state obvious?
3. Is the consequence of the main action clear?
4. Does this preserve context instead of forcing reconstruction?
5. Does this reduce noise while keeping operational detail visible?

If not, simplify.
