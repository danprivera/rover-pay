import { type APL } from "@saleor/app-sdk/APL";
import { DynamoAPL } from "@saleor/app-sdk/APL/dynamodb";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";
import { RotatingEncryptor } from "@saleor/apps-shared/key-rotation/rotating-encryptor";
import {
  resolveDecryptFallbacks,
  resolveEncryptKey,
} from "@saleor/apps-shared/secret-key-resolution";

import { createLogger } from "@/lib/logger";
import { dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";
import { PostgresAPL } from "@/modules/postgres/postgres-apl";
import { readyPool } from "@/modules/postgres/postgres-client";

import { env } from "./env";

const logger = createLogger("saleor-app");

export let apl: APL;
switch (env.APL) {
  case "dynamodb": {
    apl = DynamoAPL.create({
      table: dynamoMainTable,
      externalLogger: (message, level) => {
        if (level === "error") {
          logger.error(`[DynamoAPL] ${message}`);
        } else {
          logger.debug(`[DynamoAPL] ${message}`);
        }
      },
    });

    break;
  }

  // Rover Pay on Azure (rovershop-storefront#173).
  case "postgres": {
    apl = new PostgresAPL({
      db: readyPool,
      encryptor: new RotatingEncryptor({
        primarySecret: resolveEncryptKey(env),
        fallbackSecrets: resolveDecryptFallbacks(env),
        logger: createLogger("RotatingEncryptor"),
      }),
    });

    break;
  }

  default: {
    apl = new FileAPL();
    break;
  }
}

export const saleorApp = new SaleorApp({
  apl,
});
