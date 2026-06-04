# Trajectory: Pear cloud sandbox warm perceived-speed UX

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 3, 2026 at 12:05 AM
> **Completed:** June 3, 2026 at 12:20 AM

---

## Summary

Opened Pear PR #71 for cloud sandbox perceived-speed: warm-on-intent prewarm reuse/cancel, immediate preparing view with queued first prompt flush, optional phase/eta progress contract, and read/write cloud scope split retained. Verified npm run build, npm test, and git diff --check.

**Approach:** Standard approach

---

## Key Decisions

### Include minimal runtime read/write scope split on warm UX branch
- **Chose:** Include minimal runtime read/write scope split on warm UX branch
- **Reasoning:** The branch is fresh from origin/main and the default cloud-agent live-sync attach path still passes invalid readwrite scopes via account workspace and mount setup; warm-on-intent and queued attach would otherwise fail after the sandbox warms.

### Use optional phase/etaMs progress contract with legacy fallback
- **Chose:** Use optional phase/etaMs progress contract with legacy fallback
- **Reasoning:** codex-2 confirmed cloud PR #1720 will emit additive phase and etaMs fields; Pear consumes those names exactly but falls back to status-only warming UI when absent.

---

## Chapters

### 1. Work
*Agent: default*

- Include minimal runtime read/write scope split on warm UX branch: Include minimal runtime read/write scope split on warm UX branch
- Use optional phase/etaMs progress contract with legacy fallback: Use optional phase/etaMs progress contract with legacy fallback
- Warm-on-intent, background attach, queued prompt, optional progress contract, cancel/reap, and runtime scope prerequisites are implemented; build and npm test are green
- Warm-on-intent, queued prompt, and optional phase/eta progress are implemented; build and npm test are green before commit

---

## Artifacts

**Commits:** ffd01ca
**Files changed:** 12
