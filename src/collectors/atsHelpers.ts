/**
 * Shared helpers for ATS collectors (Greenhouse, Lever, Ashby, Workable).
 * Mainly: a coarse pre-filter that drops obviously-irrelevant titles before
 * scoring. This saves us from polluting the DB with engineering/sales/etc.
 * roles when scanning hundreds of companies.
 */

const PRODUCT_KEYWORDS = [
  'product manager',
  'product owner',
  'technical product',
  'tpm',
  'group product manager',
  'staff product',
  'principal product',
  'lead product',
  'senior product',
  'sr. product',
  'sr product',
  'gpm',
];

const HARD_EXCLUDE = [
  'product designer',
  'product design',
  'ux',
  'ui ',
  'product marketing',
  'product analyst',
  'data analyst',
  'business analyst',
  'sales',
  'account exec',
  'account manager',
  'recruiter',
  'engineer',
  'developer',
  'software',
  'devops',
  'sre',
];

/**
 * Returns true if the title plausibly matches a Product Manager / Owner role.
 * Conservative — meant to drop obvious mismatches, not to be authoritative.
 * The full scoring engine still runs on whatever passes this filter.
 */
export function isProductRole(title: string): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();

  // Hard exclusions first
  for (const ex of HARD_EXCLUDE) {
    if (lower.includes(ex)) {
      // Edge case: "Product Manager - Engineering Platform" should pass
      // because it has "product manager" before "engineering". So we only
      // reject if the title is *primarily* the excluded role.
      if (lower.startsWith(ex) || (lower.includes(ex) && !lower.includes('product manager') && !lower.includes('product owner'))) {
        return false;
      }
    }
  }

  // Inclusion check
  return PRODUCT_KEYWORDS.some((kw) => lower.includes(kw));
}
