import { err, ok, type Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { type Queryable, readyPool } from "@/modules/postgres/postgres-client";
import { createResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import { createSaleorTransactionFlow } from "@/modules/saleor/saleor-transaction-flow";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import { type PaymentMethod } from "@/modules/stripe/payment-methods/types";
import {
  createStripePaymentIntentId,
  type StripePaymentIntentId,
} from "@/modules/stripe/stripe-payment-intent-id";
import { RecordedTransaction } from "@/modules/transactions-recording/domain/recorded-transaction";
import {
  TransactionRecorderError,
  type TransactionRecorderRepo,
  type TransactionRecorderRepoAccess,
} from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

type Row = {
  payment_intent_id: string;
  saleor_transaction_id: string;
  saleor_transaction_flow: string;
  resolved_transaction_flow: string;
  selected_payment_method: string;
  saleor_schema_major: number;
  saleor_schema_minor: number;
};

/**
 * TransactionRecorderRepo on Postgres (rovershop-storefront#173) - the same
 * contract as the DynamoDB repo: a PaymentIntent is recorded ONCE. A second
 * write for the same intent (two webhook deliveries racing) is an idempotent
 * success and changes nothing - `ON CONFLICT DO NOTHING` is DynamoDB's
 * `attribute_not_exists` condition. Reading a missing one is an error, not
 * null: the business logic writes before it reads.
 */
export class PostgresTransactionRecorderRepo implements TransactionRecorderRepo {
  private logger = createLogger("PostgresTransactionRecorderRepo");

  private db: () => Promise<Queryable>;

  constructor(params: { db?: () => Promise<Queryable> } = {}) {
    this.db = params.db ?? readyPool;
  }

  async recordTransaction(
    access: TransactionRecorderRepoAccess,
    transaction: RecordedTransaction,
  ): Promise<Result<null, TransactionRecorderError>> {
    try {
      const db = await this.db();
      const [major, minor] = transaction.saleorSchemaVersion;
      const result = await db.query(
        `INSERT INTO rp_recorded_transaction
           (saleor_api_url, app_id, payment_intent_id, saleor_transaction_id, saleor_transaction_flow,
            resolved_transaction_flow, selected_payment_method, saleor_schema_major, saleor_schema_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (saleor_api_url, app_id, payment_intent_id) DO NOTHING`,
        [
          access.saleorApiUrl,
          access.appId,
          transaction.stripePaymentIntentId,
          transaction.saleorTransactionId,
          transaction.saleorTransactionFlow,
          transaction.resolvedTransactionFlow,
          transaction.selectedPaymentMethod,
          major,
          minor,
        ],
      );

      if (result.rowCount === 0) {
        this.logger.info("Transaction already recorded, skipping write (idempotent)", {
          paymentIntentId: transaction.stripePaymentIntentId,
        });
      }

      return ok(null);
    } catch (e) {
      this.logger.debug("Failed to write transaction to Postgres", { error: e });

      return err(
        new TransactionRecorderError.FailedWritingTransactionError(
          "Failed to write transaction to Postgres",
          { cause: e },
        ),
      );
    }
  }

  async getTransactionByStripePaymentIntentId(
    access: TransactionRecorderRepoAccess,
    id: StripePaymentIntentId,
  ): Promise<Result<RecordedTransaction, TransactionRecorderError>> {
    let row: Row | undefined;

    try {
      const db = await this.db();
      const result = await db.query<Row>(
        `SELECT payment_intent_id, saleor_transaction_id, saleor_transaction_flow, resolved_transaction_flow,
                selected_payment_method, saleor_schema_major, saleor_schema_minor
           FROM rp_recorded_transaction
          WHERE saleor_api_url = $1 AND app_id = $2 AND payment_intent_id = $3`,
        [access.saleorApiUrl, access.appId, id],
      );

      row = result.rows[0];
    } catch (e) {
      return err(
        new TransactionRecorderError.FailedFetchingTransactionError(
          "Failed to fetch transaction from Postgres",
          { cause: e },
        ),
      );
    }

    if (!row) {
      return err(
        new TransactionRecorderError.TransactionMissingError("Transaction not found in Database", {
          props: { paymentIntentId: id },
        }),
      );
    }

    return ok(
      new RecordedTransaction({
        resolvedTransactionFlow: createResolvedTransactionFlow(
          row.resolved_transaction_flow as Parameters<typeof createResolvedTransactionFlow>[0],
        ),
        saleorTransactionFlow: createSaleorTransactionFlow(
          row.saleor_transaction_flow as Parameters<typeof createSaleorTransactionFlow>[0],
        ),
        saleorTransactionId: createSaleorTransactionId(row.saleor_transaction_id),
        stripePaymentIntentId: createStripePaymentIntentId(row.payment_intent_id),
        selectedPaymentMethod: row.selected_payment_method as PaymentMethod["type"],
        saleorSchemaVersion: [row.saleor_schema_major, row.saleor_schema_minor],
      }),
    );
  }
}
