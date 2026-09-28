# Rover Pay (rovershop-storefront#173): Saleor's Stripe app, run as a container
# on Azure Container Apps instead of Vercel. Build from the MONOREPO ROOT:
#   docker build -f apps/stripe/Dockerfile .

FROM node:24-alpine AS base
RUN corepack enable
ENV HUSKY=0

# Only this app and the workspace packages it depends on.
FROM base AS prune
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.5.4 prune saleor-app-payment-stripe --docker

FROM base AS build
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# env.ts validates at build time too. These are BUILD-ONLY placeholders: the
# real values are runtime environment variables, and none of these reach the
# final image.
RUN SECRET_KEY=build-placeholder-not-a-secret STORAGE=postgres APL=postgres \
    pnpm --filter saleor-app-payment-stripe exec next build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/stripe/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/stripe/.next/static ./apps/stripe/.next/static
COPY --from=build --chown=app:app /repo/apps/stripe/public ./apps/stripe/public
USER app
EXPOSE 3000
CMD ["node", "apps/stripe/server.js"]
