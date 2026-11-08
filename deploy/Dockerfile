# syntax=docker/dockerfile:1
#
# One Dockerfile, two build targets, one source tree.
#
#   --target lambda    -> the HTTP API + scheduled sweeps, run by AWS Lambda.
#                         Based on the AWS Lambda Node base image, which already
#                         contains the Runtime Interface Client.
#   --target realtime  -> the SAME Express app started as a normal long-lived
#                         server, run as one always-on ECS Fargate task. It
#                         terminates Socket.IO, which Lambda cannot. Based on a
#                         plain Node image so it gets a normal healthcheck and a
#                         normal SIGTERM.
#
# Build context is the Restaurant_Backend directory (NOT deploy/), so the
# existing .dockerignore applies and node_modules / .env / test dirs stay out.
#
#   docker build -f deploy/Dockerfile --target lambda   -t <repo>:lambda   .
#   docker build -f deploy/Dockerfile --target realtime -t <repo>:realtime .
#
# Always build for linux/amd64. The template pins the Lambda function and the
# Fargate task to x86_64, and sharp / @node-rs/argon2 resolve a DIFFERENT native
# binary per platform — an arm64 image built on an Apple Silicon laptop will
# fail at import time on an x86_64 Lambda.

# =============================================================================
# Stage: builder — compile TypeScript once, share the output with both targets
# =============================================================================
# Debian bookworm (glibc) matches the runtime environment of BOTH targets
# closely enough for the native prebuilds, and carries the build toolchain that
# sharp needs if it ever has to compile rather than download a prebuild.
FROM --platform=linux/amd64 node:22-bookworm-slim AS builder
WORKDIR /build

# ---------------------------------------------------------------------------
# WHY THERE IS NO libvips HERE, IN EITHER STAGE
# ---------------------------------------------------------------------------
# sharp is pinned at ^0.35.5, and from 0.33 onwards sharp ships its own libvips
# as ordinary npm packages (@img/sharp-linux-x64 plus its
# @img/sharp-libvips-linux-x64, both recorded in package-lock.json). It has NO
# install script: nothing is downloaded and nothing is compiled at install time,
# and the addon links its own libvips by RPATH. That makes the artifact
# base-image independent — identical bytes work on the Debian realtime target and
# on the Amazon Linux 2023 lambda target.
#
# Base-image independence is the whole point here, because `sharp` is a STATIC
# top-level import (database_supabase.ts:28), reached from lambda.ts -> index.ts.
# A sharp that cannot load its libvips throws during module evaluation, so EVERY
# HTTP invocation 502s before a single route is reachable. /socket.io/*, /print/*
# and /publish/* are served by Fargate, so printing would keep working and the
# outage would look partial rather than total.
#
# DO NOT ADD libvips-dev BACK. Modern sharp ignores a system libvips unless
# SHARP_FORCE_GLOBAL_LIBVIPS is set, so the package would cost build time and
# image size and change nothing. The SHARP_IGNORE_GLOBAL_LIBVIPS=1 that used to
# be set here existed for sharp 0.32's "use the global libvips if you find one"
# install path. That path is gone, so the variable is a no-op — which is why it
# was removed rather than kept "just in case".
#
# sharp is also a plain `dependency` now, not an `optionalDependency`. npm treats
# a failed optional install as success, so the previous declaration meant a sharp
# that did not install produced a GREEN install and then a build that died on
# `Cannot find module 'sharp'` — which is exactly what happened on 2026-11-08.
#
# The toolchain below stays for @node-rs/argon2.

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Package manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
RUN npm ci --include=dev || npm install --include=dev

# Source. .dockerignore keeps node_modules, build/, .env*, test/ and jest-tests/
# out of the context.
COPY . .

# tsc -> build/. tsconfig.build.json includes ./**/*.ts, so the two new
# entrypoints compile alongside the server:
#   build/index.js         the unchanged server
#   build/lambda.js        the Lambda handler
#   build/deploy/server.js the Fargate entrypoint (secrets -> import index.js)
RUN npm run build

# Fail loudly here rather than at the first cold start.
RUN test -f build/index.js         || (echo "build/index.js missing" && exit 1)
RUN test -f build/lambda.js        || (echo "build/lambda.js missing — check tsconfig.build.json include/exclude" && exit 1)
RUN test -f build/deploy/server.js || (echo "build/deploy/server.js missing" && exit 1)

# The OCR model for the web valet plate scan. tesseract.js resolves its model
# cache as `${cachePath || "."}/eng.traineddata` and routes/valet.ts:47 calls
# createWorker("eng") with no cachePath, so "." is the PROCESS WORKING DIRECTORY.
# Without this file in the image, the first scan in every container downloads
# 5.2 MB from the jsdelivr CDN, and the write-back to the read-only /var/task is
# swallowed (worker-script/index.js writeCache try/catch) so the download repeats
# for the life of the container. Staged here so a rename at the repo root fails
# the BUILD rather than quietly restoring the download.
RUN test -f eng.traineddata        || (echo "eng.traineddata missing from the build context" && exit 1)

