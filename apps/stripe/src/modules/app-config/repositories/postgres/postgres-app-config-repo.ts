import { type IEncryptor } from "@saleor/apps-shared/encryptor";
import { RotatingEncryptor } from "@saleor/apps-shared/key-rotation/rotating-encryptor";
import {
  resolveDecryptFallbacks,
  resolveEncryptKey,
} from "@saleor/apps-shared/secret-key-resolution";
import { err, ok, type Result } from "neverthrow";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { AppRootConfig } from "@/modules/app-config/domain/app-root-config";
import { StripeConfig } from "@/modules/app-config/domain/stripe-config";
import {
  type AppConfigRepo,
  AppConfigRepoError,
  type BaseAccessPattern,
  type GetStripeConfigAccessPattern,
} from "@/modules/app-config/repositories/app-config-repo";
import { type Queryable, readyPool } from "@/modules/postgres/postgres-client";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { createStripePublishableKey } from "@/modules/stripe/stripe-publishable-key";
import { createStripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";
import { createStripeWebhookSecret } from "@/modules/stripe/stripe-webhook-secret";

type ConfigRow = {
  config_id: string;
  config_name: string;
  publishable_key: string;
  restricted_key_enc: string;
  webhook_id: string;
  webhook_secret_enc: string;
};

/**
 * AppConfigRepo on Postgres (rovershop-storefront#173) - the same contract as
 * DynamodbAppConfigRepo: the restricted key and webhook secret are encrypted
 * at rest with the app's rotating encryptor, and a channel mapped to `null`
 * is unmapped. Rows are scoped by (saleor_api_url, app_id), so a reinstall -
 * a new app id - starts clean, as the DynamoDB partition key makes it.
 */
export class PostgresAppConfigRepo implements AppConfigRepo {
  private logger = createLogger("PostgresAppConfigRepo");

  private db: () => Promise<Queryable>;
  private encryptor: IEncryptor;

  constructor(
    params: { db?: () => Promise<Queryable>; encryptor?: IEncryptor } = {},
  ) {
    this.db = params.db ?? readyPool;
    this.encryptor =
      params.encryptor ??
      new RotatingEncryptor({
        primarySecret: resolveEncryptKey(env),
        fallbackSecrets: resolveDecryptFallbacks(env),
        logger: createLogger("RotatingEncryptor"),
      });
  }

  private toConfigOrThrow(row: ConfigRow): StripeConfig {
    const result = StripeConfig.create({
      id: row.config_id,
      name: row.config_name,
      publishableKey: createStripePublishableKey(row.publishable_key)._unsafeUnwrap(),
      restrictedKey: createStripeRestrictedKey(
        this.encryptor.decrypt(row.restricted_key_enc),
      )._unsafeUnwrap(),
      webhookId: row.webhook_id,
      webhookSecret: createStripeWebhookSecret(
        this.encryptor.decrypt(row.webhook_secret_enc),
      )._unsafeUnwrap(),
    });

    if (result.isErr()) {
      throw new BaseError("Failed to parse config from Postgres", { cause: result.error });
    }

    return result.value;
  }

  async getRootConfig(
    access: BaseAccessPattern,
  ): Promise<Result<AppRootConfig, InstanceType<typeof AppConfigRepoError.FailureFetchingConfig>>> {
    try {
      const db = await this.db();
      const [configs, mappings] = await Promise.all([
        db.query<ConfigRow>(
          `SELECT config_id, config_name, publishable_key, restricted_key_enc, webhook_id, webhook_secret_enc
             FROM rp_stripe_config WHERE saleor_api_url = $1 AND app_id = $2`,
          [access.saleorApiUrl, access.appId],
        ),
        db.query<{ channel_id: string; config_id: string | null }>(
          `SELECT channel_id, config_id FROM rp_channel_config_mapping
            WHERE saleor_api_url = $1 AND app_id = $2`,
          [access.saleorApiUrl, access.appId],
        ),
      ]);

      const mapping: Record<string, string> = {};

      for (const row of mappings.rows) {
        if (row.config_id) mapping[row.channel_id] = row.config_id;
      }

      const byId: Record<string, StripeConfig> = {};

      for (const row of configs.rows) {
        byId[row.config_id] = this.toConfigOrThrow(row);
      }

      return ok(new AppRootConfig(mapping, byId));
    } catch (e) {
      this.logger.error("Failed to fetch RootConfig from Postgres", { cause: e });

      return err(
        new AppConfigRepoError.FailureFetchingConfig("Error fetching RootConfig from Postgres", {
          cause: e,
        }),
      );
    }
  }

  async getStripeConfig(
    access: GetStripeConfigAccessPattern,
  ): Promise<
    Result<StripeConfig | null, InstanceType<typeof AppConfigRepoError.FailureFetchingConfig>>
  > {
    try {
      const db = await this.db();
      let configId = "configId" in access ? access.configId : undefined;

      if (!configId && "channelId" in access) {
        const mapped = await db.query<{ config_id: string | null }>(
          `SELECT config_id FROM rp_channel_config_mapping
            WHERE saleor_api_url = $1 AND app_id = $2 AND channel_id = $3`,
          [access.saleorApiUrl, access.appId, access.channelId],
        );

        configId = mapped.rows[0]?.config_id ?? undefined;
      }

      if (!configId) return ok(null);

      const found = await db.query<ConfigRow>(
        `SELECT config_id, config_name, publishable_key, restricted_key_enc, webhook_id, webhook_secret_enc
           FROM rp_stripe_config WHERE saleor_api_url = $1 AND app_id = $2 AND config_id = $3`,
        [access.saleorApiUrl, access.appId, configId],
      );

      return ok(found.rows[0] ? this.toConfigOrThrow(found.rows[0]) : null);
    } catch (e) {
      this.logger.error("Failed to fetch config from Postgres", { cause: e });

      return err(
        new AppConfigRepoError.FailureFetchingConfig("Error fetching specific config from Postgres", {
          cause: e,
        }),
      );
    }
  }

  async saveStripeConfig({
    config,
    saleorApiUrl,
    appId,
  }: {
    config: StripeConfig;
    saleorApiUrl: SaleorApiUrl;
    appId: string;
  }): Promise<Result<null, InstanceType<typeof AppConfigRepoError.FailureSavingConfig>>> {
    try {
      const db = await this.db();

      // An upsert: DynamoDB's PutItem replaces the item, so this does too.
      await db.query(
        `INSERT INTO rp_stripe_config
           (saleor_api_url, app_id, config_id, config_name, publishable_key, restricted_key_enc, webhook_id, webhook_secret_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (saleor_api_url, app_id, config_id) DO UPDATE SET
           config_name = EXCLUDED.config_name,
           publishable_key = EXCLUDED.publishable_key,
           restricted_key_enc = EXCLUDED.restricted_key_enc,
           webhook_id = EXCLUDED.webhook_id,
           webhook_secret_enc = EXCLUDED.webhook_secret_enc`,
        [
          saleorApiUrl,
          appId,
          config.id,
          config.name,
          config.publishableKey,
          this.encryptor.encrypt(config.restrictedKey),
          config.webhookId,
          this.encryptor.encrypt(config.webhookSecret),
        ],
      );
      this.logger.info("Saved config to Postgres", { configId: config.id });

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to save config to Postgres", { cause: e });

      return err(
        new AppConfigRepoError.FailureSavingConfig("Failed to save config to Postgres", { cause: e }),
      );
    }
  }

  async updateMapping(
    access: BaseAccessPattern,
    data: { configId: string | null; channelId: string },
  ): Promise<Result<null, InstanceType<typeof AppConfigRepoError.FailureSavingConfig>>> {
    try {
      const db = await this.db();

      await db.query(
        `INSERT INTO rp_channel_config_mapping (saleor_api_url, app_id, channel_id, config_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (saleor_api_url, app_id, channel_id) DO UPDATE SET config_id = EXCLUDED.config_id`,
        [access.saleorApiUrl, access.appId, data.channelId, data.configId],
      );
      this.logger.info("Updated mapping in Postgres", {
        configId: data.configId,
        channelId: data.channelId,
      });

      return ok(null);
    } catch (e) {
      this.logger.error("Failed to update mapping in Postgres", { error: e });

      return err(
        new AppConfigRepoError.FailureSavingConfig("Failed to update mapping in Postgres", {
          cause: e,
        }),
      );
    }
  }

  async removeConfig(
    access: BaseAccessPattern,
    data: { configId: string },
  ): Promise<Result<null, InstanceType<typeof AppConfigRepoError.FailureRemovingConfig>>> {
    try {
      const db = await this.db();

      await db.query(
        `DELETE FROM rp_stripe_config WHERE saleor_api_url = $1 AND app_id = $2 AND config_id = $3`,
        [access.saleorApiUrl, access.appId, data.configId],
      );

      return ok(null);
    } catch (e) {
      return err(
        new AppConfigRepoError.FailureRemovingConfig("Failed to remove config from Postgres", {
          cause: e,
        }),
      );
    }
  }
}
