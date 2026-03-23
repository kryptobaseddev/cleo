import fs from 'fs';
let content = fs.readFileSync('docs/epics/EPIC-TASK-SYSTEM-HARDENING.md', 'utf8');

// I accidentally changed all T048 to T056, but there was already an original T056 (ct-validator).
// Let's identify the original T056 (ct-validator) and temporarily change it to T056_ORIG
content = content.replace(/T056: Create ct-validator/g, 'T056_ORIG: Create ct-validator');

// Wait, the dependencies list had T056 too: "T056: Validator Skill (→ T055)"
content = content.replace(/T056: Validator Skill/g, 'T056_ORIG: Validator Skill');

// We also need to change T056 when it's just referenced. "Parent: T056" ? No, that was Parent: T048, which became Parent: T056.
// What about dependencies for Telemetry? Telemetry (T057) depends on T055, not T056.
// Is T056 referenced anywhere else?
// The wave breakdown: "T056: Create ct-validator Skill (→ T055)"
// The list: "T056: Validator Skill (→ T055)"

// Any other "T056" is actually T048!
content = content.replace(/T056/g, 'T048');

// Put the original T056 back
content = content.replace(/T056_ORIG/g, 'T056');

// Now we have the file back to its original state (T048-T060).
// Let's apply the correct mapping safely.
// We'll replace matching \bT0XX\b to avoid substring issues.

const mapping = {
  'T060': 'T068',
  'T059': 'T067',
  'T058': 'T066',
  'T057': 'T065',
  'T056': 'T064',
  'T055': 'T063',
  'T054': 'T062',
  'T053': 'T061',
  'T052': 'T060',
  'T051': 'T059',
  'T050': 'T058',
  'T049': 'T057',
  'T048': 'T056'
};

// We must sort by keys descending to prevent replacing T052->T060 and then T060->T068 again!
const keys = Object.keys(mapping).sort().reverse();
for (const key of keys) {
  const regex = new RegExp(`\\b${key}\\b`, 'g');
  content = content.replace(regex, mapping[key]);
}

fs.writeFileSync('docs/epics/EPIC-TASK-SYSTEM-HARDENING.md', content);
