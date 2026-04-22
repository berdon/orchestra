# ORC-37 — transactional task number allocation plan

## Goal

Prevent concurrent task creation for the same project from allocating the same `sequence_number` / `number`, while keeping task numbering project-local and preserving existing task numbers.

## Root cause

`src-tauri/src/services/tasks.rs` currently does this in `create_task_from_blueprint(...)`:

1. normalize and validate the input
2. call `next_task_sequence_number(connection, project_id)`
3. read the project task prefix
4. open the insert transaction
5. insert the task

The race is between steps 2 and 4.

Because `next_task_sequence_number(...)` is `SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM tasks WHERE project_id = ?1`, two concurrent writers can both read the same next value before either transaction inserts. One insert then wins, and the other trips the existing unique indexes on:

- `tasks(project_id, sequence_number)`
- `tasks(project_id, number)`

That matches the observed `duplicate (project_id, number)` failures without requiring deleted-project corruption.

## Recommended fix

### 1. Start the write transaction before number allocation

The safest low-risk fix for the current SQLite-backed implementation is to move sequence allocation fully inside the task-creation transaction and make that transaction `IMMEDIATE`.

Recommended change in `src-tauri/src/services/tasks.rs`:

1. keep input normalization/validation as today
2. open the task creation transaction with `transaction_with_behavior(TransactionBehavior::Immediate)`
3. call `next_task_sequence_number(&tx, project_id)` from inside that transaction
4. read the project task prefix from the same transaction scope
5. format `${task_prefix}-${sequence_number}`
6. insert the task and related rows
7. commit

Why this works:

- `BEGIN IMMEDIATE` acquires SQLite's write reservation before the `MAX(sequence_number) + 1` query runs
- a second concurrent task creator must wait for the first writer to commit before it can allocate its own number
- the losing writer no longer observes the same `MAX(...)` snapshot, so it allocates the next sequence instead of colliding on the unique indexes
- the change is tightly scoped to the failing path and does not require new schema or migration work

Implementation note:

- the sequence query and prefix lookup should both run through the transaction handle so number allocation and insert use one serialized view of project state
- the existing unique indexes on `(project_id, sequence_number)` and `(project_id, number)` remain the final integrity guard, but they should no longer fire during normal concurrent creates

### 2. Keep task-number semantics unchanged

Do **not** rewrite existing `tasks.number` values.

The fix should only change when the next number is reserved:

- existing tasks keep their stored numbers
- future tasks continue to use the current project prefix plus the next project-local sequence
- prefix changes still only affect future tasks
- no frontend or transport schema changes should be required because the user-facing task shape stays the same

## Regression coverage

Add focused automated coverage in Rust.

### 1. Concurrent create regression test

Add a file-backed SQLite test in `src-tauri/src/services/tasks.rs` that:

1. initializes a temp database in WAL mode
2. seeds one project/workflow
3. opens two separate `rusqlite::Connection`s to the same DB
4. starts two threads that both call the public `create_task(...)` path for the same project
5. asserts both calls succeed
6. asserts the created tasks get distinct sequential numbers for that project (for example `APP-1` and `APP-2`)

Important test-design note:

- make this test deterministic rather than relying on timing luck
- the simplest route is to add a small `#[cfg(test)]` synchronization hook around the allocation/insert boundary so both threads are forced into the previously vulnerable window
- if a deterministic hook is not needed after implementation, at minimum the test should coordinate both threads with a barrier and validate that neither returns a unique-constraint error

### 2. Optional safety test: project isolation

A smaller follow-up test can prove that allocation stays project-local by creating tasks concurrently for two different projects and asserting each project advances its own sequence independently.

## Files likely to change

- `src-tauri/src/services/tasks.rs`
- optionally `src-tauri/src/services/task_schedules.rs` only if any task-creation test helpers or comments there should reference the new transactional allocator behavior

## Why this is the right fix for ORC-37

A project-side counter table/column would also work, but it is a larger design change than this bug requires.

For ORC-37, the failure is specifically that SQLite task creation reads `MAX(sequence_number) + 1` before it has taken the write lock. Moving the allocation under an `IMMEDIATE` transaction addresses that root cause directly while keeping the data model stable.

That makes this fix preferable because it:

- solves the actual race with minimal blast radius
- matches SQLite's single-writer concurrency model cleanly
- avoids extra migration/backfill work for an otherwise healthy schema
- still gives us a deterministic regression test around the conflicting-create scenario

## Validation for implementation

Minimum validation for the implementation lane:

- targeted Rust tests for `database.rs`
- targeted Rust tests for `tasks.rs`
- a full `cargo test` run for the Tauri crate if the targeted tests pass

Success looks like:

- concurrent task creation no longer fails with duplicate `(project_id, number)` / `(project_id, sequence_number)` conflicts caused by allocator races
- existing task numbers stay unchanged
- the new regression test makes the conflicting-create scenario hard to reintroduce
