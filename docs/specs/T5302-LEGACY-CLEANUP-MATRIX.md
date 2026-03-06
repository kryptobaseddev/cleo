# T5302 Legacy Reference Cleanup Matrix

Task: `T5302`  
Parent Epic: `T5284`  
Status: complete

## Scope Matrix

| Scope | Goal | Status | Evidence |
| --- | --- | --- | --- |
| Runtime source refs | Remove runtime fallback/legacy JSON paths and dead runtime references | Complete | `f3a04c4f`, `5d761f01` |
| Protocol/docs refs | Align canonical docs with runtime reality and operation constitution | Complete | `4e85006e`, `ad78edb6` |
| Test fixture refs | Migrate active tests to SQLite fixtures/helpers and stabilize behavior | Complete | `b70fb932`, current T5306/T5307 updates |
| Migration subsystem refs | Remove dead migration script references from active repository paths | Complete | `89fc3318`, current `.cleo/DATA-SAFETY-IMPLEMENTATION-SUMMARY.md` cleanup |

## Notes

- This matrix is intentionally execution-ordered to match the original T5302 requirement.
- Remaining `todo.json` mentions in migration/upgrade compatibility tests are intentional fixtures, not runtime storage paths.
