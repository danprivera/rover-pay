import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

import { mockEncryptor } from "@/__tests__/mocks/mock-encryptor";
import { mockedStripeConfig } from "@/__tests__/mocks/mock-stripe-config";
import { getMockedRecordedTransaction } from "@/__tests__/mocks/mocked-recorded-transaction";
import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { StripeConfig } from "@/modules/app-config/domain/stripe-config";
import { PostgresAppConfigRepo } from "@/modules/app-config/repositories/postgres/postgres-app-config-repo";
import { PostgresAPL } from "@/modules/postgres/postgres-apl";
import { ensureSchema, type Queryable } from "@/modules/postgres/postgres-client";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { PostgresTransactionRecorderRepo } from "@/modules/transactions-recording/repositories/postgres/postgres-transaction-recorder-repo";
import { TransactionRecorderError } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

/**
 * Rover Pay's Postgres storage (rovershop-storefront#173) must keep every
 * promise the DynamoDB storage makes - the app's use cases are written
 * against those: secrets encrypted at rest, a channel mapped to null is
 * unmapped, a PaymentIntent is recorded once, and one installation (Saleor
 * URL + app id) never sees another's rows. Run against pg-mem, a Postgres
 * in memory, through the same SQL the app sends.
 */

let db: Queryable;
const provider = async () => db;
const ACCESS = { saleorApiUrl: mockedSaleorApiUrl, appId: "app-1" };
const OTHER_APP = { saleorApiUrl: mockedSaleorApiUrl, appId: "app-2" };

beforeEach(async () => {
  /*
   * noAstCoverageCheck: pg-mem otherwise refuses a re-run of CREATE TABLE IF NOT EXISTS (it skips the
   * column list when the table exists), which real Postgres accepts - the case "every boot" tests.
   */
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();

  db = new Pool() as unknown as Queryable;
  await ensureSchema(db);
});

describe("ensureSchema", () => {
  it("is safe to run on every boot", async () => {
    await ensureSchema(db);
    await ensureSchema(db);

    // Every table exists (and a re-run neither failed nor duplicated them).
    for (const table of ["rp_apl", "rp_channel_config_mapping", "rp_recorded_transaction", "rp_stripe_config"]) {
      const count = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);

      expect(Number(count.rows[0].n)).toBe(0);
    }
  });
});

