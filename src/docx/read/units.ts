/** OOXML unit conversions. 1 in = 1440 twips = 914400 EMU = 72 pt; w:sz is half-points; table border sizes are eighth-points. */

export const twipsToIn = (t: number): number => t / 1440;
export const inToTwips = (i: number): number => Math.round(i * 1440);
export const halfPointsToPt = (hp: number): number => hp / 2;
export const ptToHalfPoints = (pt: number): number => Math.round(pt * 2);
export const emuToIn = (e: number): number => e / 914400;
export const inToEmu = (i: number): number => Math.round(i * 914400);
export const eighthPointsToPt = (ep: number): number => ep / 8;
