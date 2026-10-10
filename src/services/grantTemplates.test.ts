import { describe, it, expect } from 'vitest';
import { getGrantTemplate, normalizeTemplate } from './grantTemplates';

describe('grant template project period', () => {
  it('sets projectYears for R01, R21 and R03 only', () => {
    expect(getGrantTemplate('nih-r01')?.projectYears).toBe(5);
    expect(getGrantTemplate('nih-r21')?.projectYears).toBe(2);
    expect(getGrantTemplate('nih-r03')?.projectYears).toBe(2);
    expect(getGrantTemplate('nih-f31')?.projectYears).toBeUndefined();
    expect(getGrantTemplate('custom-grant')?.projectYears).toBeUndefined();
  });

  it('keeps a sane projectYears from a custom template and drops anything else', () => {
    const base = { name: 'T', sections: [{ title: 'Aims' }] };
    expect(normalizeTemplate({ ...base, projectYears: 3 })?.projectYears).toBe(3);
    expect(normalizeTemplate({ ...base, projectYears: '4' })?.projectYears).toBe(4);
    expect(normalizeTemplate({ ...base, projectYears: 0 })?.projectYears).toBeUndefined();
    expect(normalizeTemplate({ ...base, projectYears: 2.5 })?.projectYears).toBeUndefined();
    expect(normalizeTemplate({ ...base, projectYears: 99 })?.projectYears).toBeUndefined();
    expect(normalizeTemplate(base)?.projectYears).toBeUndefined();
  });
});
