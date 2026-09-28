/* eslint-disable n/no-process-env -- this test IS about env: it toggles STORAGE/APL and restores them */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * STORAGE picks the implementations the app actually uses (rovershop-storefront#173):
 * the Postgres repos are only real if the wiring hands them to the use cases.
 */

/*
 * Only these two are touched: unstubbing everything would also drop the
 * suite's own env (SECRET_KEY...), and env validation would then exit.
 */
const saved = { STORAGE: process.env.STORAGE, APL: process.env.APL };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

async function load(storage: string | undefined) {
  vi.resetModules();
  if (storage) process.env.STORAGE = storage;
  else delete process.env.STORAGE;
  const [{ appConfigRepoImpl }, { transactionRecorder }] = await Promise.all([
    import("@/modules/app-config/repositories/app-config-repo-impl"),
    import("@/modules/transactions-recording/repositories/transaction-recorder-impl"),
  ]);

  return { appConfigRepoImpl, transactionRecorder };
}

describe("storage selection", () => {
  it("uses Postgres for configs AND transactions when STORAGE=postgres", async () => {
    const { appConfigRepoImpl, transactionRecorder } = await load("postgres");

    expect(appConfigRepoImpl.constructor.name).toBe("PostgresAppConfigRepo");
    expect(transactionRecorder.constructor.name).toBe("PostgresTransactionRecorderRepo");
  });

  it("keeps upstream's DynamoDB by default", async () => {
    const { appConfigRepoImpl, transactionRecorder } = await load(undefined);

    expect(appConfigRepoImpl.constructor.name).toBe("DynamodbAppConfigRepo");
    expect(transactionRecorder.constructor.name).toBe("DynamoDBTransactionRecorderRepo");
  });

  it("uses the Postgres APL when APL=postgres", async () => {
    vi.resetModules();
    process.env.APL = "postgres";
    const { apl } = await import("@/lib/saleor-app");

    expect(apl.constructor.name).toBe("PostgresAPL");
  });
});
