import { type APL, type AplConfiguredResult, type AplReadyResult, type AuthData } from "@saleor/app-sdk/APL";
import { type IEncryptor } from "@saleor/apps-shared/encryptor";

import { type Queryable } from "@/modules/postgres/postgres-client";

type Row = { saleor_api_url: string; app_id: string; token_enc: string; jwks: string | null };

/**
 * The app's auth store (APL) on Postgres (rovershop-storefront#173): the
 * token Saleor hands the app at install, per Saleor instance. The token is
 * the app's key to Saleor, so it is encrypted at rest with the same rotating
 * encryptor as the Stripe secrets - the DynamoDB APL stores it in clear.
 */
export class PostgresAPL implements APL {
  private readonly params: { db: () => Promise<Queryable>; encryptor: IEncryptor };

  constructor(params: { db: () => Promise<Queryable>; encryptor: IEncryptor }) {
    this.params = params;
  }

  private toAuthData(row: Row): AuthData {
    return {
      saleorApiUrl: row.saleor_api_url,
      appId: row.app_id,
      token: this.params.encryptor.decrypt(row.token_enc),
      ...(row.jwks ? { jwks: row.jwks } : {}),
    };
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    const db = await this.params.db();
    const result = await db.query<Row>(
      "SELECT saleor_api_url, app_id, token_enc, jwks FROM rp_apl WHERE saleor_api_url = $1",
      [saleorApiUrl],
    );

    return result.rows[0] ? this.toAuthData(result.rows[0]) : undefined;
  }

  async set(authData: AuthData): Promise<void> {
    const db = await this.params.db();

    // A reinstall replaces the previous installation's token for this Saleor.
    await db.query(
      `INSERT INTO rp_apl (saleor_api_url, app_id, token_enc, jwks) VALUES ($1, $2, $3, $4)
       ON CONFLICT (saleor_api_url) DO UPDATE SET
         app_id = EXCLUDED.app_id, token_enc = EXCLUDED.token_enc, jwks = EXCLUDED.jwks`,
      [
        authData.saleorApiUrl,
        authData.appId,
        this.params.encryptor.encrypt(authData.token),
        authData.jwks ?? null,
      ],
    );
  }

  async delete(saleorApiUrl: string): Promise<void> {
    const db = await this.params.db();

    await db.query("DELETE FROM rp_apl WHERE saleor_api_url = $1", [saleorApiUrl]);
  }

  async getAll(): Promise<AuthData[]> {
    const db = await this.params.db();
    const result = await db.query<Row>("SELECT saleor_api_url, app_id, token_enc, jwks FROM rp_apl");

    return result.rows.map((row) => this.toAuthData(row));
  }

  async isReady(): Promise<AplReadyResult> {
    try {
      const db = await this.params.db();

      await db.query("SELECT 1");

      return { ready: true };
    } catch (error) {
      return { ready: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async isConfigured(): Promise<AplConfiguredResult> {
    return this.isReady().then((r) =>
      r.ready ? { configured: true } : { configured: false, error: r.error },
    );
  }
}
