# Performance Baseline Checklist

Run this checklist before and after major performance changes.

## Environment

- macOS or Linux release build
- Same repo, same branch, no extra heavy apps
- Same number of open projects/tasks for each run

## Startup

1. Start app from a cold launch.
2. Measure time-to-interactive (window visible and input responsive).
3. Repeat 5 times and record median.

## Terminal Responsiveness

1. Create 1 task terminal and run a command with continuous output.
2. Measure keypress-to-echo latency while output is active.
3. Repeat with 4 and 8 concurrent terminals.

## CPU and Memory

1. Record renderer and main process CPU at idle (no active output).
2. Record CPU during sustained terminal output.
3. Record resident memory after 5 minutes idle and 5 minutes load.

## Git Status Load

1. Open multiple tasks and perform commit/push/rebase operations.
2. Confirm status updates appear after each operation.
3. Confirm idle CPU remains low between operations.

## Pass Criteria

- Startup median is not worse than previous baseline.
- Keypress latency at 4 terminals is improved or unchanged.
- Idle CPU is improved after event-driven status changes.
- No regressions in terminal output correctness or task status.
