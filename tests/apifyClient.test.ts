/**
 * Tests for the Apify wrapper's budget tracking + enforcement.
 * The actual ApifyClient is mocked — we just verify our wrapper logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE_FILE = resolve(process.cwd(), 'data/.apify-usage.json');

describe('apify client budget logic', () => {
  beforeEach(() => {
    try {
      rmSync(USAGE_FILE);
    } catch {
      // ignore
    }
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_MONTHLY_BUDGET_USD;
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(USAGE_FILE);
    } catch {
      // ignore
    }
  });

  it('hasApifyToken returns false when env var missing', async () => {
    const { hasApifyToken } = await import('../src/apify/client.js');
    expect(hasApifyToken()).toBe(false);
  });

  it('hasApifyToken returns true when env var set', async () => {
    process.env.APIFY_TOKEN = 'test-token-123';
    vi.resetModules();
    const { hasApifyToken } = await import('../src/apify/client.js');
    expect(hasApifyToken()).toBe(true);
  });

  it('getCurrentMonthSpendUsd returns 0 with no usage file', async () => {
    const { getCurrentMonthSpendUsd } = await import('../src/apify/client.js');
    expect(getCurrentMonthSpendUsd()).toBe(0);
  });

  it('getMonthlyBudgetUsd uses env var when set', async () => {
    process.env.APIFY_MONTHLY_BUDGET_USD = '10';
    vi.resetModules();
    const { getMonthlyBudgetUsd } = await import('../src/apify/client.js');
    expect(getMonthlyBudgetUsd()).toBe(10);
  });

  it('getMonthlyBudgetUsd defaults to 5', async () => {
    const { getMonthlyBudgetUsd } = await import('../src/apify/client.js');
    expect(getMonthlyBudgetUsd()).toBe(5);
  });

  it('BudgetExceededError carries the right fields', async () => {
    const { BudgetExceededError } = await import('../src/apify/client.js');
    const err = new BudgetExceededError(4.5, 1.0, 5.0);
    expect(err.currentSpendUsd).toBe(4.5);
    expect(err.maxPossibleCostUsd).toBe(1.0);
    expect(err.budgetUsd).toBe(5.0);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.message).toContain('5');
  });
});