describe("PostgresAppConfigRepo", () => {
  const repo = () => new PostgresAppConfigRepo({ db: provider, encryptor: mockEncryptor });

  it("saves a config and reads it back by id and by its channel", async () => {
    expect((await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS })).isOk()).toBe(true);
    expect((await repo().updateMapping(ACCESS, { configId: mockedStripeConfig.id, channelId: "ch-1" })).isOk()).toBe(
      true,
    );

    const byId = (await repo().getStripeConfig({ ...ACCESS, configId: mockedStripeConfig.id }))._unsafeUnwrap();
    const byChannel = (await repo().getStripeConfig({ ...ACCESS, channelId: "ch-1" }))._unsafeUnwrap();

    expect(byId).toStrictEqual(mockedStripeConfig);
    expect(byChannel).toStrictEqual(mockedStripeConfig);
  });

  it("stores the restricted key and webhook secret ENCRYPTED, never in clear", async () => {
    await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS });
    const raw = await db.query<{ restricted_key_enc: string; webhook_secret_enc: string }>(
      "SELECT restricted_key_enc, webhook_secret_enc FROM rp_stripe_config",
    );

    expect(raw.rows[0].restricted_key_enc).not.toContain(mockedStripeRestrictedKey);
    expect(raw.rows[0].webhook_secret_enc).not.toContain(mockedStripeConfig.webhookSecret);
  });

  it("builds the root config: every config, and only the channels mapped to one", async () => {
    await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS });
    await repo().updateMapping(ACCESS, { configId: mockedStripeConfig.id, channelId: "ch-1" });
    await repo().updateMapping(ACCESS, { configId: null, channelId: "ch-2" });

    const root = (await repo().getRootConfig(ACCESS))._unsafeUnwrap();

    expect(root.chanelConfigMapping).toStrictEqual({ "ch-1": mockedStripeConfig.id });
    expect(Object.keys(root.stripeConfigsById)).toStrictEqual([mockedStripeConfig.id]);
  });

  it("unmaps a channel mapped to null - it then has no config", async () => {
    await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS });
    await repo().updateMapping(ACCESS, { configId: mockedStripeConfig.id, channelId: "ch-1" });
    await repo().updateMapping(ACCESS, { configId: null, channelId: "ch-1" });

    expect((await repo().getStripeConfig({ ...ACCESS, channelId: "ch-1" }))._unsafeUnwrap()).toBeNull();
  });

  it("replaces a config saved again under the same id", async () => {
    await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS });
    const renamed = StripeConfig.create({
      id: mockedStripeConfig.id,
      name: "renamed",
      publishableKey: mockedStripeConfig.publishableKey,
      restrictedKey: mockedStripeConfig.restrictedKey,
      webhookSecret: mockedStripeConfig.webhookSecret,
      webhookId: "wh_new",
    })._unsafeUnwrap();

    await repo().saveStripeConfig({ config: renamed, ...ACCESS });
    const found = (await repo().getStripeConfig({ ...ACCESS, configId: renamed.id }))._unsafeUnwrap();

    expect(found?.name).toBe("renamed");
    expect(found?.webhookId).toBe("wh_new");
  });

  it("removes a config", async () => {
    await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS });
    await repo().removeConfig(ACCESS, { configId: mockedStripeConfig.id });

    expect((await repo().getStripeConfig({ ...ACCESS, configId: mockedStripeConfig.id }))._unsafeUnwrap()).toBeNull();
  });

  it("never shows one installation another's configs or mappings", async () => {
    await repo().saveStripeConfig({ config: mockedStripeConfig, ...ACCESS });
    await repo().updateMapping(ACCESS, { configId: mockedStripeConfig.id, channelId: "ch-1" });

    expect((await repo().getStripeConfig({ ...OTHER_APP, configId: mockedStripeConfig.id }))._unsafeUnwrap()).toBeNull();
    expect((await repo().getStripeConfig({ ...OTHER_APP, channelId: "ch-1" }))._unsafeUnwrap()).toBeNull();
    const root = (await repo().getRootConfig(OTHER_APP))._unsafeUnwrap();

    expect(root.chanelConfigMapping).toStrictEqual({});
    expect(root.stripeConfigsById).toStrictEqual({});
  });

  it("returns an error - not a throw - when the database fails", async () => {
    const broken = new PostgresAppConfigRepo({
      db: async () => {
        throw new Error("connection refused");
      },
      encryptor: mockEncryptor,
    });

    expect((await broken.getRootConfig(ACCESS)).isErr()).toBe(true);
    expect((await broken.getStripeConfig({ ...ACCESS, configId: "x" })).isErr()).toBe(true);
    expect((await broken.saveStripeConfig({ config: mockedStripeConfig, ...ACCESS })).isErr()).toBe(true);
    expect((await broken.updateMapping(ACCESS, { configId: "x", channelId: "c" })).isErr()).toBe(true);
    expect((await broken.removeConfig(ACCESS, { configId: "x" })).isErr()).toBe(true);
  });
});

