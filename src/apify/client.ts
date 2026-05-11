/**
 * Thin wrapper around the Apify client SDK.
 *
 * Responsibilities:
 *   - Load APIFY_TOKEN from env (.env or process.env)
 *   - Provide a single shared ApifyClient instance
 *   - Track estimated cost per actor call and warn when approaching budget
 *   - Maintain a simple monthly spend log in data/.apify-usage.json
 *
 * Cost tracking is BEST-EFFORT — we estimate based on the actor's known
 * pricing structure, not actual Apify billing. Real billing may differ.
 * The point is to avoid surprise charges, not to be exact.
 */

import 'dotenv/config';
import { ApifyClient } from 'apify-client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('apify');

const USAGE_FILE = resolve(process.cwd(), 'data/.apify-usage.json');

interface UsageEntry {
  month: string; // YYYY-MM
  actor: string;
  itemCount: number;
  estimatedCostUsd: number;
  runAt: string;
}

interface UsageLog {
  entries: UsageEntry[];
}

function loadUsage(): UsageLog {
  try {
    return JSON.parse(readFileSync(USAGE_FILE, 'utf-8')) as UsageLog;
  } catch {
    return { entries: [] };
  }
}

function saveUsage(usage: UsageLog): void {
  mkdirSync(dirname(USAGE_FILE), { recursive: true });
  writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf-8');
}

/** Total spend for the current month across all actors. */
export function getCurrentMonthSpendUsd(): number {
  const month = new Date().toISOString().substring(0, 7); // YYYY-MM
  const usage = loadUsage();
  return usage.entries
    .filter((e) => e.month === month)
    .reduce((sum, e) => sum + e.estimatedCostUsd, 0);
}

function recordSpend(actor: string, itemCount: number, estimatedCostUsd: number): void {
  const usage = loadUsage();
  usage.entries.push({
    month: new Date().toISOString().substring(0, 7),
    actor,
    itemCount,
    estimatedCostUsd,
    runAt: new Date().toISOString(),
  });
  saveUsage(usage);
}

export function getMonthlyBudgetUsd(): number {
  const raw = process.env.APIFY_MONTHLY_BUDGET_USD ?? '5';
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? 5 : parsed;
}

let cachedClient: ApifyClient | null = null;

export function hasApifyToken(): boolean {
  return !!process.env.APIFY_TOKEN && process.env.APIFY_TOKEN.length > 0;
}

export function getApifyClient(): ApifyClient {
  if (cachedClient) return cachedClient;
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error(
      'APIFY_TOKEN not set. Copy .env.example to .env and add your token from https://console.apify.com/account/integrations',
    );
  }
  cachedClient = new ApifyClient({ token });
  return cachedClient;
}

export interface RunActorOptions {
  /** Apify actor name in `username/actor-name` format. */
  actor: string;
  /** Input object to pass to the actor. Schema varies per actor. */
  input: Record<string, unknown>;
  /** Estimated USD cost per dataset item (used for budget tracking). */
  costPerItemUsd: number;
  /** Fixed per-run cost (e.g. compute units). Default 0. */
  fixedCostUsd?: number;
  /**
   * If true, refuses to run when the run *could* exceed monthly budget.
   * Default true for paid actors, false for free actors.
   */
  enforceBudget: boolean;
  /** Maximum number of items expected — used for cost estimation. */
  expectedItems?: number;
  /** Override timeout in seconds. Default 300 (5 minutes). */
  timeoutSecs?: number;
}

export interface RunActorResult<T> {
  items: T[];
  estimatedCostUsd: number;
  runId: string;
  datasetId: string;
  durationMs: number;
}

/**
 * Run an Apify actor and fetch its dataset items.
 *
 * Cost flow:
 *   1. Before starting, estimate max possible cost = expectedItems * costPerItem + fixedCost
 *   2. If enforceBudget && (currentSpend + maxCost > budget), throw BudgetExceededError
 *   3. Run actor, wait for completion
 *   4. After fetching dataset, calculate ACTUAL cost = items.length * costPerItem + fixedCost
 *   5. Record actual cost to usage log
 */
export class BudgetExceededError extends Error {
  constructor(
    public currentSpendUsd: number,
    public maxPossibleCostUsd: number,
    public budgetUsd: number,
  ) {
    super(
      `Apify monthly budget would be exceeded. ` +
        `Current: $${currentSpendUsd.toFixed(4)} / Budget: $${budgetUsd}. ` +
        `Max possible additional cost: $${maxPossibleCostUsd.toFixed(4)}. ` +
        `Raise APIFY_MONTHLY_BUDGET_USD in .env or wait until next month.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export async function runApifyActor<T>(opts: RunActorOptions): Promise<RunActorResult<T>> {
  const fixedCost = opts.fixedCostUsd ?? 0;
  const expectedMax = (opts.expectedItems ?? 100) * opts.costPerItemUsd + fixedCost;
  const currentSpend = getCurrentMonthSpendUsd();
  const budget = getMonthlyBudgetUsd();

  log.info('apify run starting', {
    actor: opts.actor,
    costPerItemUsd: opts.costPerItemUsd,
    fixedCostUsd: fixedCost,
    expectedItems: opts.expectedItems,
    estimatedMaxCostUsd: expectedMax.toFixed(4),
    monthSpendSoFar: currentSpend.toFixed(4),
    budgetUsd: budget,
  });

  if (opts.enforceBudget && currentSpend + expectedMax > budget) {
    throw new BudgetExceededError(currentSpend, expectedMax, budget);
  }

  const client = getApifyClient();
  const startedAt = Date.now();

  const run = await client.actor(opts.actor).call(opts.input, {
    timeout: opts.timeoutSecs ?? 300,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const durationMs = Date.now() - startedAt;

  const actualCost = items.length * opts.costPerItemUsd + fixedCost;
  recordSpend(opts.actor, items.length, actualCost);

  log.info('apify run complete', {
    actor: opts.actor,
    runId: run.id,
    datasetId: run.defaultDatasetId,
    itemCount: items.length,
    actualCostUsd: actualCost.toFixed(4),
    durationMs,
  });

  return {
    items: items as T[],
    estimatedCostUsd: actualCost,
    runId: run.id,
    datasetId: run.defaultDatasetId,
    durationMs,
  };
}
