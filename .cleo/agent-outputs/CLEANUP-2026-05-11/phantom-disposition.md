# Phantom Dependency Disposition

Generated: 2026-05-11T18:53:09.550Z  
Agent: A (cleanup team)  
Input: `baseline-coherence.json` (192 phantom-dep pairs)

## Summary

| Metric | Value |
|---|---|
| Total phantom-dep pairs (entries to remove) | 192 |
| Unique source tasks affected | 156 |
| Unique phantom targets | 108 |
| Source tasks in active table | 57 |
| Source tasks already archived (commands are no-ops) | 99 |
| Source tasks flagged as test fixtures | 6 |

### Phantom target disposition (108 unique IDs)

| State | Count | Meaning |
|---|---|---|
| archived with `completedAt` | 106 | Dep already satisfied — safe to remove |
| archived with `cancelledAt` | 0 | (none) |
| archived, neither timestamp set | 2 | T002, T505 test fixtures |
| not present in archive | 0 | (none — every phantom confirmed in archive) |

## Test fixture phantoms (special handling)

These two phantom targets are archived test fixtures with neither `completedAt` nor `cancelledAt` set. The remediation is identical (remove the dep entry from dependents); Agent C will delete the underlying records from the archive table later.

| Phantom | Title | Dependents |
|---|---|---|
| `T002` | New done | T1958, T1962, T1966, T9006 |
| `T505` | Done dep | T506 |

## Anomalies

- None of the 108 phantom targets are missing from the archive — coherence check accuracy is 100%.
- 99 of 156 source tasks are themselves archived. Their `cleo update` calls will return `E_NOT_FOUND` (exit 4) because `cleo update` operates on active tasks only. These are emitted for completeness but are harmless — the dep entries they reference live in the archived task records and cannot be edited through the active-table CLI. They will be addressed when Agent B/C purges or rewrites archived rows directly. Each such line is annotated in the bash script with `# src already archived — command will be no-op`.
- 6 source tasks are test fixtures (titles like "JWT tokens (imported)", "Task with done dep", "Wave-2 Task A"). Commands are emitted but will be redundant once Agent C deletes the fixtures. Each is annotated `# test fixture — src will be deleted by Agent C`.

## Source → phantoms to remove