# Drop devDependencies. Native prebuilds already resolved for linux/amd64.
RUN npm prune --omit=dev


# =============================================================================
# Target: lambda
# =============================================================================
# The AWS-provided base image ships the Node runtime plus the Runtime Interface
# Client, and its ENTRYPOINT reads CMD as "<file path>.<exported symbol>".
#
# Node 22 is pinned deliberately, and paired with the adapter version:
# package.json holds @codegenie/serverless-express at ^4.17.1, and every 4.x
# release declares engines.node ">=18". The 5.x line declares ">=24". If you move
# to a newer Lambda base image you may bump the adapter, but do not bump one
# without the other.
FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22 AS lambda

# LAMBDA_TASK_ROOT is /var/task. package.json MUST be present there: it carries
# "type": "module", which is how the Node runtime knows to load build/lambda.js
# as ESM rather than CommonJS. Without it the handler fails to import.
WORKDIR ${LAMBDA_TASK_ROOT}

COPY --from=builder /build/package.json      ${LAMBDA_TASK_ROOT}/package.json
COPY --from=builder /build/node_modules      ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=builder /build/build             ${LAMBDA_TASK_ROOT}/build

# LAMBDA_TASK_ROOT is also the process working directory, which is where
# tesseract.js looks for its model when cachePath is unset. See the builder-stage
# note above; this is what stops the 5.2 MB per-container CDN download.
COPY --from=builder /build/eng.traineddata   ${LAMBDA_TASK_ROOT}/eng.traineddata

# scripts/ + migrations/ are NOT copied here. Migrations are a deploy-time step
# run by the owner against the OWNER database role (see deploy/README.md); the
# request path must never carry the ability to run DDL.

# Prove, at BUILD time and on the real Amazon Linux 2023 base, that the native
# addon actually loads. This is the check that catches a sharp whose libvips does
# not travel: it fails HERE instead of 502ing every request after the stack is
# paid for. Keep it even though the prebuilt packages make that unlikely — it
# costs one second and it is the only thing that tests the runtime base.
#
# Dynamic import, not `require`: package.json carries "type": "module", and this
# way the check is correct whether `node -e` evaluates as CJS or ESM.
RUN node -e "import('sharp').then((m) => console.log('sharp ok, libvips ' + m.default.versions.vips)).catch((e) => { console.error(e); process.exit(1); })"

ENV NODE_ENV=production
# pino writes one JSON line per request to stdout, which CloudWatch bills by the
# GB. The template sets LOG_LEVEL/REQUEST_LOG as function env vars; these are the
# in-image defaults if someone runs the container by hand.
ENV LOG_LEVEL=info

CMD [ "build/lambda.handler" ]


# =============================================================================
# Target: realtime
# =============================================================================
# The always-on Socket.IO terminator. It is the WHOLE backend, started normally —
# not a cut-down process — so it can also serve the handful of HTTP routes that
# emit to connected sockets (see the CloudFront behaviours in template.yaml).
FROM --platform=linux/amd64 node:22-bookworm-slim AS realtime
WORKDIR /app

# curl, for the container healthcheck below.
#
# No libvips package here either, and that is deliberate: sharp carries its own
# libvips inside @img/sharp-libvips-linux-x64 and resolves it by RPATH, so a
# system libvips would be ignored at runtime while still adding ~50 MB and a
# second copy to patch. The two targets share one sharp artifact instead of
# accidentally shipping a Debian-linked binary to an Amazon Linux runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=builder /build/package.json     ./package.json
COPY --chown=node:node --from=builder /build/node_modules     ./node_modules
COPY --chown=node:node --from=builder /build/build            ./build
# WORKDIR is /app, which is this container's process working directory — the
# same tesseract.js model-cache reasoning as the lambda target.
COPY --chown=node:node --from=builder /build/eng.traineddata  ./eng.traineddata

USER node

# Same load check as the lambda target, run as the unprivileged runtime user so
# it also proves the copied node_modules are readable by it.
RUN node -e "import('sharp').then((m) => console.log('sharp ok, libvips ' + m.default.versions.vips)).catch((e) => { console.error(e); process.exit(1); })"

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# /health returns 503 when the database is unreachable (routes/misc.ts), so the
# ALB target group stops routing to a task that cannot serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-3001}/health" || exit 1

# build/deploy/server.js, NOT build/index.js: it awaits the Secrets Manager fetch
# and THEN imports index.js, because index.ts reads its configuration at module
# load and would otherwise evaluate against an empty environment. With
# APP_SECRET_ARN unset it is a pass-through, so `docker run --env-file .env` on
# this image behaves exactly like the old entrypoint.
#
# node stays PID 1 so ECS's SIGTERM reaches the graceful-shutdown handler
# registered in index.ts bootstrap() (drain HTTP -> close socket.io -> close the
# pg pools).
CMD ["node", "build/deploy/server.js"]