describe("PostgresTransactionRecorderRepo", () => {
  const repo = () => new PostgresTransactionRecorderRepo({ db: provider });

  it("records a transaction and reads it back", async () => {
    const tx = getMockedRecordedTransaction();

    expect((await repo().recordTransaction(ACCESS, tx)).isOk()).toBe(true);
    const found = (await repo().getTransactionByStripePaymentIntentId(ACCESS, tx.stripePaymentIntentId))._unsafeUnwrap();

    expect(found).toStrictEqual(tx);
  });

  it("records a PaymentIntent ONCE: a second write succeeds and changes nothing", async () => {
    const first = getMockedRecordedTransaction();
    const second = getMockedRecordedTransaction({ saleorTransactionId: createSaleorTransactionId("other-tx") });

    await repo().recordTransaction(ACCESS, first);
    expect((await repo().recordTransaction(ACCESS, second)).isOk()).toBe(true);
    const found = (await repo().getTransactionByStripePaymentIntentId(ACCESS, first.stripePaymentIntentId))._unsafeUnwrap();

    expect(found.saleorTransactionId).toBe(first.saleorTransactionId);
  });

  it("answers a missing transaction with TransactionMissingError, not null", async () => {
    const result = await repo().getTransactionByStripePaymentIntentId(ACCESS, createStripePaymentIntentId("pi_missing"));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(TransactionRecorderError.TransactionMissingError);
  });

  it("never shows one installation another's transactions", async () => {
    const tx = getMockedRecordedTransaction();

    await repo().recordTransaction(ACCESS, tx);
    const result = await repo().getTransactionByStripePaymentIntentId(OTHER_APP, tx.stripePaymentIntentId);

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(TransactionRecorderError.TransactionMissingError);
  });

  it("returns a write/read error - not a throw - when the database fails", async () => {
    const broken = new PostgresTransactionRecorderRepo({
      db: async () => {
        throw new Error("connection refused");
      },
    });
    const tx = getMockedRecordedTransaction();

    expect((await broken.recordTransaction(ACCESS, tx))._unsafeUnwrapErr()).toBeInstanceOf(
      TransactionRecorderError.FailedWritingTransactionError,
    );
    expect((await broken.getTransactionByStripePaymentIntentId(ACCESS, tx.stripePaymentIntentId))._unsafeUnwrapErr()).toBeInstanceOf(
      TransactionRecorderError.FailedFetchingTransactionError,
    );
  });
});

describe("PostgresAPL", () => {
  const apl = () => new PostgresAPL({ db: provider, encryptor: mockEncryptor });
  const AUTH = { saleorApiUrl: "https://api.rovershop.io/graphql/", appId: "app-1", token: "saleor-app-token", jwks: "{}" };

  it("stores, reads, lists and deletes the app's auth data", async () => {
    await apl().set(AUTH);

    expect(await apl().get(AUTH.saleorApiUrl)).toStrictEqual(AUTH);
    expect(await apl().getAll()).toStrictEqual([AUTH]);
    await apl().delete(AUTH.saleorApiUrl);
    expect(await apl().get(AUTH.saleorApiUrl)).toBeUndefined();
  });

  it("stores the Saleor token ENCRYPTED, never in clear", async () => {
    await apl().set(AUTH);
    const raw = await db.query<{ token_enc: string }>("SELECT token_enc FROM rp_apl");

    expect(raw.rows[0].token_enc).not.toContain(AUTH.token);
  });

  it("replaces the token on reinstall", async () => {
    await apl().set(AUTH);
    await apl().set({ ...AUTH, appId: "app-2", token: "new-token" });

    expect(await apl().get(AUTH.saleorApiUrl)).toStrictEqual({ ...AUTH, appId: "app-2", token: "new-token" });
  });

  it("reports ready only when the database answers", async () => {
    expect(await apl().isReady()).toStrictEqual({ ready: true });
    const broken = new PostgresAPL({
      db: async () => {
        throw new Error("down");
      },
      encryptor: mockEncryptor,
    });

    expect((await broken.isReady()).ready).toBe(false);
    expect((await broken.isConfigured()).configured).toBe(false);

    // A pool handed back fine, but the database behind it not answering.
    const unanswered = new PostgresAPL({
      db: async () => ({
        query: async () => {
          throw new Error("timeout");
        },
      }) as unknown as Queryable,
      encryptor: mockEncryptor,
    });

    expect((await unanswered.isReady()).ready).toBe(false);
  });
});
