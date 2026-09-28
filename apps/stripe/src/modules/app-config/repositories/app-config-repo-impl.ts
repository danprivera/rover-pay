import { env } from "@/lib/env";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { DynamodbAppConfigRepo } from "@/modules/app-config/repositories/dynamodb/dynamodb-app-config-repo";
import { PostgresAppConfigRepo } from "@/modules/app-config/repositories/postgres/postgres-app-config-repo";

/*
 * Replace this implementation with custom DB (Redis, Metadata etc) to drop DynamoDB and bring something else
 *
 * Rover Pay: STORAGE=postgres selects Postgres (rovershop-storefront#173);
 * upstream's DynamoDB stays the default so upstream merges stay clean.
 */
export const appConfigRepoImpl: AppConfigRepo =
  env.STORAGE === "postgres" ? new PostgresAppConfigRepo() : new DynamodbAppConfigRepo();
