#!/usr/bin/env bash
# Generated: 2026-05-11T18:53:09.550Z
# Purpose: Remove stale dep entries (phantom-target IDs) flagged by cleo check coherence.
# Source: baseline-coherence.json (192 phantom-dep pairs over 156 source tasks).
# All 108 unique phantom targets are present in the archived task table.
#   106 archived-with-completedAt (deps already satisfied)
#   2 test fixtures (T002, T505 — completedAt/cancelledAt both null) — Agent C deletes them later
# Note: 99 of 156 source tasks are themselves archived;
#   their cleo update will fail with E_NOT_FOUND but is otherwise harmless. We emit the
#   command for completeness so the active-table dep cleanup is fully covered.

set -uo pipefail
# NOTE: `set -e` intentionally OFF — 99 of 156 source tasks are already archived;
# those cleo update commands exit 4 (E_NOT_FOUND). We tolerate and continue.
SUCCESS=0; FAILED=0
trap 'echo "Phantom-dep cleanup done: $SUCCESS succeeded, $FAILED failed (archived-source no-ops expected)."' EXIT

echo "==> T1042"
cleo update T1042 --remove-depends T1845 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1)) && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1533"  # src already archived — command will be no-op
cleo update T1533 --remove-depends T1532 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1565"  # src already archived — command will be no-op
cleo update T1565 --remove-depends T1564 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1566"  # src already archived — command will be no-op
cleo update T1566 --remove-depends T1565,T1603,T1611 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1568"  # src already archived — command will be no-op
cleo update T1568 --remove-depends T1565,T1585,T1604,T1605 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1569"  # src already archived — command will be no-op
cleo update T1569 --remove-depends T1568 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1570"  # src already archived — command will be no-op
cleo update T1570 --remove-depends T1569 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1571"  # src already archived — command will be no-op
cleo update T1571 --remove-depends T1570 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1572"  # src already archived — command will be no-op
cleo update T1572 --remove-depends T1571 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1573"  # src already archived — command will be no-op
cleo update T1573 --remove-depends T1572 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1574"  # src already archived — command will be no-op
cleo update T1574 --remove-depends T1573 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1575"  # src already archived — command will be no-op
cleo update T1575 --remove-depends T1574 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1576"  # src already archived — command will be no-op
cleo update T1576 --remove-depends T1575 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1577"  # src already archived — command will be no-op
cleo update T1577 --remove-depends T1576 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1578"  # src already archived — command will be no-op
cleo update T1578 --remove-depends T1577 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1579"  # src already archived — command will be no-op
cleo update T1579 --remove-depends T1578 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1580"  # src already archived — command will be no-op
cleo update T1580 --remove-depends T1579 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1581"  # src already archived — command will be no-op
cleo update T1581 --remove-depends T1580 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1582"  # src already archived — command will be no-op
cleo update T1582 --remove-depends T1581 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1583"  # src already archived — command will be no-op
cleo update T1583 --remove-depends T1582 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1584"  # src already archived — command will be no-op
cleo update T1584 --remove-depends T1583 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1588"  # src already archived — command will be no-op
cleo update T1588 --remove-depends T1587 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1591"  # src already archived — command will be no-op
cleo update T1591 --remove-depends T1587 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1593"  # src already archived — command will be no-op
cleo update T1593 --remove-depends T1589 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1594"  # src already archived — command will be no-op
cleo update T1594 --remove-depends T1591 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1595"  # src already archived — command will be no-op
cleo update T1595 --remove-depends T1588 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1597"  # src already archived — command will be no-op
cleo update T1597 --remove-depends T1595 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1598"  # src already archived — command will be no-op
cleo update T1598 --remove-depends T1593 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1600"
cleo update T1600 --remove-depends T1593 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1688"  # src already archived — command will be no-op
cleo update T1688 --remove-depends T1687 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1689"  # src already archived — command will be no-op
cleo update T1689 --remove-depends T1686 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1708"  # src already archived — command will be no-op
cleo update T1708 --remove-depends T1707 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1709"  # src already archived — command will be no-op
cleo update T1709 --remove-depends T1707 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1710"  # src already archived — command will be no-op
cleo update T1710 --remove-depends T1709 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1711"  # src already archived — command will be no-op
cleo update T1711 --remove-depends T1709 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1712"  # src already archived — command will be no-op
cleo update T1712 --remove-depends T1707,T1709 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1733"  # src already archived — command will be no-op
cleo update T1733 --remove-depends T1736 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1737"
cleo update T1737 --remove-depends T9080 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1738"
cleo update T1738 --remove-depends T1826 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1739"
cleo update T1739 --remove-depends T1816 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1740"
cleo update T1740 --remove-depends T1816 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1741"
cleo update T1741 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1742"
cleo update T1742 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1743"
cleo update T1743 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1745"
cleo update T1745 --remove-depends T1819 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1750"
cleo update T1750 --remove-depends T1817 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1751"
cleo update T1751 --remove-depends T1817 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1758"  # src already archived — command will be no-op
cleo update T1758 --remove-depends T1759 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1760"  # src already archived — command will be no-op
cleo update T1760 --remove-depends T1758,T1759 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1761"  # src already archived — command will be no-op
cleo update T1761 --remove-depends T1759 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1764"  # src already archived — command will be no-op
cleo update T1764 --remove-depends T1733 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1765"  # src already archived — command will be no-op
cleo update T1765 --remove-depends T1763,T1764 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1767"  # src already archived — command will be no-op
cleo update T1767 --remove-depends T1759,T1761 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1785"
cleo update T1785 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1786"
cleo update T1786 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1787"
cleo update T1787 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1815"  # src already archived — command will be no-op
cleo update T1815 --remove-depends T1814 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1817"  # src already archived — command will be no-op
cleo update T1817 --remove-depends T1816 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1818"  # src already archived — command will be no-op
cleo update T1818 --remove-depends T1816 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1819"  # src already archived — command will be no-op
cleo update T1819 --remove-depends T1816 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1820"
cleo update T1820 --remove-depends T1819,T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1821"
cleo update T1821 --remove-depends T1817,T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1822"
cleo update T1822 --remove-depends T1817,T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1823"
cleo update T1823 --remove-depends T1817,T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1825"
cleo update T1825 --remove-depends T1826,T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1827"  # src already archived — command will be no-op
cleo update T1827 --remove-depends T1826 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1828"  # src already archived — command will be no-op
cleo update T1828 --remove-depends T1826 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1829"  # src already archived — command will be no-op
cleo update T1829 --remove-depends T1826,T1827 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1830"  # src already archived — command will be no-op
cleo update T1830 --remove-depends T1826 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1833"  # src already archived — command will be no-op
cleo update T1833 --remove-depends T1764 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1834"  # src already archived — command will be no-op
cleo update T1834 --remove-depends T1845 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1835"
cleo update T1835 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1836"
cleo update T1836 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1837"
cleo update T1837 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1839"  # src already archived — command will be no-op
cleo update T1839 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1843"
cleo update T1843 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1844"
cleo update T1844 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1846"  # src already archived — command will be no-op
cleo update T1846 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1847"
cleo update T1847 --remove-depends T1841 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1852"  # src already archived — command will be no-op
cleo update T1852 --remove-depends T1851 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1854"  # src already archived — command will be no-op
cleo update T1854 --remove-depends T1853 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1857"  # src already archived — command will be no-op
cleo update T1857 --remove-depends T1856 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1858"  # src already archived — command will be no-op
cleo update T1858 --remove-depends T1857 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1859"  # src already archived — command will be no-op
cleo update T1859 --remove-depends T1857 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1864"  # src already archived — command will be no-op
cleo update T1864 --remove-depends T1856 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1873"
cleo update T1873 --remove-depends T1864 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1915"  # src already archived — command will be no-op
cleo update T1915 --remove-depends T1912 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1916"  # src already archived — command will be no-op
cleo update T1916 --remove-depends T1911 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1917"  # src already archived — command will be no-op
cleo update T1917 --remove-depends T1913 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1918"  # src already archived — command will be no-op
cleo update T1918 --remove-depends T1915 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1919"  # src already archived — command will be no-op
cleo update T1919 --remove-depends T1916 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1920"  # src already archived — command will be no-op
cleo update T1920 --remove-depends T1917 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1921"  # src already archived — command will be no-op
cleo update T1921 --remove-depends T1919 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1922"  # src already archived — command will be no-op
cleo update T1922 --remove-depends T1918,T1919,T1920,T1921 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1929"  # src already archived — command will be no-op
cleo update T1929 --remove-depends T9037 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1931"  # src already archived — command will be no-op
cleo update T1931 --remove-depends T1930 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1932"  # src already archived — command will be no-op
cleo update T1932 --remove-depends T1931 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1933"  # src already archived — command will be no-op
cleo update T1933 --remove-depends T1932 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1934"  # src already archived — command will be no-op
cleo update T1934 --remove-depends T1932 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1935"  # src already archived — command will be no-op
cleo update T1935 --remove-depends T1931,T1932 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1936"  # src already archived — command will be no-op
cleo update T1936 --remove-depends T1932,T1934 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1937"  # src already archived — command will be no-op
cleo update T1937 --remove-depends T1930 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1938"  # src already archived — command will be no-op
cleo update T1938 --remove-depends T1933,T1934 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1939"  # src already archived — command will be no-op
cleo update T1939 --remove-depends T1930 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1940"  # src already archived — command will be no-op
cleo update T1940 --remove-depends T1933,T1934,T1935,T1936,T1937,T1938 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1941"  # src already archived — command will be no-op
cleo update T1941 --remove-depends T1940,T9032,T9033 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1942"
cleo update T1942 --remove-depends T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1943"
cleo update T1943 --remove-depends T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1950"
cleo update T1950 --remove-depends T1937 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1955"
cleo update T1955 --remove-depends T1858 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1958"  # test fixture — src will be deleted by Agent C
cleo update T1958 --remove-depends T002 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1962"  # test fixture — src will be deleted by Agent C
cleo update T1962 --remove-depends T002 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T1966"  # test fixture — src will be deleted by Agent C
cleo update T1966 --remove-depends T002 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T506"  # test fixture — src will be deleted by Agent C
cleo update T506 --remove-depends T505 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9006"  # src already archived — command will be no-op
cleo update T9006 --remove-depends T002 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9014"  # src already archived — command will be no-op
cleo update T9014 --remove-depends T9013 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9020"  # src already archived — command will be no-op
cleo update T9020 --remove-depends T1939 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9022"
cleo update T9022 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9023"
cleo update T9023 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9025"
cleo update T9025 --remove-depends T9050,T9052 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9032"  # src already archived — command will be no-op
cleo update T9032 --remove-depends T1940 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9033"  # src already archived — command will be no-op
cleo update T9033 --remove-depends T9032 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9037"  # src already archived — command will be no-op
cleo update T9037 --remove-depends T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9038"
cleo update T9038 --remove-depends T1941 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9043"
cleo update T9043 --remove-depends T9039 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9045"
cleo update T9045 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9046"  # src already archived — command will be no-op
cleo update T9046 --remove-depends T9053 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9050"  # src already archived — command will be no-op
cleo update T9050 --remove-depends T9048,T9049,T9053 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9051"
cleo update T9051 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9054"
cleo update T9054 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9062"
cleo update T9062 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9063"
cleo update T9063 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9072"
cleo update T9072 --remove-depends T9068 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9073"  # src already archived — command will be no-op
cleo update T9073 --remove-depends T9071 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9074"  # src already archived — command will be no-op
cleo update T9074 --remove-depends T9069 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9075"
cleo update T9075 --remove-depends T9073 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9076"
cleo update T9076 --remove-depends T9070,T9073,T9074 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9082"  # src already archived — command will be no-op
cleo update T9082 --remove-depends T9081 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9083"  # src already archived — command will be no-op
cleo update T9083 --remove-depends T9082 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9084"  # src already archived — command will be no-op
cleo update T9084 --remove-depends T9081,T9082 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9085"  # src already archived — command will be no-op
cleo update T9085 --remove-depends T9082,T9084 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9088"  # src already archived — command will be no-op
cleo update T9088 --remove-depends T9087 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9089"  # src already archived — command will be no-op
cleo update T9089 --remove-depends T9088 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9167"  # src already archived — command will be no-op
cleo update T9167 --remove-depends T9166 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9168"  # src already archived — command will be no-op
cleo update T9168 --remove-depends T9164 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9169"
cleo update T9169 --remove-depends T9166 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9170"
cleo update T9170 --remove-depends T9167,T9168 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9176"  # src already archived — command will be no-op
cleo update T9176 --remove-depends T9166 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9186"
cleo update T9186 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9187"
cleo update T9187 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9188"
cleo update T9188 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9192"
cleo update T9192 --remove-depends T9050 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T9213"
cleo update T9213 --remove-depends T9082 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> T945"  # src already archived — command will be no-op
cleo update T945 --remove-depends T1110 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> W2T1"  # test fixture — src will be deleted by Agent C
cleo update W2T1 --remove-depends W1T1 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))
echo "==> W2T2"  # test fixture — src will be deleted by Agent C
cleo update W2T2 --remove-depends W1T2 && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))

echo "Done. Re-run: cleo check coherence"
