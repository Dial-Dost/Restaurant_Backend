# Deploying the CuisineFlow backend to AWS

This directory contains everything needed to run the Restaurant Dash / CuisineFlow
backend on AWS Lambda. It is code and configuration only — nothing here has been
deployed, and no AWS resource has been created. You run the deploy, with your own
credentials, on your own machine.

**Read section 2 before section 4.** Lambda cannot host this application on its
own, and the three things that break are load-bearing: printing, the background
sweeps, and the database connection budget. Section 2 explains what was done
about each and what it costs you.

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture — the three hard problems](#2-architecture--the-three-hard-problems)
3. [Secrets and environment variables](#3-secrets-and-environment-variables)
4. [Deploy](#4-deploy)
5. [Custom domain](#5-custom-domain)
6. [Verify it worked](#6-verify-it-worked)
7. [Rough monthly cost](#7-rough-monthly-cost)
8. [Rollback](#8-rollback)
9. [Migration hazards](#9-migration-hazards)
10. [Changes index.ts needs (not made here)](#10-changes-indexts-needs-not-made-here)
11. [What is not covered, and what is genuinely uncertain](#11-what-is-not-covered-and-what-is-genuinely-uncertain)
12. [Day-2 operations](#12-day-2-operations)

---

## 1. Prerequisites

On your machine:

| Tool | Why | Check |
|---|---|---|
| AWS CLI v2 | credentials, ECR login, verification commands | `aws --version` |
| AWS SAM CLI | deploys `template.yaml` | `sam --version` |
| Docker (Linux containers) | builds both images | `docker version` |
| Node 22 + npm | `npm run build`, `npm run migrate` | `node -v` |

In AWS:

- An account you control, with permission to create IAM roles, Lambda functions,
  ECS services, load balancers, CloudFront distributions and EventBridge
  schedules. The deploy creates IAM roles, so you will pass `CAPABILITY_IAM`.
- A region. Pick the one closest to the restaurants — `ap-south-1` (Mumbai) for
  an India-based customer base. The samconfig defaults to it.
- **Enough Lambda concurrency quota to reserve 23.** The template sets
  `ReservedConcurrentExecutions` on both functions (20 + 3), and AWS refuses any
  reservation that would leave the account with fewer than **100 unreserved**
  concurrent executions. A mature account sits at the default 1,000 and this is
  nothing; some newly created accounts are provisioned far lower, and the deploy
  then fails partway through with *"decreases account's
  UnreservedConcurrentExecutions below its minimum value"* — after CloudFront has
  already started building. Check first, and request an increase if it is tight:
  ```bash
  aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions'
  # need this to be >= 123. If it is 100, request a quota increase for
  # "Concurrent executions" (service code: lambda) before deploying.
  ```

Outside AWS:

- The Supabase project (already exists).
- **A managed Redis with pub/sub, reachable over the public internet.** This is
  not optional and it is not currently provisioned — see
  [2.3](#23-problem-3--database-connections-and-redis).

### Before anything else: confirm the current state

```bash
cd Restaurant_Backend
npx tsc --noEmit     # must exit 0
npx jest             # must be 8 suites / 156 tests, all passing
```

Both were true when these files were written. If they are not true now, fix that
first — a broken build produces a broken image, and the failure surfaces as a
cold-start crash in CloudWatch rather than as a compiler error.

---

## 2. Architecture — the three hard problems

```
                     +---------------------- CloudFront (one domain) -----------+
  Windows app  --->  |  /socket.io/*   -->  ALB  -->  ECS Fargate  (always-on)  |
  Dashboard    --->  |  /print/*       -->  ALB  -->  ECS Fargate  (always-on)  |
  Guest QR     --->  |  /publish/*     -->  ALB  -->  ECS Fargate  (always-on)  |
  Till / web   --->  |  /bills/service-charge-waiver/print --> ALB --> Fargate  |
  Till / web   --->  |  /bills/order/*/settle-nc           --> ALB --> Fargate  |
                     |  everything else -->  HTTP API  -->  Lambda              |
                     +---------------------------------------------------------+
                                          |
      EventBridge Scheduler  -------------+-->  Lambda (sweeps function)
                                          |
                        Supabase (session pooler)  +  managed Redis
```

Two Lambda functions from one image (`build/lambda.handler` dispatches on the
event shape), one always-on Fargate task from a second image built from the same
source, and one CloudFront distribution so all of it lives behind a single
hostname.

### 2.1 Problem 1 — WebSockets

**The problem.** Socket.IO is not a nice-to-have here. The Windows app *is* the
printer agent: `printer_service.dart` opens a socket, joins its outlet room, and
listens for `bill:print`. Every bill and every KOT reaches a thermal printer
through that socket. Classic Lambda behind an HTTP API cannot hold a WebSocket —
there is no process between requests to hold one in.

**What was verified in the source.** `realtime.ts` already supports the fix:

- `realtime.ts:35-47` — when `REDIS_URL` is set, `initRealtime` creates a pub/sub
  client pair and calls `io.adapter(createAdapter(pubClient, subClient))`.
- `realtime.ts:116-135` — `emitRestaurant` / `emitOutlet` are thin wrappers over
  `io.to(room).emit(...)`.

With the Redis adapter attached, `io.to(room).emit(...)` publishes the event to
Redis, and **every** Socket.IO server subscribed to those channels delivers it to
its own connected sockets. That is exactly the property a hybrid needs: a process
that emits does not have to be the process that holds the socket. `/health`
already reports which mode is live (`result.realtime.adapter`, routes/misc.ts:57), so
you can confirm it rather than assume it.

**The architecture.**

- One **ECS Fargate task** runs the whole backend the normal way. It terminates
  `/socket.io/*` and holds every printer agent's connection.
- **Lambda** serves the other ~275 routes. Because `bootstrap()` runs at module
  load, the Lambda containers *also* build a Socket.IO server with the same Redis
  adapter — so an emit from a Lambda-served route still fans out to the Fargate
  task and reaches the printer.

**The honest caveat, and what was done about it.** Lambda freezes a container the
instant the handler's promise settles. `@socket.io/redis-adapter` hands the
`PUBLISH` to node-redis, which queues it. If the container freezes before that
queue flushes, the emit is delayed until the container thaws — or lost if it is
reaped. `lambda.ts` yields once (`setImmediate`) after the HTTP response so
node-redis can flush, but that gets the command out of the client's queue; it does
not confirm Redis received it.

**A second, sharper version of the same freeze problem — and the fix that had to
go into `index.ts`.** `emitRestaurant` and `emitOutlet` both open with
`if (!io) {return;}` (`realtime.ts:117`, `:128`), and `io` is assigned only
inside `initRealtime`. `bootstrap()` reaches `initRealtime` *after* a DB write and
a DB read, and `lambda.ts` deliberately does not await `bootstrap()` — so on
Lambda it advances only while an invocation is running. A cold container that
serves one fast request and then idles can still have **`io === null`**, and the
emit is dropped with no log line, no metric and no error. The user-visible
symptom is a stale KDS or POS screen until a manual refresh, on cold containers
only, which is about the hardest thing there is to reproduce.

So `index.ts` now exposes `ensureRealtime()` — the same `createServer` +
`initRealtime` pair `bootstrap()` used to inline, memoised — and `lambda.ts`
**awaits it before it builds the serverless adapter**, i.e. before the container
can serve anything. `bootstrap()` awaits the same memoised promise at the same
point in its own sequence, so a long-lived process behaves exactly as before and
there is still one Socket.IO server and one pair of Redis clients per process.

The cost is stated plainly: two Redis connections and their TLS handshakes are
now *on* the cold-start path rather than racing it. That is the price of an emit
actually leaving the container. Printing never depended on it — see the table
below.

For most events (`order:updated`, `table:updated`) a rare delay is survivable. For
printing it is not. So the routes that emit `bill:print` are **not served by
Lambda at all**:

| Route | Source | Served by |
|---|---|---|
| `POST /print/bill` (also emits the per-station KOTs) | routes/bills.ts:506 | Fargate |
| `POST /publish/bill` | routes/bills.ts:463 | Fargate |
| `POST /bills/service-charge-waiver/print` (records the waiver, then prints through `printOpenTableBill`) | routes/mis_capture.ts | Fargate |
| `POST /bills/order/:orderId/settle-nc` (settles the bill as non-chargeable, then prints the NC bill through `dispatchPrintJob`) | routes/nc_settle.ts | Fargate |

CloudFront routes `/print/*` and `/publish/*` to the ALB. On that task the emit is
an in-process delivery to a socket it already owns — no Redis hop, no freeze.

The third door is the exception to "everything that prints is under `/print/`".
"Remove service charge & print" (client item 6) sits under `/bills/` beside the
other waiver routes, so the template names its exact path as a fourth behaviour
rather than widening to `/bills/*`, which would move every ordinary bill read and
write onto the task. On Lambda it would be the worst version of a lost emit: the
waiver commits, the answer says `printed: true`, and no paper comes out.
`jest-tests/bill_print_doors_always_on.test.ts` reads every route that dispatches a
bill print and fails if no `realtimeAlb` behaviour in `template.yaml` matches it,
so a fourth door cannot be added under a new prefix and quietly land on Lambda.

The fourth door is "Settle as NC" (client item 5), under `/bills/order/` beside
the other settle routes. Its behaviour is `/bills/order/*/settle-nc`: the only
route with that ending, so the wildcard drags no other bill route onto the task.

**One hostname is mandatory, not cosmetic.** `printer_service.dart:96` calls
`io.io(AppConfig.backendUrl, opts)` — the Socket.IO client is constructed from
the *same* baked-in base URL as the REST calls. Splitting the API and the realtime
endpoint onto two hostnames would require rebuilding and redistributing the
Windows app. CloudFront with path-based origins is what avoids that.

**The alternative you asked to be able to compare: a full API Gateway WebSocket
API rewrite.** It removes the always-on task (saving the ALB + Fargate line
items, roughly half the fixed monthly cost). What it costs in work:

- API Gateway WebSocket APIs do not speak the Socket.IO protocol. Socket.IO's
  handshake, `sid`, packet framing, acks, rooms, and its polling fallback are all
  Socket.IO-specific. You would replace the protocol, not the transport.
- Three `$connect` / `$disconnect` / `$default` Lambda routes, plus a DynamoDB
  table mapping `connectionId → (restaurant, outlet)` — because rooms do not
  exist; you fan out by querying that table and calling
  `PostToConnection` per connection.
- All **61** `emitRestaurant` / `emitOutlet` call sites, across 15 modules under
  `routes/`, change — plus `realtime.ts` is replaced. (61 is a counted figure:
  `grep -c` over `routes/*.ts`. 63 if you count occurrences rather than lines;
  two lines carry two calls.)
- The Flutter client's `socket_io_client` dependency is replaced with a raw
  WebSocket client and a hand-written reconnect/ack layer — then the Windows app
  is rebuilt and pushed through its auto-updater to every restaurant.
- The web dashboard's Socket.IO client changes too.
- `getSession(token)` auth moves from the Socket.IO handshake (`realtime.ts:68-84`)
  into `$connect`.

That is a protocol migration touching three codebases and a shipped desktop app,
to save roughly $30/month. The hybrid is recommended. Revisit it if the Fargate
task ever becomes the scaling bottleneck rather than the cost floor.

### 2.2 Problem 2 — the three timers

`setInterval` needs a live process. Lambda has none between invocations, and a
frozen container runs no timers. All three are now driven by **EventBridge
Scheduler**, which invokes the sweep function with a literal JSON payload that
`lambda.ts` `sweepFromEvent()` dispatches on.

| Sweep | In-process origin | What it actually calls | Schedule | Payload |
|---|---|---|---|---|
| Exceptions + booking reminders | `exceptionSweep` in `bootstrap()`, index.ts:565-595 | `ListRestaurantIds()`, then per tenant `withTenant(...) → RunExceptionChecks(resId)` and `sendDueBookingReminders(resId)` | `rate(30 minutes)` | `{"sweep":"exceptions"}` |
| Scheduled reports | `reportSweep` in `bootstrap()`, index.ts:610-630 | `runReportScheduleSweep()` | `rate(N minutes)`, **created DISABLED** | `{"sweep":"reports"}` |
| Daily billing | `startBillingScheduler`, platform/routes.ts:224-239 | `withPlatformAdvisoryLock(0x52455342, () => runBillingCycle())` | `cron(30 19 * * ? *)` = 01:00 IST | `{"sweep":"billing"}` |

Four things worth knowing:

**The report sweep ships dark, exactly as designed.** `REPORT_SCHEDULER` gates
both the timer *and* `WarmReportingSchema()` (index.ts:538-540) — and that warm-up
exists specifically so the reporting path's lazy DDL never runs inside
`withTenant`'s transaction (where a swallowed `42501` leaves the transaction
aborted and every following statement returns `25P02`). So the flag has to stay
coupled: the `ReportScheduler` stack parameter sets `REPORT_SCHEDULER=true` on the
sweep function **and** flips the EventBridge schedule from `DISABLED` to
`ENABLED`. Leave it `false` until migration 026 is verified in production.

**Everything is idempotent, which is why running twice is safe.** The always-on
Fargate task is the whole app started normally, so it still runs all three
in-process timers. That is deliberate redundancy, not an oversight:

- exceptions — per-alert 24h dedupe inside `RunExceptionChecks`
- reminders — `MarkBookingReminderSent` stamps the slot *before* sending (routes/_shared.ts:792)
- reports — `(schedule_id, occurrence_key)` unique index + an attempts compare-and-swap
- billing — `pg_try_advisory_lock` leader election + `(res_id, period_end)` dedupe (migration 007)

EventBridge is nonetheless the real driver, because the Fargate task might be
scaled to zero, replaced, or busy fanning out sockets — and a schedule that fails
is visible (metric, alarm, dead-letter queue) where a dead `setInterval` is not.

**The sweeps run on their own function.** API Gateway caps an HTTP API
integration at 30 seconds, but the exception sweep walks every tenant in the
fleet. Two functions from one image: `-backend` at 30s, `-sweeps` at 900s with its
own concurrency reservation. `lambda.ts` stops 20 seconds before the deadline and
logs `exception_sweep_deadline_reached` rather than being killed mid-tenant.

**Booking reminders are wired.** `sendDueBookingReminders` used to be a private
function inside `index.ts`, which would have made it unreachable from `lambda.ts`.
The concurrent `index.ts` refactor moved it to `routes/_shared.ts:782` and exported
it, so the sweep imports it directly and the reminder pass runs exactly as the
in-process timer does. Note that it opens its **own** tenant context, so it must
not be nested inside the `withTenant` that wraps `RunExceptionChecks` — `lambda.ts`
keeps them as sibling calls, matching `index.ts`.

### 2.3 Problem 3 — database connections, and Redis

#### The database

Every warm Lambda container opens its own `pg` pool. At 100 concurrent
containers with even the default `PG_POOL_MAX=8` (10 before the 2026-08-24
pool-exhaustion incident) that is up to 800 connections against a Postgres that
permits a small fraction of that. Supabase's transaction
pooler is the normal answer.

**This application cannot use transaction-mode pooling as written.** Two reasons,
both read out of the source rather than assumed:

1. `openTenantConnection` (`database_supabase.ts:1502`) — which the global auth
   gate calls for **every authenticated request** (index.ts:190) — sets the RLS
   context with `set_config('app.res_id', $1, false)`. The `false` means
   *session-level*, and it is issued **outside** any transaction; the route
   handlers then run their queries on that same connection and it is reset at
   `res.finish`. Under transaction pooling the pooler returns the server
   connection after each statement's implicit transaction, so the following
   queries land on a connection where `app.res_id` is empty. RLS then filters
   everything out. This fails **closed** — data appears to vanish rather than
   leak — but it is still a total outage.
2. `withPlatformAdvisoryLock` (`platform/db.ts:47`) uses `pg_try_advisory_lock`,
   a session-level lock acquired and released on separate statements. Under
   transaction pooling those can land on different backends, breaking leader
   election and leaking the lock.

Note the contrast: `withTenant` (`database_supabase.ts:1457`) does it the
transaction-safe way — `set_config(..., true)` inside an explicit `BEGIN`. The
sweeps therefore *would* be fine on the transaction pooler; the request path is
not. Fixing `openTenantConnection` to match `withTenant` is the single change that
unlocks transaction pooling — see [section 10](#10-changes-indexts-needs-not-made-here).

**So: use the pooler in SESSION mode.**

| | Host | Port | Username |
|---|---|---|---|
| Direct — **do not use, see below** | `db.<project-ref>.supabase.co` | 5432 | `app_runtime` |
| Supavisor — **session** mode | `aws-<n>-<region>.pooler.supabase.com` | **5432** | `app_runtime.<project-ref>` |
| Supavisor — transaction mode | `aws-<n>-<region>.pooler.supabase.com` | 6543 | — (unusable, see above) |

**The username is `app_runtime.<project-ref>`, and getting this wrong is a total
outage.** Supavisor routes to your project by parsing the username as
`<role>.<project-ref>`, so the role you want is the left-hand side. The Dashboard
prints the string for whichever role it is showing you — usually `postgres` —
and `postgres` on Supabase carries `rolbypassrls`. The template hardcodes
`ENFORCE_RLS_AT_BOOT=true` on both functions and the task,
`verifyTenantRlsAtBoot` (`database_supabase.ts:1337-1352`) checks exactly that
flag and throws, `bootstrap()`'s `.catch` calls `process.exit(1)`, and **every
container in the stack dies at cold start** — surfacing as `Runtime.ExitError`
with the real message buried in a detached-promise log line. §3 requires
`app_runtime` for the same reason: a superuser bypasses RLS, which is the one
thing multi-tenant isolation rests on.

So: copy the host and port from **Supabase Dashboard → Connect** (the `aws-<n>-`
prefix differs between older and newer projects — do not construct it by hand),
then replace the role part of the username with `app_runtime` and supply
`app_runtime`'s password. The port is the only reliable way to tell the two pooler
modes apart — same host, 5432 is session, 6543 is transaction.

**Do not use the direct host on Lambda.** New Supabase projects resolve
`db.<project-ref>.supabase.co` as **IPv6-only**, and a Lambda that is not
VPC-attached — which this one deliberately is not — has IPv4-only egress. It is
listed above for completeness, not as an option. The pooler host is dual-stack,
which is also why `SUPABASE_IPV4_URL` is unnecessary here.

Session mode does not multiply your connection capacity; it moves the ceiling to
Supavisor and queues behind it. So the budget has to be enforced on the Lambda
side:

```
PG_POOL_MAX = 1              per container (set in template.yaml)
PLATFORM_PG_POOL_MAX = 1     per container

LambdaReservedConcurrency (20)
  + SweepReservedConcurrency (3)
  + Fargate task PG_POOL_MAX (5) + PLATFORM_PG_POOL_MAX (2)
  + headroom for your own psql / Studio sessions
  <= your Supavisor pool size
```

Check the pool size at **Dashboard → Settings → Database → Connection pooling**.
On the smaller compute add-ons it is small — tens, not hundreds. If Lambda
throttles (the `-lambda-throttles` alarm fires), **raise the Supabase pool size
first**, then `LambdaReservedConcurrency`. Doing it the other way round trades
"some requests are rejected" for "the database refuses connections", which is
worse.

#### What `PG_POOL_MAX=1` costs you — read this before the first busy morning

`1` is not just "small". It is **one connection slot per container, shared by
everything in that container**, and that has a specific failure mode on cold
starts that you should recognise on sight rather than debug live.

At cold start, `bootstrap()` runs detached and puts two queries through that one
slot: `ensureFeaturePermissionActions` (a write) and `verifyTenantRlsAtBoot` (a
read). The container's **first request** calls `openTenantConnection`
(`database_supabase.ts:1502`), which calls `pool.connect()` on that same
one-slot pool and **queues behind them**. Normally that is a few hundred
milliseconds of extra latency and nothing more.

It stops being latency when the wait exceeds `PG_CONNECTION_TIMEOUT_MS` (8000,
set in `template.yaml`). `openTenantConnection` wraps the connect in a
`try/catch` (lines 1508-1512) and on failure falls through to `ipv4pool` — which,
with `SUPABASE_IPV4_URL` unset as this runbook recommends, was constructed as
`new Pool({ connectionString: undefined })` and therefore tries **localhost**.
That fails too, `index.ts` logs `tenant_connection_open_failed` and returns
**503 "Database unavailable"**. So under a scale-out wave — a burst of cold
containers while Supavisor is already at its ceiling — a slow start does not
merely lag, it returns 503s.

**The decision: `PG_POOL_MAX` stays at 1.** Raising it to 2 removes the
contention and doubles the worst-case connection count (20 backend + 3 sweep
containers go from 23 to 46) against the exact Supavisor pool this setting exists
to protect. That trades a rare, bounded cold-start stall for a standing risk of
the database refusing connections — the same trade this section already tells you
not to make in the throttling paragraph, and worse because it is not visible in
an alarm.

Two levers if you hit it:

1. **Raise the Supabase pool size, then `PG_POOL_MAX` to 2.** In that order,
   never the reverse.
2. **Prefer queueing to 503s:** set `SUPABASE_IPV4_URL` to the *same* session-pooler
   connection string as `SUPABASE_DIRECT_URL`. The fallback pool then points at a
   real database instead of localhost, so a timed-out first connect gets served
   instead of erroring. Budget for it honestly: it is a second pool with its own
   `max`, so a container under contention can hold **two** connections, not one.

The durable fix is item 5 in [section 10](#10-changes-indexts-needs-not-made-here)
— make `openTenantConnection` transaction-safe, move to the 6543 pooler, and the
whole one-connection budget stops being necessary.

Two further notes, stated as limitations rather than fixed:

- `PG_IDLE_TIMEOUT_MS=10000` closes idle clients between requests in an *active*
  container. A **frozen** container runs no timers, so its connection stays open
  until Lambda reaps the container and the TCP connection dies. There is no way
  to improve this without changing `database_supabase.ts`.
- `pg` is not configured with `keepAlive`. Adding it would help detect
  half-open sockets across a freeze/thaw cycle. Also a `database_supabase.ts`
  change; see section 10.

#### Redis

`REDIS_URL` is currently **not set**, so sessions live in process memory
(`getStore`, auth/store.ts:110). On a single box that is a restart annoyance. On Lambda it
is broken authentication: each container mints sessions no other container can
see, so users get random 401s as requests land on different containers. The
template therefore sets `REQUIRE_REDIS=true`, which makes the app refuse to start
rather than serve split-brain auth.

Redis is used for three things: the session store, the rate limiter
(`auth/store.ts` `incr`), and the Socket.IO adapter — and that last one **requires
pub/sub** (`PUBLISH`/`SUBSCRIBE`), not just `GET`/`SET`.

**It must be reachable without putting Lambda in a VPC.** ElastiCache is
VPC-only. Attaching Lambda to a VPC is fine for reaching ElastiCache, but this app
also needs outbound internet (Supabase, Razorpay, Supabase Storage, OpenAI, the
web-push services) — and a VPC-attached Lambda gets that only through a **NAT
Gateway**, which is an always-on hourly charge plus per-GB processing, on the
order of **$32–40/month before data**, purely to reach a $10 Redis. That is why
the template keeps Lambda out of the VPC entirely.

Use a managed Redis with a **public TLS endpoint** (`rediss://`). Candidates:

- **Redis Cloud (Redis Inc.) Essentials** — full Redis, public TLS endpoint, a
  free 30 MB tier and small paid tiers from roughly **$5–10/month**.
- **Aiven for Valkey/Redis** — public endpoint, hobbyist tiers from roughly
  **$15–25/month**.
- **Upstash** — serverless, per-command pricing, very cheap at this volume.
  **Verify pub/sub on their Redis-protocol (TCP) endpoint before committing.**
  Upstash's REST API and its Redis endpoint have historically differed in pub/sub
  support, and the Socket.IO adapter will not work without it.

Whichever you pick, **prove pub/sub works before you deploy**:

```bash
# terminal 1
redis-cli --tls -u "rediss://default:PASSWORD@HOST:PORT" subscribe smoketest
# terminal 2
redis-cli --tls -u "rediss://default:PASSWORD@HOST:PORT" publish smoketest hello
```
Terminal 1 must print the message. If it does not, printing will not work.

**Size it for connections, not memory.** Each container opens up to three: one
session-store client plus the two pub/sub clients `initRealtime` creates. Budget
roughly `3 × (LambdaReservedConcurrency + SweepReservedConcurrency) + 3` — about
**72 connections** at the defaults. Redis Cloud's free tier caps at 30; that is
not enough. Check the connection limit of the plan you buy.

---

## 3. Secrets and environment variables

### How credentials get configured

**You run every command below. Never paste an AWS key, a database password or a
Razorpay secret into a chat, a ticket, or a file in this repository.**

```bash
aws configure sso          # preferred: short-lived credentials
# or
aws configure              # long-lived access key, stored in ~/.aws/credentials
aws sts get-caller-identity   # confirm you are the account you think you are
```

Application secrets go into **one AWS Secrets Manager secret** as a flat JSON
object of `{"ENV_VAR": "value"}` pairs. `deploy/secrets.ts` fetches it once per
container and copies each key into `process.env` **before** `index.ts` is
imported — necessary because `qr_signing.ts:12` throws without
`QR_SIGNING_SECRET`, `database_supabase.ts:101` throws without a connection
string, and `auth/store.ts:110` picks Redis vs memory on first use.

Only the secret's **ARN** appears in `template.yaml`. No credential is ever a
CloudFormation parameter, so none is visible in the stack's event history.

**Precedence: a variable already in the environment wins.** The values set on the
function and the task definition beat the secret store, so a stale `PG_POOL_MAX`
left in the secret can never override the infrastructure.

### Create the secret

Write the JSON to a local file, use it, then delete it. Do not commit it.

```bash
# create app-secrets.json locally (see the table below for contents)
aws secretsmanager create-secret \
  --name cuisineflow/prod \
  --description "CuisineFlow backend runtime configuration" \
  --secret-string file://app-secrets.json

rm app-secrets.json      # then note the returned ARN
```

**No `--kms-key-id`, on purpose.** Without it the secret is encrypted with the
AWS-managed `aws/secretsmanager` key, and the `secretsmanager:GetSecretValue`
grants in `template.yaml` are sufficient on their own. If you choose a
**customer-managed** KMS key instead, every role that reads the secret also needs
`kms:Decrypt` on that key — both Lambda function roles and `RealtimeTaskRole` —
or granted on the key policy. Miss it and `GetSecretValue` returns
`AccessDeniedException`, which on this stack means **every container dies at
boot**, exactly like the wrong database role does.

### Every variable, and where it comes from

**Required — the deploy will not work without these.**

| Variable | Where it comes from |
|---|---|
| `SUPABASE_DIRECT_URL` | Supabase → Connect → **session pooler** string (port 5432 on the pooler host). Use the least-privilege `app_runtime` role from migration 002, never the `postgres` superuser — a superuser bypasses RLS and `ENFORCE_RLS_AT_BOOT=true` will kill every container. On the pooler that makes the username **`app_runtime.<project-ref>`**, not `app_runtime` and not `postgres.<project-ref>`; see [2.3](#23-problem-3--database-connections-and-redis). |
| `QR_SIGNING_SECRET` | Your existing value. **Copy it from the current deployment — do not generate a new one.** See [section 9](#9-migration-hazards). |
| `REDIS_URL` | Your managed Redis provider, as `rediss://default:PASSWORD@HOST:PORT`. |

**Strongly recommended.**

| Variable | Where it comes from |
|---|---|
| `PLATFORM_DATABASE_URL` | Same Supabase project, same session-pooler host and port, as the `platform_runtime` role (migration 004) — so the username is **`platform_runtime.<project-ref>`**, by the same Supavisor rule as above. Without it every `/platform/*` route returns 503 and the billing sweep is a no-op. It must be session mode too: `withPlatformAdvisoryLock` uses a session-scoped `pg_try_advisory_lock`. |
| `SUPABASE_PROJECT_URL`, `SUPABASE_DEFAULT_API_KEY` | Supabase → Settings → API. **Both** or neither — storage uploads (logos, menu images) are silently disabled if either is missing. |
| `SENTRY_DSN`, `APP_VERSION` | Sentry project settings. Serverless makes error tracking more valuable, not less: there is no box to SSH into. |

**Per-feature — omit to leave the feature off.**

| Variable | Feature | Source |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | guest online payment (`/qr/:slug/razorpay/*`, else 503) | the restaurant's Razorpay dashboard |
| `PLATFORM_RAZORPAY_KEY_ID`, `PLATFORM_RAZORPAY_KEY_SECRET` | tenant self-serve subscription payment | **your** platform Razorpay account |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web push for the guest waitlist | `npm run push:vapid-keys` |
| `OPENAI_API_KEY` | voice receptionist, `POST /realtime/session` | OpenAI dashboard |
| `METRICS_TOKEN` | bearer-gates `GET /metrics` | generate one; **set it** — the route is otherwise public through CloudFront |
| `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_DOWNLOAD_WINDOWS`, `APP_DOWNLOAD_ANDROID`, `APP_DOWNLOAD_IOS`, `APP_UPDATE_NOTES` | the Windows/Android auto-updater manifest at `GET /app/version` | your release process |
| `SAAS_AUTO_TRIAL`, `SAAS_TRIAL_DAYS`, `SAAS_GRACE_DAYS` | subscription policy | your product decisions |
| `SUPABASE_IPV4_URL` | IPv4 fallback pool | not needed for IPv4 — the pooler host is dual-stack. Leave unset by default. It has a second, unrelated use as a cold-start safety net: see "What `PG_POOL_MAX=1` costs you" in [2.3](#23-problem-3--database-connections-and-redis). Unset, the fallback pool points at localhost and turns a slow first connect into a 503. |
| `PY_SERVER_URL` | the Python feedback-question service | **not deployed by this template** — see [section 11](#11-what-is-not-covered-and-what-is-genuinely-uncertain) |

**Set by `template.yaml` — do NOT put these in the secret.** `NODE_ENV`, `PORT`,
`APP_SECRET_ARN`, `ALLOWED_ORIGINS`, `DASHBOARD_BASE_URL`,
`ALLOW_RAILWAY_WILDCARD`, `ENFORCE_RLS_AT_BOOT`, `REQUIRE_REDIS`, `SEED_DEMO`,
`REPORT_SCHEDULER`, `REPORT_SWEEP_INTERVAL_MIN`, `PG_POOL_MAX`,
`PLATFORM_PG_POOL_MAX`, `PG_IDLE_TIMEOUT_MS`, `PG_CONNECTION_TIMEOUT_MS`,
`LOG_LEVEL`.

**Never deploy.** `MIGRATION_DATABASE_URL` is the owner/superuser role and is used
only by `scripts/migrate.ts`, which you run from your own machine. Neither image
contains `scripts/` or `migrations/`, so the request path has no ability to run
DDL even if that credential leaked into it.

---

## 4. Deploy

### 4.1 Create the ECR repository

```bash
export AWS_REGION=ap-south-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws ecr create-repository --repository-name cuisineflow \
  --image-scanning-configuration scanOnPush=true \
  --region "$AWS_REGION"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
      "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
```

### 4.2 Build and push both images

Tag with something you can identify later — a date or a git SHA. **Do not use
`latest`**: rollback ([section 8](#8-rollback)) depends on being able to name a
previous image.

```bash
cd Restaurant_Backend
export TAG=$(date +%Y%m%d-%H%M)
export REPO="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/cuisineflow"

docker build --platform linux/amd64 -f deploy/Dockerfile --target lambda \
  -t "$REPO:lambda-$TAG" .
docker build --platform linux/amd64 -f deploy/Dockerfile --target realtime \
  -t "$REPO:realtime-$TAG" .

docker push "$REPO:lambda-$TAG"
docker push "$REPO:realtime-$TAG"
```

`--platform linux/amd64` is not optional. `sharp` and `@node-rs/argon2` resolve a
different native binary per platform; an arm64 image built on an Apple Silicon
laptop fails at import on the x86_64 Lambda the template declares.

### 4.3 Apply database migrations — from your machine, before the stack

Migrations run as the **owner** role and must land before the new backend serves
traffic. Do this from your laptop, not from a container.

`scripts/migrate.ts` reads `MIGRATION_DATABASE_URL` — the owner/superuser role —
which is **never** deployed and is not in the AWS secret. Set it in your local
shell (or local `.env`) first, or the migration runs as whatever
`SUPABASE_DIRECT_URL` points at and fails on `must be owner of table`:

```bash
export MIGRATION_DATABASE_URL='postgresql://postgres:...@db.<project-ref>.supabase.co:5432/postgres'

npm run migrate:dry     # read the plan first
npm run migrate

unset MIGRATION_DATABASE_URL
```

### 4.4 Deploy the stack

```bash
export ORIGIN_SECRET=$(openssl rand -hex 32)

sam deploy \
  --template-file deploy/template.yaml \
  --stack-name cuisineflow-prod \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --confirm-changeset \
  --parameter-overrides \
      LambdaImageUri="$REPO:lambda-$TAG" \
      RealtimeImageUri="$REPO:realtime-$TAG" \
      AppSecretArn="arn:aws:secretsmanager:...:secret:cuisineflow/prod-XXXXXX" \
      AllowedOrigins="https://app.example.com" \
      DashboardBaseUrl="https://app.example.com" \
      OriginVerifySecret="$ORIGIN_SECRET" \
      ReportScheduler=false \
      LambdaReservedConcurrency=20
```

First deploy takes roughly 15–25 minutes, most of it CloudFront. Read the
changeset before confirming.

**Use the explicit block above for the FIRST deploy, not `npm run aws:deploy`.**
`OriginVerifySecret` has no `Default`, so CloudFormation must be given it once,
and `deploy/samconfig.toml` deliberately does not store it (it is a secret and
that file is in the repository).

**Then edit the image tags in `deploy/samconfig.toml` to the tags you just
pushed**, and every later deploy is:

```bash
npm run aws:deploy          # no flags
```

`OriginVerifySecret` is absent from the config file's `parameter_overrides`, so
CloudFormation retains the value already on the stack. That is by design.

> ⚠️ **Do not add `--parameter-overrides` to that command.** SAM treats the config
> file's `parameter_overrides` as the *default value* of the
> `--parameter-overrides` option, and passing the option on the command line
> **replaces** that list rather than merging with it. So
> `npm run aws:deploy -- --parameter-overrides OriginVerifySecret=<hex>` drops
> `LambdaImageUri` and `RealtimeImageUri`: on a first deploy it fails with
> "Parameters: [...] must have values"; on an update it is worse and silent,
> because the dropped parameters fall back to `UsePreviousValue` and the stack
> **keeps the old image**. You edit the tag, run the command, watch a green
> deploy, and ship nothing. If you ever need to rotate `OriginVerifySecret`, you
> must re-list every parameter in one command — the exact form is in the header
> of `deploy/samconfig.toml`.

### 4.5 Read the outputs

```bash
aws cloudformation describe-stacks --stack-name cuisineflow-prod \
  --query 'Stacks[0].Outputs' --output table
```

`BackendUrl` is the value everything else points at.

### 4.6 Repoint and redeploy the Next.js dashboard

The dashboard (`Restaurant_Dashboard_UI`) is **not** deployed by this template,
but it must be repointed and redeployed, and that has to happen **before**
[section 6](#6-verify-it-worked) step 5 — which prints a bill *from the
dashboard* — can pass. The Windows app gets six careful steps in
[9.2](#92-the-windows-app-bakes-its-backend-url-in-at-build-time); this is its
sibling client and it needs its own.

`AllowedOrigins` and `DashboardBaseUrl` are the **backend's** view of the
dashboard — who may call it, and what URL to build feedback links from. Neither
tells the dashboard where the backend now lives. That is baked into the
dashboard's own build: `NEXT_PUBLIC_BACKEND_URL` is read at build time by Next.js
and compiled into the client bundle (`Restaurant_Dashboard_UI/Dockerfile` takes
it as an `ARG` and re-exports it as an `ENV` before `npm run build`).

1. **Attach the custom domain first if you are going to have one**
   ([section 5](#5-custom-domain)). Repointing the dashboard twice is avoidable
   work, and unlike the Windows app you can redo it cheaply — but do it once.
2. Set `NEXT_PUBLIC_BACKEND_URL` to the `BackendUrl` output above (or your custom
   domain), wherever that build is configured — hosting-provider build variables,
   `.env`, or `--build-arg`. One value covers both the REST calls
   (`src/lib/db.ts`, `API_BASE_URL`) and the Socket.IO connection
   (`src/lib/socket.ts`, `initSocket`), so this also moves the dashboard's live
   order/table updates onto the new stack.
3. Check `NEXT_PUBLIC_FEEDBACK_FORM_URL` too if you set it — it is a separate
   build-time value and it does not follow the backend URL.
4. **Rebuild and redeploy** the dashboard. `NEXT_PUBLIC_*` is baked at build time:
   changing the variable without a rebuild changes nothing.
5. Confirm the dashboard's own origin is listed in the stack's `AllowedOrigins`
   and that `DashboardBaseUrl` matches where it is now served. If either is
   wrong, redeploy the stack with corrected values — the printed-bill QR and the
   post-payment redirect are built from `DashboardBaseUrl`, so a stale value
   sends guests to the old host.
6. If the dashboard is still on Railway at cutover, read
   [9.3](#93-cors-and-the-railway-wildcard) first: the template sets
   `ALLOW_RAILWAY_WILDCARD=false`, so its browser requests start failing CORS the
   moment it talks to the new backend.

---

## 5. Custom domain

You can launch on the generated `*.cloudfront.net` name and attach the real one
later; nothing else in the stack changes.

1. **Request the certificate in `us-east-1`.** CloudFront reads certificates only
   from that region, regardless of where this stack lives.
   ```bash
   aws acm request-certificate --region us-east-1 \
     --domain-name api.example.com --validation-method DNS
   ```
2. Add the CNAME record ACM gives you, and wait for `ISSUED`.
3. Redeploy with the domain attached:
   ```bash
   sam deploy ... --parameter-overrides \
       CustomDomainName=api.example.com \
       AcmCertificateArn=arn:aws:acm:us-east-1:...:certificate/... \
       ...all the other parameters...
   ```
4. Point `api.example.com` at the `CloudFrontDomainName` output — a CNAME, or an
   ALIAS/ANAME if your DNS provider supports it at the apex.
5. Add the new origin to `AllowedOrigins` if the dashboard moves too.

Do this **before** repointing the Windows app ([section 9](#9-migration-hazards)).
A domain you control is what lets you move the backend again later without
touching a single installed app.

---

## 6. Verify it worked

Work down this list. Each step depends on the one above it.

```bash
BASE=$(aws cloudformation describe-stacks --stack-name cuisineflow-prod \
  --query "Stacks[0].Outputs[?OutputKey=='BackendUrl'].OutputValue" --output text)
```

**1. Lambda is serving and can reach the database.**
```bash
curl -s "$BASE/health" | jq
```
Expect `status: "ok"`, `database.ok: true`. A `503` with `"degraded"` means the
function is running but Postgres is unreachable — check the connection string and
that you used the **session** pooler port.

**2. Redis is actually attached** — this is the printing prerequisite.
```bash
curl -s "$BASE/health" | jq .realtime
```
Must be `{"adapter": "redis"}`. `"in-memory"` means `REDIS_URL` did not reach the
container, and emits will not cross processes. Stop and fix this before going
further.

**3. The realtime origin is reachable and CloudFront-only.**
```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/socket.io/?EIO=4&transport=polling"
# expect 200

ALB=$(aws cloudformation describe-stacks --stack-name cuisineflow-prod \
  --query "Stacks[0].Outputs[?OutputKey=='RealtimeAlbDnsName'].OutputValue" --output text)
curl -s -o /dev/null -w '%{http_code}\n' "http://$ALB/health"
# expect 403 — the origin must not be usable directly
```

**4. Auth works across containers.** Log in, then call an authenticated route
several times in a row. Consistent success means the session store is shared; a
mix of 200s and 401s means you are on the in-memory store (step 2 failed).

**5. Printing end to end — the one that matters.** Point one Windows app at the
new backend (use the login screen's server-override dialog, not a rebuild), log
in, confirm the printer agent shows connected, then print a bill from the
dashboard. Watch the Fargate logs:
```bash
aws logs tail /ecs/cuisineflow-prod-realtime --follow
```
> This step prints **from the dashboard**, so it cannot pass until the dashboard
> has been repointed at the new backend and redeployed —
> [4.6](#46-repoint-and-redeploy-the-nextjs-dashboard). If the dashboard is still
> talking to the old backend you are testing the old stack and it will look like a
> pass.

**6. The sweeps fire — and actually did something.** Run one by hand rather than
waiting 30 minutes:
```bash
SWEEP=$(aws cloudformation describe-stacks --stack-name cuisineflow-prod \
  --query "Stacks[0].Outputs[?OutputKey=='SweepFunctionName'].OutputValue" --output text)

aws lambda invoke --function-name "$SWEEP" \
  --payload '{"sweep":"exceptions"}' --cli-binary-format raw-in-base64-out \
  /dev/stdout
```
A pass is **all** of the following:

```json
{"ok":true,"sweep":"exceptions","tenants":N,"checksFailed":0,"remindersFailed":0,"stoppedEarly":false}
```

- `ok` must be `true`. It is computed, not a constant: it is `false` whenever any
  tenant's checks or reminders threw.
- `checksFailed` and `remindersFailed` must both be **0**. Do not skip these.
  Every per-tenant call is caught so one tenant's bad data cannot abort the
  fleet — which means a sweep that failed for *every* tenant would otherwise walk
  the whole list, log warnings, and hand you a tidy 200.
- `tenants` should equal your tenant count. `tenants` is tenants **visited**, not
  tenants that succeeded — which is exactly why the two counters above matter.
- `stoppedEarly: true` means the sweep ran out of time — see
  [section 11](#11-what-is-not-covered-and-what-is-genuinely-uncertain).

The specific failure this is watching for is a **permissions** failure, not a
data one. `RunExceptionChecks` calls `ensureBrandingColumns()` on entry
(`database_supabase.ts:22830`), which issues
`alter table "Restaurant" add column if not exists …` and does not swallow the
error. The least-privilege `app_runtime` role that migration 002 creates is
`NOSUPERUSER … NOBYPASSRLS` with only DML granted, so Postgres raises
`42501 must be owner of table` **even when the column already exists**, and inside
`withTenant`'s explicit transaction that aborts the transaction. It hits every
tenant identically. (This is the same lazy-DDL-inside-a-transaction hazard that
`WarmReportingSchema` exists to avoid on the reporting path — see
[2.2](#22-problem-2--the-three-timers).)

If `checksFailed` equals `tenants`, the invocation **throws** instead of
returning: you will see a `FunctionError` and a stack trace rather than a JSON
body, and the retry, the `Errors` metric and eventually the `-sweep-dlq` alarm
all fire. Fix it by applying the missing columns as the owner role from your own
machine (`npm run migrate`, with `MIGRATION_DATABASE_URL` set), not by widening
`app_runtime`.

If only *some* tenants failed, nothing alarms — the `-sweep-errors` alarm keys on
the Lambda `Errors` metric and a partial failure does not increment it. Check
`ok`/`checksFailed` here, and put a metric filter on the
`exception_sweep_completed_with_failures` log line if you want it alarmed.

**7. Nothing is throttling.** After a few hours of real traffic, check the
`-lambda-throttles` and `-sweep-dlq` alarms. Both should be `OK`.

---

## 7. Rough monthly cost

**These are directional estimates, not quotes.** They assume `ap-south-1`-class
pricing, low-to-moderate traffic (order of 1M requests/month), and they exclude
free-tier credits, taxes and data transfer beyond the obvious. Get real numbers
from the AWS Pricing Calculator for your region, and check actual spend after the
first full month.

| Item | Rough monthly | Notes |
|---|---|---|
| Application Load Balancer | **$18–25** | fixed hourly + LCUs; you pay this at zero traffic |
| Fargate task (0.5 vCPU / 1 GB, always on) | **$15–20** | the other half of the realtime floor |
| **Public IPv4 addresses (3)** | **~$11** | **fixed, unavoidable in this design.** $0.005/hr each: two on the ALB (one per AZ — an ALB requires two) plus one on the Fargate task (`AssignPublicIp: ENABLED`, which is what replaces a NAT Gateway). ~3 × $3.65. |
| CloudFront | **$1–10** | request + per-GB; low at API-sized payloads |
| Lambda (both functions) | **$2–10** | 1 GB × short invocations; free tier absorbs a lot |
| API Gateway HTTP API | **$1–2** | ~$1.00 per million requests |
| **AWS X-Ray** | **$4–5** | `Globals.Function.Tracing: Active` (template.yaml) traces both functions. Roughly this at ~1M requests/month once the 100k free traces are gone. Set `Tracing: PassThrough` to remove it once you have finished tuning. |
| CloudWatch Logs | **$3–20** | **the most volatile line.** One JSON line per request (`requestLog`, index.ts:79) plus API Gateway access logs. Set `REQUEST_LOG=off` and cut `LogRetentionDays` if it climbs. |
| Secrets Manager | **~$0.40** | one secret |
| ECR storage | **<$1** | two image tags |
| SQS, EventBridge, alarms | **~$1** | effectively noise at this volume |
| Managed Redis (external) | **$5–25** | see [2.3](#23-problem-3--database-connections-and-redis) |
| **Total** | **roughly $60–105/month** | the ranges do not peak together; adding every maximum gives ~$130 |

Read that honestly: **the Lambda part is the cheap part.** Roughly **$45–55** of
the floor is the ALB, the Fargate task and their public IPv4 addresses — all of
which exist purely because Socket.IO cannot run on Lambda — and you pay it whether
or not anyone is using the system. A single always-on container host would run
this whole application for less. You asked for Lambda with the caveats
understood; this is what the caveat costs in rupees.

The IPv4 charge is worth naming separately because it is the part that looks like
a rounding error and is not: it is ~25% on top of the ALB + Fargate floor, it
appears at zero traffic, and it cannot be tuned away without either putting Lambda
in a VPC behind a NAT Gateway (which costs *more* — see
[2.3](#23-problem-3--database-connections-and-redis)) or removing the always-on
task altogether.

Two things that could move the number a lot:

- **Cold starts.** This image imports a very large module graph (index.ts is
  ~30 route modules, database_supabase.ts ~1.1 MB) and `bootstrap()` does two database
  round-trips on top. If p99 latency is unacceptable, provisioned concurrency
  fixes it — and adds roughly $12–15/month per provisioned instance, permanently.
- **Log volume.** At high request rates CloudWatch ingestion can quietly become
  the largest line on the bill.

---

## 8. Rollback

**Fastest — repoint to the previous image (about 2 minutes).** Requires that you
tagged images per [4.2](#42-build-and-push-both-images).

```bash
sam deploy ... --parameter-overrides \
    LambdaImageUri="$REPO:lambda-<PREVIOUS_TAG>" \
    RealtimeImageUri="$REPO:realtime-<PREVIOUS_TAG>" \
    ...all the other parameters...
```

**Infrastructure change gone wrong.** CloudFormation rolls back a failed deploy
automatically. To undo a *successful* one, redeploy the previous template from
git. To abandon a stack stuck in `UPDATE_ROLLBACK_FAILED`:
```bash
aws cloudformation continue-update-rollback --stack-name cuisineflow-prod
```

**Stop the sweeps without a deploy.**
```bash
aws scheduler update-schedule --name cuisineflow-prod-exception-sweep --state DISABLED \
  --schedule-expression 'rate(30 minutes)' \
  --flexible-time-window Mode=OFF \
  --target '{"Arn":"<sweep function arn>","RoleArn":"<scheduler role arn>","Input":"{\"sweep\":\"exceptions\"}"}'
```
`update-schedule` replaces the whole schedule, so pass every field. Reading the
current one first (`aws scheduler get-schedule --name ...`) is the safe way.

**Back to the old host entirely.** This is the reason for section 9's ordering:
keep the previous backend running and healthy until you have verified the new one,
because reverting means pointing DNS back — and every Windows app that has already
been repointed follows DNS, not a rebuild.

**Database.** There is no automatic rollback for migrations. Restore from a
Supabase point-in-time backup if a migration is the problem, and be aware that
restoring the database undoes real orders and bills taken since that point.

---

## 9. Migration hazards

These are specific to this product. Each one can break every restaurant at once.

### 9.1 `QR_SIGNING_SECRET` — rotating it invalidates every printed QR code, everywhere, instantly

`qr_signing.ts` HMACs the table token in every customer QR URL with this secret.
`signTable()` is `HMAC-SHA256(secret, "<resId>:<normalized table name>")`, and
`verifyTable()` recomputes it. There is no key id in the token, no grace period
and no second key — `decodeTableToken` either verifies against the one current
secret or returns `null`.

So a new secret means **every QR code printed and stuck to every table in every
restaurant stops working at the same moment**. Guests scan and get an invalid
table. The failure is total, immediate, and only fixable by reprinting and
physically replacing every table's QR code.

**Copy the existing value into the new secret. Do not generate a new one.**

The trap is that generating one is the natural thing to do — `.env.example` even
tells you to run `openssl rand -base64 32`. That instruction is for a *first*
deployment. This is a migration.

There is a second trap in the same file: if `QR_SIGNING_SECRET` is unset, the app
refuses to boot (`qr_signing.ts:19-24`) rather than falling back to the
source-published dev secret. That is correct and protective — but it means a
missing key looks like "the whole deployment is broken", not "QR codes are
broken". If containers crash at start with `QR_SIGNING_SECRET is not set`, that is
what happened.

If you ever genuinely must rotate it, the only safe sequence is: add key-id
support and dual verification to `qr_signing.ts`, deploy that, reprint every code
over a scheduled window, then retire the old key. That is a product project, not
a deploy step.

### 9.2 The Windows app bakes its backend URL in at build time

`restaurant_owner_app/lib/config.dart`:
```dart
static const String _builtBackendUrl =
    String.fromEnvironment('BACKEND_URL', defaultValue: 'http://localhost:3001');
```
It is compiled in via `--dart-define=BACKEND_URL=...`. The app is updated through
its own auto-updater, which polls `GET /app/version` — a route on the backend
itself. So the app can only learn about a new version from a backend it can
already reach.

**If the old backend disappears before the apps are repointed, they cannot be
repointed.** They will not reach the new backend (they do not know it exists) and
they will not reach the updater manifest (it lived on the old one). Every affected
restaurant loses its POS and its printing until someone touches each machine.

Two things make this survivable:

- **A runtime override exists.** `AppConfig.setBackendOverride()` persists a URL
  in `SharedPreferences` and wins over the baked-in value; it is set from the
  login screen's server dialog. This is the per-machine escape hatch and the
  right tool for piloting one restaurant before committing.
- **`AppConfig.backendUrl` is used for both REST and Socket.IO** — so the override
  moves printing too, which is why the single CloudFront hostname matters.

**The correct order:**

1. Deploy the AWS stack. Keep the old backend running, on the same database.
2. Attach the custom domain ([section 5](#5-custom-domain)) — do not distribute a
   `*.cloudfront.net` URL to installed apps, or you will have to do this again.
3. Pilot: use the server-override dialog on **one** machine. Verify login,
   orders, and a real bill printing on a real printer.
4. Build a new Windows app with `--dart-define=BACKEND_URL=https://api.example.com`,
   publish it, and update `APP_DOWNLOAD_WINDOWS` / `APP_LATEST_VERSION` **on the
   old backend** — that is what the installed apps are still polling.
5. Wait for the fleet to update. `APP_MIN_VERSION` forces the ones that lag.
6. Confirm the old backend is seeing no traffic. Only then decommission it.

Do not compress steps 4–6. The apps update on their own schedule, on machines you
do not control, in restaurants that may be closed for a week.

Note also that the Windows zip must stay **flat** for the auto-updater to work —
a known constraint of the existing updater, unrelated to AWS but easy to break
while re-cutting a release for step 4.

### 9.3 CORS and the Railway wildcard

`index.ts:226` defaults `ALLOW_RAILWAY_WILDCARD` to true, so any
`*.up.railway.app` origin is accepted. The template sets it to `"false"`. If the
dashboard is still on Railway when you cut over, **either move it first or set
this back to `"true"` temporarily** — otherwise the dashboard's browser requests
start failing CORS the moment it talks to the new backend.

### 9.4 Request size: 15 MB in the app, 10 MB at the gateway

`index.ts:253` accepts JSON bodies up to 15 MB, and several routes take images as
base64 in the body (`POST /menu/upload-image`, `POST /valet/scan-plate`, the logo
and payment-screenshot uploads). API Gateway HTTP API caps a request payload at
**10 MB**, and Lambda caps a synchronous *response* at **6 MB**. Uploads between
10 and 15 MB that work today will start returning `413` on Lambda.

Base64 inflates by about 4/3, so the real cutoff is roughly a 7.5 MB source image.
Modern phone photos exceed that. Test the upload paths with a large photo before
cutover. The durable fix is presigned direct-to-Supabase-Storage uploads, which is
an application change, not a deployment one.

### 9.5 Sessions are invalidated by the move

Sessions currently live in the old process's memory. When you cut over, every
logged-in user is logged out once. Harmless, but tell staff so it does not look
like a failure — ideally cut over outside service hours.

---

## 10. Changes `index.ts` needs (not made here)

`index.ts`, `platform/routes.ts`, `realtime.ts` and everything under `routes/`
were out of scope for this work — another engineer refactored `index.ts` *while*
this was being written, extracting ~30 route modules into `routes/`. Nothing below
was changed by this work. Everything below is worth doing, in roughly this order.

> **On the line numbers in this document.** They were re-verified against the tree
> after that refactor landed, but `index.ts` is actively moving. Where a line
> number and a symbol name disagree, trust the symbol name.

**1. ~~Export `sendDueBookingReminders`~~ — already done.** It was private to
`index.ts` when this work started, which would have left the EventBridge sweep
running exception checks but silently skipping booking reminders. The concurrent
refactor moved it to `routes/_shared.ts` and exported it. `lambda.ts` imports it
directly. Nothing to do; recorded here so the change is not accidentally reverted.

**2. Do not run `bootstrap()` when the runtime is Lambda.** `bootstrap()` is
still called unconditionally at the bottom of `index.ts`. On Lambda it binds a
pointless port, runs `ensureFeaturePermissionActions` (a database *write*) and
`verifyTenantRlsAtBoot` (a read) on **every cold start**, and arms three timers a
frozen container will never run.
```ts
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  bootstrap().catch(...);
}
```
> **Do not skip `ensureRealtime()` along with it.** That part is now split out and
> `lambda.ts` awaits it directly, *before* the container serves anything — see
> [2.1](#21-problem-1--websockets). It is what makes `emitRestaurant` /
> `emitOutlet` work at all from a Lambda-served route, because both return early
> when `io` is null. If you add the guard above, `ensureRealtime()` must still run
> (it already does, from `lambda.ts`); what you are switching off is the seed, the
> two boot queries, the `listen`, and the timers.

The remaining cost after that guard is the two Redis connections `initRealtime`
opens per container — deliberate, and budgeted for under "Redis" in
[2.3](#23-problem-3--database-connections-and-redis).

**3. Gate the exception-sweep timer behind an env flag.** `index.ts:595` arms it
unconditionally — there is no equivalent of `REPORT_SCHEDULER` for it. So a
deployment that drives sweeps externally cannot turn the in-process one off, and
the Fargate task duplicates the EventBridge work every 30 minutes. It is safe
(idempotent) but wasteful, and it competes with socket fan-out for that task's CPU.
```ts
if (process.env.IN_PROCESS_SWEEPS !== "false") { /* setInterval(...) */ }
```

**4. Decouple `WarmReportingSchema()` from `REPORT_SCHEDULER`.**
`index.ts:538` gates the DDL warm-up on the same flag that arms the timer. That
coupling is deliberate and well-reasoned for a single-process deploy, but it means
an externally-driven report sweep must set `REPORT_SCHEDULER=true` and thereby arm
a timer it does not want. A second flag (`WARM_REPORTING_SCHEMA`) defaulting to
the current behaviour would separate them.

**5. Make `openTenantConnection` transaction-safe — the big one.**
`database_supabase.ts:1502` sets the RLS GUCs with `set_config(..., false)`
(session-level) outside a transaction and holds them for the request. That is the
single reason this application cannot use Supabase's **transaction** pooler, and
therefore the reason `PG_POOL_MAX=1` plus a hard concurrency cap is necessary.
`withTenant` at `database_supabase.ts:1457` already shows the transaction-safe
shape (`set_config(..., true)` inside `BEGIN`). Moving the request path to the
same pattern would let you use port 6543, drop the concurrency ceiling and let the
function actually scale. It is not a small change — the request-scoped connection
currently spans the whole handler chain and would need to become a transaction
that commits at `res.finish` — but it is the change that makes Lambda make sense.
Note that `withPlatformAdvisoryLock` (`platform/db.ts:47`) would also need to move
from `pg_try_advisory_lock` to `pg_try_advisory_xact_lock`.

**6. Set `keepAlive: true` on all three pg pools.** `database_supabase.ts:123`
(primary), `database_supabase.ts:131` (IPv4 fallback) and `platform/db.ts:15`. Helps detect sockets that died while a Lambda container was
frozen, instead of discovering it on the next query.

**7. Pass `tesseract.js` an explicit `cachePath`.** ~~The image does not ship the
OCR model~~ — **it does now**; both build targets copy `eng.traineddata` to the
container's working directory (`/var/task` for Lambda, `/app` for the realtime
task). The remaining item is smaller than the original note claimed, and the
original note had the mechanism wrong, so both are corrected here.

What actually happens: `routes/valet.ts:47` calls `createWorker("eng")` with no
`cachePath`, and tesseract.js resolves its model as
`` `${cachePath || "."}/eng.traineddata` `` — i.e. relative to the **process
working directory**. With the file absent, the first scan in every container
downloaded 5.2 MB from the jsdelivr CDN; the write-back to the read-only
`/var/task` then failed and was **swallowed** (`worker-script/index.js`, the
`writeCache` try/catch), so the download repeated for the life of the container.
OCR was not disabled by that — the downloaded model is used from memory — but a
5.2 MB fetch plus worker start-up on a cold container is well inside range of the
30-second API Gateway integration timeout, which is what surfaces to a user as
"the scan gave up and I typed the plate in". (The WASM core is *not* downloaded:
`getCore` requires it from `node_modules/tesseract.js-core`.)

With the model now at the working directory the cache read hits on the first
scan, nothing is downloaded and nothing is written, so a read-only `/var/task` is
fine. The residual risk is that this relies on the process working directory
being `LAMBDA_TASK_ROOT`. To stop depending on that:
```ts
const worker = await createWorker("eng", undefined, { cachePath: "/var/task" });
```
or route `/valet/scan-plate` to the Fargate task with another CloudFront
behaviour. Either is a papercut fix, not an outage fix.

---

## 11. What is not covered, and what is genuinely uncertain

**Not deployed by this template:**

- **The Python feedback service** (`Python_servers/main.py`, a separate FastAPI
  app). Four routes proxy to `PY_SERVER_URL`, which defaults to
  `http://127.0.0.1:8000` and will refuse connections on Lambda. The main feedback
  question path **degrades gracefully** — routes/feedback.ts:114 catches the failure and
  returns a plain category-label question instead of a 500 — so the feedback form
  keeps working with less clever wording. `/get_all_valet_records` (routes/feedback.ts:258)
  is not similarly protected; check it if you use the web valet page. If you want
  the AI questions, deploy that service separately (App Runner suits it) and set
  `PY_SERVER_URL`.
- **The Next.js dashboard** (`Restaurant_Dashboard_UI`) and the feedback form
  inside it. Host them wherever you host them today; just set `AllowedOrigins`
  and `DashboardBaseUrl`.
- **Redis.** Deliberately external — see [2.3](#23-problem-3--database-connections-and-redis).

**Genuinely uncertain, stated plainly:**

- **Cold-start latency has not been measured.** The reasoning for 1024 MB is that
  Lambda scales CPU with memory and this module graph is unusually large — that is
  an argument, not a measurement. Measure `Duration` on cold invocations and tune.
  Note that awaiting `ensureRealtime()` ([2.1](#21-problem-1--websockets)) puts two
  Redis connects on that path, so measure after that change rather than before it.
  Lambda's init phase also has a 10-second budget; a slow Secrets Manager call plus
  this module graph can exceed it, which triggers a re-init billed against the
  invoke. Not fatal, but it is a thing you may see in the logs.
- **The cost table is directional.** Every number is a range because your traffic,
  region, log volume and image size all move it. Treat the shape (a ~$45–55 fixed
  floor from ALB + Fargate + their public IPv4 addresses, everything else
  usage-based) as the reliable part and the totals as a starting estimate.
- **Upstash pub/sub support is not verified here.** Run the `redis-cli` check in
  section 2.3 before choosing it.
- **The CloudFront managed policy IDs** (`CachingDisabled`,
  `AllViewerExceptHostHeader`, `AllViewer`) are AWS-published constants. If a
  deploy fails saying one does not exist, list the current ones:
  `aws cloudfront list-cache-policies --type managed`.
- **`OriginVerifySecret` is not a credential-grade secret.** It is `NoEcho` in the
  template and kept out of `samconfig.toml`, but it travels as a CloudFront origin
  custom header, so its plaintext value is readable by anyone who can call
  `cloudfront:GetDistributionConfig` on the distribution. That is acceptable for
  what it does — it stops the ALB's public DNS name being used to bypass
  CloudFront — and it is cheap to rotate (see `deploy/samconfig.toml`). Do not
  reuse it as anything else.
- **The CloudFront → ALB hop is HTTP, not HTTPS.** Session bearer tokens ride it.
  It is protected by the `X-Origin-Verify` shared secret against *access*, not
  against *interception*. To close it: put an ACM certificate on the ALB, add an
  HTTPS listener, and switch the origin to `https-only`. That needs a DNS name for
  the ALB and a second certificate, which is why it is not the default.
- **Whether a single Fargate task is enough** depends on how many printer agents
  connect and how chatty the fan-out is. The Redis adapter means scaling to 2 is
  safe for delivery — but read section 2.2 first, because a second task also
  doubles the in-process sweeps and the pg pool.

---

## 12. Day-2 operations

**Logs.**
```bash
aws logs tail /aws/lambda/cuisineflow-prod-backend --follow
aws logs tail /aws/lambda/cuisineflow-prod-sweeps  --follow
aws logs tail /ecs/cuisineflow-prod-realtime       --follow
```

**Alarms.** Five, all created by the template. None is wired to a notification —
add an SNS topic and subscribe your email, or they only exist in the console.

| Alarm | Means |
|---|---|
| `-lambda-errors` | the HTTP function is crashing or timing out |
| `-lambda-throttles` | concurrency cap reached; raise Supabase's pool size **first** |
| `-sweep-errors` | a scheduled sweep failed |
| `-sweep-dlq` | a sweep exhausted its retries — reminders/invoices are not happening |
| `-realtime-unhealthy` | **printing is down** |

**Rotating a credential.** Update the secret value, then force new containers —
secrets are read once per container, so a rotation does not take effect until the
containers are replaced:
```bash
aws secretsmanager put-secret-value --secret-id cuisineflow/prod \
  --secret-string file://app-secrets.json

rm app-secrets.json                              # same rule as §3: do not leave it lying around

aws lambda update-function-configuration \
  --function-name cuisineflow-prod-backend \
  --description "rotate $(date -u +%FT%TZ)"      # forces new containers
aws lambda update-function-configuration \
  --function-name cuisineflow-prod-sweeps \
  --description "rotate $(date -u +%FT%TZ)"      # the sweep function too
aws ecs update-service --cluster cuisineflow-prod-realtime \
  --service cuisineflow-prod-realtime --force-new-deployment
```
Do **not** do this with `QR_SIGNING_SECRET` — see [9.1](#91-qr_signing_secret--rotating-it-invalidates-every-printed-qr-code-everywhere-instantly).

**Hardening, once it is running.**

- Narrow `AlbSecurityGroup` from `0.0.0.0/0` to the AWS-managed
  `com.amazonaws.global.cloudfront.origin-facing` prefix list.
- Set `METRICS_TOKEN`. `GET /metrics` is in `PUBLIC_PATHS` (index.ts:274) and is
  reachable through CloudFront without it.
- Put an ACM certificate on the ALB and switch the CloudFront origin to
  `https-only` (see section 11).
- Consider AWS WAF on the distribution. The app has its own login rate limiter
  (`platformLoginAllowed`, platform/routes.ts:251), but that is application-layer.

**Updating the app.** Build and push new images with a new tag, then redeploy with
the new URIs. Both functions and the ECS service roll to the new image. Keep the
previous tag until you are confident — that is your rollback.
