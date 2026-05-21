---
id: t9852-gh-390-saga-walk
tasks: [T9852, T9839]
kind: fix
summary: orchestrate ready/waves traverse saga 'groups' relation (+ --via flag)
prs: [422]
---

Closes #390. ADR-073 sagas hold members via task_relations.relation_type='groups' not parentId — orchestrateReady/Waves now detects label='saga' and walks the groups relation. New --via flag (parent|saga|both, default both). Envelope adds via + sagaMembers + sagaNestedSkipped diagnostics.
