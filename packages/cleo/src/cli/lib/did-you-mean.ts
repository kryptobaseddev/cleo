/**
 * Levenshtein distance-based did-you-mean suggestions for CLI verbs
 *
 * Provides fuzzy matching for unknown commands with configurable
 * distance threshold. Calculates edit distance (insertions, deletions,
 * substitutions) to suggest similar known commands.
 */

/**
 * Calculate the Levenshtein distance between two strings.
 * Distance = minimum number of single-character edits (insert, delete, substitute)
 * needed to change one string into another.
 *
 * @param input - The mistyped command
 * @param candidate - A known command to compare against
 * @returns Edit distance between the two strings
 */
export function levenshteinDistance(input: string, candidate: string): number {
  const inputLen = input.length;
  const candidateLen = candidate.length;

  // Create a 2D array for dynamic programming
  const matrix: number[][] = Array.from({ length: inputLen + 1 }, (_, i) => [i]);

  for (let j = 1; j <= candidateLen; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= inputLen; i++) {
    for (let j = 1; j <= candidateLen; j++) {
      const cost = input[i - 1] === candidate[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // deletion
        matrix[i]![j - 1]! + 1, // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return matrix[inputLen]![candidateLen]!;
}

/**
 * Find did-you-mean suggestions for a mistyped command.
 *
 * Returns candidates with edit distance <= maxDistance, sorted by distance
 * ascending, then alphabetically. If no candidates match, returns empty array.
 *
 * @param input - The mistyped command
 * @param candidates - Array of known command names to suggest from
 * @param maxDistance - Maximum edit distance to consider (default: 2)
 * @returns Array of suggested commands, sorted by relevance
 */
export function didYouMean(input: string, candidates: string[], maxDistance = 2): string[] {
  const suggestions = candidates
    .map((candidate) => ({
      command: candidate,
      distance: levenshteinDistance(input, candidate),
    }))
    .filter((item) => item.distance <= maxDistance)
    .sort((a, b) => {
      // Sort by distance first, then alphabetically
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      return a.command.localeCompare(b.command);
    })
    .map((item) => item.command);

  return suggestions;
}
