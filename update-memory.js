import fs from 'fs';

const memoryPath = '/home/keatonhoskins/.claude/projects/-mnt-projects-claude-todo/memory/MEMORY.md';
if (fs.existsSync(memoryPath)) {
  let memory = fs.readFileSync(memoryPath, 'utf8');

  memory = memory.replace(/NEXUS domain handler: STUB ONLY \(E_NOT_IMPLEMENTED for all ops\)/g, 'NEXUS domain handler: FULLY IMPLEMENTED (24 operations: 11 query + 13 mutate)');
  memory = memory.replace(/No registry entries, no nexus\.db schema/g, 'Full business logic delegating to src/core/nexus/');
  memory = memory.replace(/Depends on: stable BRAIN foundation \(now done\)/g, 'Includes merged sharing operations (T5277) and passing tests.');
  
  memory = memory.replace(/233 files, 3847 tests/g, '242 files, 3912 tests');
  
  fs.writeFileSync(memoryPath, memory);
  console.log('MEMORY.md updated');
} else {
  console.log('MEMORY.md not found at ' + memoryPath);
}
