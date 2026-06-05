# Trajectory: Fix cloud agent invalid scopes in Pear

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 2, 2026 at 11:58 PM
> **Completed:** June 3, 2026 at 12:03 AM

---

## Summary

Opened PR #70 fixing Pear cloud-agent invalid_scopes by replacing relayfile readwrite scope actions with separate read and write scopes, updating stale specs, and adding focused scope assertions. Build and npm test passed; codex-2 verified no blocker or major findings.

**Approach:** Standard approach

---

## Key Decisions

### Expanded cloud Relayfile scopes into separate read and write actions
- **Chose:** Expanded cloud Relayfile scopes into separate read and write actions
- **Reasoning:** Cloud scope grammar accepts only read/write actions; readwrite is rejected as invalid_scopes. Also updated stale integration spec references.

### Added focused test assertions for split Relayfile scopes
- **Chose:** Added focused test assertions for split Relayfile scopes
- **Reasoning:** codex-2 found the runtime fix correct but noted tests did not assert the exact scope shape; assertions now capture account workspace and cloud-agent mount scopes.

---

## Chapters

### 1. Work
*Agent: default*

- Expanded cloud Relayfile scopes into separate read and write actions: Expanded cloud Relayfile scopes into separate read and write actions
- Build and npm test pass; waiting for codex-2 verification before committing the scope fix
- Added focused test assertions for split Relayfile scopes: Added focused test assertions for split Relayfile scopes
- Scope fix verified by codex-2, build, and npm test; added direct assertions for account and cloud-agent mount scope options

---

## Artifacts

**Commits:** 723ebc1
**Files changed:** 7
