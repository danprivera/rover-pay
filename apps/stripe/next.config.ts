import { fileURLToPath } from "node:url";

import { withSentryConfig } from "@sentry/nextjs";
import { type NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * Rover Pay runs in a container on Azure (rovershop-storefront#173), not on
   * Vercel: NEXT_OUTPUT=standalone emits a self-contained server. The tracing
   * root is the monorepo root so the workspace packages are included.
   */
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone" as const, outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)) }
    : {}),
  transpilePackages: [
    "@saleor/apps-logger",
    "@saleor/apps-otel",
    "@saleor/apps-shared",
    "@saleor/apps-trpc",
    "@saleor/apps-ui",
    "@saleor/apps-ui-next",
    "@saleor/react-hook-form-macaw",
  ],
  experimental: {
    optimizePackageImports: ["@sentry/nextjs", "@sentry/node"],
  },
  bundlePagesRouterDependencies: true,
  serverExternalPackages: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/util-dynamodb",
    "dynamodb-toolbox",
    // Rover Pay's Postgres storage: pg loads an optional native binding that must not be bundled.
    "pg",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Ignore opentelemetry warnings - https://github.com/open-telemetry/opentelemetry-js/issues/4173
      config.ignoreWarnings = [{ module: /require-in-the-middle/ }];
    }

    return config;
  },
};

// Make sure to export sentry config as the last one - https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/#apply-instrumentation-to-your-app
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  disableLogger: true,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
});
