#!/usr/bin/env node
/**
 * Migration script: todo.* → tasks.* file renaming
 * 
 * Handles safe migration of legacy CLEO files to the new naming convention.
 * Follows atomic operation pattern: backup → migrate → validate → cleanup.
 * 
 * @task T4743
 * @epic T4739
 */

import { existsSync, mkdirSync, renameSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { getCleoDirAbsolute } from '../core/paths.js';

/**
 * Migration file mapping
 */
interface FileMapping {
  legacy: string;
  new: string;
  description: string;
  required: boolean;
}

/**
 * Migration result
 */
interface MigrationResult {
  success: boolean;
  migrated: string[];
  skipped: string[];
  errors: string[];
  backups: string[];
}

/**
 * Get all file mappings for migration
 */
function getFileMappings(cwd?: string): FileMapping[] {
  const cleoDir = getCleoDirAbsolute(cwd);
  
  return [
    {
      legacy: join(cleoDir, 'todo.json'),
      new: join(cleoDir, 'tasks.json'),
      description: 'Main tasks database',
      required: true,
    },
    {
      legacy: join(cleoDir, 'todo-log.json'),
      new: join(cleoDir, 'tasks-log.jsonl'),
      description: 'Task activity log',
      required: false,
    },
    {
      legacy: join(cleoDir, 'todo-archive.json'),
      new: join(cleoDir, 'tasks-archive.json'),
      description: 'Archived tasks',
      required: false,
    },
    {
      legacy: join(cleoDir, 'todo-backup.json'),
      new: join(cleoDir, 'tasks-backup.json'),
      description: 'Tasks backup',
      required: false,
    },
  ];
}

/**
 * Compute file checksum for verification
 */
function computeFileChecksum(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Create migration backup directory
 */
function ensureBackupDir(cwd?: string): string {
  const cleoDir = getCleoDirAbsolute(cwd);
  const backupDir = join(cleoDir, 'backups', 'migration-todo-rename');
  
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }
  
  return backupDir;
}

/**
 * Check if migration is needed
 */
export function checkMigrationNeeded(cwd?: string): { needed: boolean; files: FileMapping[] } {
  const mappings = getFileMappings(cwd);
  const neededFiles: FileMapping[] = [];
  
  for (const mapping of mappings) {
    // Migration needed if legacy exists AND new doesn't exist
    if (existsSync(mapping.legacy) && !existsSync(mapping.new)) {
      neededFiles.push(mapping);
    }
  }
  
  return {
    needed: neededFiles.length > 0,
    files: neededFiles,
  };
}

/**
 * Validate a migrated file
 */
async function validateMigratedFile(legacyPath: string, newPath: string): Promise<{ valid: boolean; error?: string }> {
  try {
    // Check new file exists
    if (!existsSync(newPath)) {
      return { valid: false, error: `New file does not exist: ${newPath}` };
    }
    
    // Check file sizes match
    const { statSync } = await import('node:fs');
    const legacyStat = statSync(legacyPath);
    const newStat = statSync(newPath);
    
    if (legacyStat.size !== newStat.size) {
      return { 
        valid: false, 
        error: `Size mismatch: legacy=${legacyStat.size}, new=${newStat.size}` 
      };
    }
    
    // Check checksums match
    const legacyChecksum = computeFileChecksum(legacyPath);
    const newChecksum = computeFileChecksum(newPath);
    
    if (legacyChecksum !== newChecksum) {
      return { 
        valid: false, 
        error: `Checksum mismatch: legacy=${legacyChecksum}, new=${newChecksum}` 
      };
    }
    
    // Try to parse JSON to verify integrity
    try {
      const content = readFileSync(newPath, 'utf-8');
      // Only validate if it looks like JSON (ends with } or ])
      if (content.trim().endsWith('}') || content.trim().endsWith(']')) {
        JSON.parse(content);
      }
    } catch (parseErr) {
      // Some files (like .jsonl) aren't single JSON objects - that's ok
      if (newPath.endsWith('.json')) {
        return { 
          valid: false, 
          error: `JSON parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` 
        };
      }
    }
    
    return { valid: true };
  } catch (err) {
    return { 
      valid: false, 
      error: `Validation error: ${err instanceof Error ? err.message : String(err)}` 
    };
  }
}

/**
 * Run the migration
 */
export async function runMigration(options: {
  dryRun?: boolean;
  cwd?: string;
  keepBackups?: boolean;
} = {}): Promise<MigrationResult> {
  const isDryRun = options.dryRun ?? false;
  const keepBackups = options.keepBackups ?? false;
  
  const result: MigrationResult = {
    success: true,
    migrated: [],
    skipped: [],
    errors: [],
    backups: [],
  };
  
  const check = checkMigrationNeeded(options.cwd);
  
  if (!check.needed) {
    result.skipped.push('No migration needed - all files already using tasks.* naming');
    return result;
  }
  
  const backupDir = ensureBackupDir(options.cwd);
  const timestamp = Date.now();
  
  // Step 1: Create backups of all legacy files
  console.log('Step 1: Creating backups...');
  for (const mapping of check.files) {
    try {
      const backupPath = join(backupDir, `${timestamp}-${mapping.description.replace(/\s+/g, '-').toLowerCase()}.backup`);
      
      if (!isDryRun) {
        copyFileSync(mapping.legacy, backupPath);
        result.backups.push(backupPath);
      }
      
      console.log(`  ✓ Backup created: ${backupPath}`);
    } catch (err) {
      result.errors.push(`Failed to backup ${mapping.legacy}: ${err instanceof Error ? err.message : String(err)}`);
      result.success = false;
      return result;
    }
  }
  
  // Step 2: Migrate files
  console.log('\nStep 2: Migrating files...');
  for (const mapping of check.files) {
    try {
      if (isDryRun) {
        console.log(`  [DRY RUN] Would migrate: ${mapping.legacy} → ${mapping.new}`);
        result.migrated.push(mapping.description);
        continue;
      }
      
      // Ensure parent directory exists
      const newDir = dirname(mapping.new);
      if (!existsSync(newDir)) {
        mkdirSync(newDir, { recursive: true });
      }
      
      // Rename legacy to new
      renameSync(mapping.legacy, mapping.new);
      console.log(`  ✓ Migrated: ${mapping.legacy} → ${mapping.new}`);
      result.migrated.push(mapping.description);
      
    } catch (err) {
      const error = `Failed to migrate ${mapping.legacy}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(error);
      console.error(`  ✗ ${error}`);
      result.success = false;
      
      // Attempt rollback
      await rollbackMigration(result.backups, check.files);
      return result;
    }
  }
  
  // Step 3: Validate migrated files
  console.log('\nStep 3: Validating migrated files...');
  for (const mapping of check.files) {
    if (isDryRun) continue;
    
    const backupFile = result.backups.find(b => b.includes(mapping.description.replace(/\s+/g, '-').toLowerCase()));
    if (!backupFile) {
      console.warn(`  ⚠ Could not find backup for ${mapping.description}`);
      continue;
    }
    
    const validation = await validateMigratedFile(backupFile, mapping.new);
    
    if (!validation.valid) {
      const error = `Validation failed for ${mapping.new}: ${validation.error}`;
      result.errors.push(error);
      console.error(`  ✗ ${error}`);
      result.success = false;
      
      // Attempt rollback
      await rollbackMigration(result.backups, check.files);
      return result;
    }
    
    console.log(`  ✓ Validated: ${mapping.new}`);
  }
  
  // Step 4: Cleanup legacy files (unless keepBackups)
  if (!keepBackups && !isDryRun) {
    console.log('\nStep 4: Cleaning up legacy files...');
    // Legacy files are already renamed, so they're gone
    // Backups remain in backupDir
    console.log(`  ✓ Legacy files migrated (backups kept in ${backupDir})`);
  }
  
  // Step 5: Update any config references (if needed)
  console.log('\nStep 5: Updating configuration...');
  const cleoDir = getCleoDirAbsolute(options.cwd);
  const configPath = join(cleoDir, 'config.json');
  
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      let updated = false;
      
      // Update any hardcoded paths in config
      if (config.storage?.dataFile === 'todo.json') {
        config.storage.dataFile = 'tasks.json';
        updated = true;
      }
      
      if (updated && !isDryRun) {
        writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('  ✓ Updated config.json references');
      } else if (updated && isDryRun) {
        console.log('  [DRY RUN] Would update config.json references');
      } else {
        console.log('  ✓ No config updates needed');
      }
    } catch (err) {
      console.warn(`  ⚠ Could not update config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  return result;
}

/**
 * Rollback migration on failure
 */
async function rollbackMigration(
  backups: string[], 
  mappings: FileMapping[]
): Promise<void> {
  console.error('\n⚠ ROLLBACK INITIATED - Restoring from backups...');
  
  for (const mapping of mappings) {
    try {
      // Find matching backup
      const backupFile = backups.find(b => 
        b.includes(mapping.description.replace(/\s+/g, '-').toLowerCase())
      );
      
      if (backupFile && existsSync(backupFile)) {
        // If new file exists, remove it
        if (existsSync(mapping.new)) {
          unlinkSync(mapping.new);
        }
        
        // Restore from backup
        copyFileSync(backupFile, mapping.legacy);
        console.error(`  ✓ Restored: ${mapping.legacy}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to restore ${mapping.legacy}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  console.error('\n⚠ ROLLBACK COMPLETE - Your data has been restored to the original state.');
  console.error('Please check the error messages above and try again.');
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const keepBackups = args.includes('--keep-backups');
  const help = args.includes('--help') || args.includes('-h');
  
  if (help) {
    console.log(`
CLEO Migration Tool: todo.* → tasks.*

Usage: node migrate-todo-to-tasks.js [options]

Options:
  --dry-run        Preview migration without making changes
  --keep-backups   Keep backup files after successful migration
  --help, -h       Show this help message

Description:
  Safely migrates legacy CLEO files from todo.* naming to tasks.* naming.
  This is a one-way migration with automatic rollback on failure.

Files migrated:
  - todo.json → tasks.json (main database)
  - todo-log.json → tasks-log.jsonl (activity log)
  - todo-archive.json → tasks-archive.json (archived tasks)
  - todo-backup.json → tasks-backup.json (backups)

Safety features:
  - Full backup before any changes
  - Checksum verification after migration
  - Automatic rollback on any error
  - JSON integrity validation
`);
    process.exit(0);
  }
  
  console.log('CLEO Migration: todo.* → tasks.*\n');
  
  const check = checkMigrationNeeded();
  
  if (!check.needed) {
    console.log('✓ No migration needed - all files already using tasks.* naming');
    process.exit(0);
  }
  
  console.log(`Found ${check.files.length} file(s) to migrate:\n`);
  for (const mapping of check.files) {
    console.log(`  • ${mapping.description}`);
    console.log(`    ${mapping.legacy}`);
    console.log(`    → ${mapping.new}\n`);
  }
  
  if (dryRun) {
    console.log('Running in DRY-RUN mode (no changes will be made)\n');
  }
  
  const result = await runMigration({ dryRun, keepBackups });
  
  console.log('\n' + '='.repeat(50));
  console.log('MIGRATION RESULTS');
  console.log('='.repeat(50));
  
  if (result.success) {
    console.log('\n✓ Migration completed successfully!\n');
    
    if (result.migrated.length > 0) {
      console.log('Migrated files:');
      for (const item of result.migrated) {
        console.log(`  ✓ ${item}`);
      }
    }
    
    if (result.backups.length > 0 && !dryRun) {
      console.log(`\nBackups created: ${result.backups.length}`);
      console.log(`Location: ${dirname(result.backups[0])}`);
      
      if (!keepBackups) {
        console.log('\nTo remove backups after verifying everything works:');
        console.log(`  rm -rf ${dirname(result.backups[0])}`);
      }
    }
    
    process.exit(0);
  } else {
    console.error('\n✗ Migration failed!\n');
    
    if (result.errors.length > 0) {
      console.error('Errors:');
      for (const error of result.errors) {
        console.error(`  ✗ ${error}`);
      }
    }
    
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
