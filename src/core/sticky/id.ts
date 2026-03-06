/**
 * Sticky Note ID Generation
 *
 * Generates sequential sticky note IDs (SN-001, SN-002...).
 *
 * @task T5280
 * @epic T5267
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';

/**
 * Generate the next sticky note ID.
 *
 * Finds the highest existing SN-XXX ID and increments.
 *
 * @param projectRoot - Project root path
 * @returns Next sticky note ID (e.g., "SN-042")
 */
export async function generateStickyId(projectRoot: string): Promise<string> {
  const accessor = await getBrainAccessor(projectRoot);

  // Get all sticky notes to find the highest ID
  const stickies = await accessor.findStickyNotes({});

  let maxNum = 0;
  for (const sticky of stickies) {
    const match = sticky.id.match(/^SN-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxNum) {
        maxNum = num;
      }
    }
  }

  const nextNum = maxNum + 1;
  return `SN-${nextNum.toString().padStart(3, '0')}`;
}
