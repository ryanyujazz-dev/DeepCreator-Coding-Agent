FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/auth/package.json services/auth/package.json
RUN npm ci

COPY tsconfig.base.json tsconfig.auth.json ./
COPY shared/contracts/auth.ts shared/contracts/auth.ts
COPY services/auth/tsconfig.build.json services/auth/tsconfig.build.json
COPY services/auth/src services/auth/src
RUN npm run build:auth

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/auth/package.json services/auth/package.json
RUN npm ci --omit=dev --workspace @deepcreator/auth-service --include-workspace-root=false \
  && npm cache clean --force

COPY --from=build /app/services/auth/dist services/auth/dist
COPY services/auth/migrations services/auth/dist/services/auth/migrations

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "services/auth/dist/services/auth/src/index.js"]
