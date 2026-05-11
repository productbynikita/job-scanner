/**
 * Unit tests for ATS helpers and collector parsers.
 * We don't hit live APIs in tests — we feed synthetic JSON through the parser
 * paths inside each collector module by importing the helpers directly.
 */

import { describe, it, expect } from 'vitest';
import { isProductRole } from '../src/collectors/atsHelpers.js';

describe('isProductRole', () => {
  it('matches exact PM titles', () => {
    expect(isProductRole('Senior Product Manager')).toBe(true);
    expect(isProductRole('Technical Product Manager')).toBe(true);
    expect(isProductRole('Product Owner')).toBe(true);
    expect(isProductRole('Staff Product Manager')).toBe(true);
    expect(isProductRole('GPM, Platform')).toBe(true);
  });

  it('rejects engineering and design roles', () => {
    expect(isProductRole('Senior Software Engineer')).toBe(false);
    expect(isProductRole('Product Designer')).toBe(false);
    expect(isProductRole('Product Marketing Manager')).toBe(false);
    expect(isProductRole('UX Researcher')).toBe(false);
    expect(isProductRole('Account Executive')).toBe(false);
  });

  it('keeps "Product Manager - Engineering Platform"', () => {
    // edge case: title contains both "engineer" (excluded) and "product manager"
    // — should keep because the role IS a PM role
    expect(isProductRole('Product Manager - Engineering Platform')).toBe(true);
  });

  it('rejects empty/null', () => {
    expect(isProductRole('')).toBe(false);
  });
});
