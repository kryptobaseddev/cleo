---
id: t13275-page-clock
tasks: [T13275]
kind: fix
summary: A sync apply page's time budget counts applying, not its rewind
---

The page time bound (`REBASE_PAGE_MS`) used to be measured from before the page's rewind. When the local scope was large, the rewind
alone could use up the budget. Every page then took a single transaction, and each page rewound and replayed the same scope again,
all under the write lock. The bound now starts once the rewind is done.
