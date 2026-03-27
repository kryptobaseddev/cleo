import fs from 'fs/promises';
import path from 'path';

const CAAMP_TESTS = 'packages/caamp/tests';

async function fixFile(filePath) {
  let content = await fs.readFile(filePath, 'utf8');
  if (content.includes('capabilities: {') && !content.includes('agentSkillsCompatible:')) return;
  
  // replace makeProvider({...}) or return { ... } in mocks
  const capabilitiesString = `capabilities: { skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: "vendor-only" }, hooks: { supported: [], hookConfigPath: null, hookFormat: null }, spawn: { supportsSubagents: false, supportsProgrammaticSpawn: false, supportsInterAgentComms: false, supportsParallelSpawn: false, spawnMechanism: null } }`;

  content = content.replace(/agentSkillsCompatible: (true|false),(\s*)(?!capabilities)/g, `agentSkillsCompatible: $1,$2${capabilitiesString},$2`);
  await fs.writeFile(filePath, content, 'utf8');
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
    } else if (fullPath.endsWith('.ts')) {
      await fixFile(fullPath);
    }
  }
}

await walk(CAAMP_TESTS);