| Source | # | Phantoms to remove | Notes |
|---|---|---|---|
| `T1042` | 1 | `T1845` | active |
| `T1533` | 1 | `T1532` | src archived |
| `T1565` | 1 | `T1564` | src archived |
| `T1566` | 3 | `T1565`, `T1603`, `T1611` | src archived |
| `T1568` | 4 | `T1565`, `T1585`, `T1604`, `T1605` | src archived |
| `T1569` | 1 | `T1568` | src archived |
| `T1570` | 1 | `T1569` | src archived |
| `T1571` | 1 | `T1570` | src archived |
| `T1572` | 1 | `T1571` | src archived |
| `T1573` | 1 | `T1572` | src archived |
| `T1574` | 1 | `T1573` | src archived |
| `T1575` | 1 | `T1574` | src archived |
| `T1576` | 1 | `T1575` | src archived |
| `T1577` | 1 | `T1576` | src archived |
| `T1578` | 1 | `T1577` | src archived |
| `T1579` | 1 | `T1578` | src archived |
| `T1580` | 1 | `T1579` | src archived |
| `T1581` | 1 | `T1580` | src archived |
| `T1582` | 1 | `T1581` | src archived |
| `T1583` | 1 | `T1582` | src archived |
| `T1584` | 1 | `T1583` | src archived |
| `T1588` | 1 | `T1587` | src archived |
| `T1591` | 1 | `T1587` | src archived |
| `T1593` | 1 | `T1589` | src archived |
| `T1594` | 1 | `T1591` | src archived |
| `T1595` | 1 | `T1588` | src archived |
| `T1597` | 1 | `T1595` | src archived |
| `T1598` | 1 | `T1593` | src archived |
| `T1600` | 1 | `T1593` | active |
| `T1688` | 1 | `T1687` | src archived |
| `T1689` | 1 | `T1686` | src archived |
| `T1708` | 1 | `T1707` | src archived |
| `T1709` | 1 | `T1707` | src archived |
| `T1710` | 1 | `T1709` | src archived |
| `T1711` | 1 | `T1709` | src archived |
| `T1712` | 2 | `T1707`, `T1709` | src archived |
| `T1733` | 1 | `T1736` | src archived |
| `T1737` | 1 | `T9080` | active |
| `T1738` | 1 | `T1826` | active |
| `T1739` | 1 | `T1816` | active |
| `T1740` | 1 | `T1816` | active |
| `T1741` | 1 | `T1841` | active |
| `T1742` | 1 | `T1841` | active |
| `T1743` | 1 | `T1841` | active |
| `T1745` | 1 | `T1819` | active |
| `T1750` | 1 | `T1817` | active |
| `T1751` | 1 | `T1817` | active |
| `T1758` | 1 | `T1759` | src archived |
| `T1760` | 2 | `T1758`, `T1759` | src archived |
| `T1761` | 1 | `T1759` | src archived |
| `T1764` | 1 | `T1733` | src archived |
| `T1765` | 2 | `T1763`, `T1764` | src archived |
| `T1767` | 2 | `T1759`, `T1761` | src archived |
| `T1785` | 1 | `T1841` | active |
| `T1786` | 1 | `T1841` | active |
| `T1787` | 1 | `T1841` | active |
| `T1815` | 1 | `T1814` | src archived |
| `T1817` | 1 | `T1816` | src archived |
| `T1818` | 1 | `T1816` | src archived |
| `T1819` | 1 | `T1816` | src archived |
| `T1820` | 2 | `T1819`, `T1941` | active |
| `T1821` | 2 | `T1817`, `T1941` | active |
| `T1822` | 2 | `T1817`, `T1941` | active |
| `T1823` | 2 | `T1817`, `T1941` | active |
| `T1825` | 2 | `T1826`, `T1941` | active |
| `T1827` | 1 | `T1826` | src archived |
| `T1828` | 1 | `T1826` | src archived |
| `T1829` | 2 | `T1826`, `T1827` | src archived |
| `T1830` | 1 | `T1826` | src archived |
| `T1833` | 1 | `T1764` | src archived |
| `T1834` | 1 | `T1845` | src archived |
| `T1835` | 1 | `T1841` | active |
| `T1836` | 1 | `T1841` | active |
| `T1837` | 1 | `T1841` | active |
| `T1839` | 1 | `T1841` | src archived |
| `T1843` | 1 | `T1841` | active |
| `T1844` | 1 | `T1841` | active |
| `T1846` | 1 | `T1841` | src archived |
| `T1847` | 1 | `T1841` | active |
| `T1852` | 1 | `T1851` | src archived |
| `T1854` | 1 | `T1853` | src archived |
| `T1857` | 1 | `T1856` | src archived |
| `T1858` | 1 | `T1857` | src archived |
| `T1859` | 1 | `T1857` | src archived |
| `T1864` | 1 | `T1856` | src archived |
| `T1873` | 1 | `T1864` | active |
| `T1915` | 1 | `T1912` | src archived |
| `T1916` | 1 | `T1911` | src archived |
| `T1917` | 1 | `T1913` | src archived |
| `T1918` | 1 | `T1915` | src archived |
| `T1919` | 1 | `T1916` | src archived |
| `T1920` | 1 | `T1917` | src archived |
| `T1921` | 1 | `T1919` | src archived |
| `T1922` | 4 | `T1918`, `T1919`, `T1920`, `T1921` | src archived |
| `T1929` | 1 | `T9037` | src archived |
| `T1931` | 1 | `T1930` | src archived |
| `T1932` | 1 | `T1931` | src archived |
| `T1933` | 1 | `T1932` | src archived |
| `T1934` | 1 | `T1932` | src archived |
| `T1935` | 2 | `T1931`, `T1932` | src archived |
| `T1936` | 2 | `T1932`, `T1934` | src archived |
| `T1937` | 1 | `T1930` | src archived |
| `T1938` | 2 | `T1933`, `T1934` | src archived |
| `T1939` | 1 | `T1930` | src archived |
| `T1940` | 6 | `T1933`, `T1934`, `T1935`, `T1936`, `T1937`, `T1938` | src archived |
| `T1941` | 3 | `T1940`, `T9032`, `T9033` | src archived |
| `T1942` | 1 | `T1941` | active |
| `T1943` | 1 | `T1941` | active |
| `T1950` | 1 | `T1937` | active |
| `T1955` | 1 | `T1858` | active |
| `T1958` | 1 | `T002` | fixture |
| `T1962` | 1 | `T002` | fixture |
| `T1966` | 1 | `T002` | fixture |
| `T506` | 1 | `T505` | fixture |
| `T9006` | 1 | `T002` | src archived |
| `T9014` | 1 | `T9013` | src archived |
| `T9020` | 1 | `T1939` | src archived |
| `T9022` | 1 | `T9050` | active |
| `T9023` | 1 | `T9050` | active |
| `T9025` | 2 | `T9050`, `T9052` | active |
| `T9032` | 1 | `T1940` | src archived |
| `T9033` | 1 | `T9032` | src archived |
| `T9037` | 1 | `T1941` | src archived |
| `T9038` | 1 | `T1941` | active |
| `T9043` | 1 | `T9039` | active |
| `T9045` | 1 | `T9050` | active |
| `T9046` | 1 | `T9053` | src archived |
| `T9050` | 3 | `T9048`, `T9049`, `T9053` | src archived |
| `T9051` | 1 | `T9050` | active |
| `T9054` | 1 | `T9050` | active |
| `T9062` | 1 | `T9050` | active |
| `T9063` | 1 | `T9050` | active |
| `T9072` | 1 | `T9068` | active |
| `T9073` | 1 | `T9071` | src archived |
| `T9074` | 1 | `T9069` | src archived |
| `T9075` | 1 | `T9073` | active |
| `T9076` | 3 | `T9070`, `T9073`, `T9074` | active |
| `T9082` | 1 | `T9081` | src archived |
| `T9083` | 1 | `T9082` | src archived |
| `T9084` | 2 | `T9081`, `T9082` | src archived |
| `T9085` | 2 | `T9082`, `T9084` | src archived |
| `T9088` | 1 | `T9087` | src archived |
| `T9089` | 1 | `T9088` | src archived |
| `T9167` | 1 | `T9166` | src archived |
| `T9168` | 1 | `T9164` | src archived |
| `T9169` | 1 | `T9166` | active |
| `T9170` | 2 | `T9167`, `T9168` | active |
| `T9176` | 1 | `T9166` | src archived |
| `T9186` | 1 | `T9050` | active |
| `T9187` | 1 | `T9050` | active |
| `T9188` | 1 | `T9050` | active |
| `T9192` | 1 | `T9050` | active |
| `T9213` | 1 | `T9082` | active |
| `T945` | 1 | `T1110` | src archived |
| `W2T1` | 1 | `W1T1` | fixture |
| `W2T2` | 1 | `W1T2` | fixture |

## Command Format Verification

`cleo update <src> --remove-depends <p1>,<p2>,<p3>` uses comma-separated phantom IDs as a single argument. The generated script emits exactly this form (one command per source). No commands rely on multiple `--remove-depends` flags.

## Handoff

- Agent A (this report) — analysis + script generation: **done**
- Owner / Agent: review `phantom-disposition.md`, run `phantom-disposition.sh`
- Expected coherence delta after run: 192 phantom-dep issues resolved (active-table sources only)
- Residual: 99 archived-source rows still carry phantom deps in the archived table — Agent B/C territory
