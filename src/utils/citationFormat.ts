/** Convert a sorted array of numbers to a compressed bracket string, e.g. [1,2,3,5] → "[1-3,5]" */
export function formatCitationGroup(nums: number[]): string {
  const sorted = [...new Set(nums)].filter(n => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts: string[] = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else { parts.push(start === end ? `${start}` : `${start}-${end}`); start = end = sorted[i]; }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return `[${parts.join(',')}]`;
}
