-- Migration 042: server-decided print routing — destinations, rules, devices,
-- addresses, and the assignment columns that let ONE named machine own a docket.
--
-- ============================================================================
-- THE DEFECT THIS CLOSES
-- ============================================================================
-- Every print today is a BROADCAST. emitOutlet() puts the ESC/POS bytes into
-- `restaurant:<res>:outlet:<o>` and whoever is in that room prints them, so:
--
--   * "the bar's dockets should come out at the bar" is not expressible at all.
--     The closest thing that exists is a per-machine map inside
--     lib/services/printer_service.dart's SharedPreferences (_routesKeyPrefix),
--     which is a fact about ONE till. Two tills disagree silently, and the
--     restaurant's routing policy is whatever the till in front of you happens
--     to believe.
--   * a bill emitted into a room holding two configured devices prints TWICE.
--     That is a second charge slip in a guest's hand, and it is the reason
--     desktop-preferred bill printing was deferred out of 1.9.0 — there was no
--     server-side notion of "this machine, not that one" to hang it on.
--
-- This migration is the vocabulary for saying where something prints. It carries
-- NO behaviour on its own: an outlet with zero rows in "PrintRoutes" takes
-- exactly today's broadcast path, byte for byte. Routing arms per role, at the
-- moment a rule row is created.
--
-- ============================================================================
-- THREE LAYERS, AND THE ADDRESS ONLY EVER LIVES IN THE BOTTOM ONE
-- ============================================================================
--   "PrintDestinations"  a PLACE.  'Bar Printer'. Outlet-scoped, no address.
--   "PrintRoutes"        the RULES. role -> destination. THE grouping feature.
--   "PrintDevices"       the MACHINES that have signed in.
--   "PrintDeviceTargets" the ADDRESS: what THIS machine calls THAT place.
--
-- ============================================================================
-- WHY THERE IS NO "PrintGroups" TABLE
-- ============================================================================
-- The feature asked for is "put Bar, Cocktails and Juice on one printer". The
-- obvious shape is a group table with sections as members. It is not built,
-- because "PrintRoutes" ALREADY SAYS THAT: three rows, three roles, one shared
-- destination_id. The group is not a thing that has to be stored — it is what
-- you see when you read the rule set grouped by destination, which is exactly
-- how the configuration screen renders it.
--
-- A group table would be a SECOND SOURCE OF TRUTH for something the rules
-- already express, and the two would drift the first time anybody wrote one
-- without the other: a section in the group but with no route (prints nowhere,
-- falls to broadcast) or a route with no group membership (prints at the bar
-- while the screen swears it is ungrouped). There is no question a group table
-- answers that `SELECT ... FROM "PrintRoutes" GROUP BY destination_id` does not,
-- and ungrouping a section is one DELETE either way.
--
-- The cost, stated honestly: renaming a group is renaming its destination, and
-- there is nowhere to hang a group-level attribute (a colour, a note) without a
-- column on "PrintDestinations". Both are fine; both are cheaper than two
-- tables that have to agree.
--
-- ============================================================================
-- WHY THE ADDRESS LIVES ONLY IN "PrintDeviceTargets"
-- ============================================================================
-- A Windows spooler queue name ('EPSON TM-T82 Receipt') and a LAN address
-- ('tcp://192.168.1.50:9100') are facts about ONE MACHINE's view of the world.
-- The spooler name exists only on the PC that installed the driver; the IP is
-- routable only from that subnet. Migration 040's header already states this
-- principle for the routing map it deliberately did NOT add to "Restaurant":
-- "those are Windows spooler names, which are facts about one machine and are
-- stored on that machine".
--
-- This migration keeps that principle and makes it the schema's shape: the
-- restaurant-wide rule names a PLACE, and each machine says what it can reach.
-- So a destination bound by two devices IS the failover chain, `priority` is why
-- the office PC prints the bill and the tablet only covers for it (LOWER WINS;
-- windows=10, android=50), and desktop-preferred bill printing stops being a
-- special case and becomes a default row value.
--
-- Putting the address on "PrintDestinations" instead would have forced one of
-- two bad answers: either every machine must be able to reach every printer
-- (false the moment a tablet is on guest Wi-Fi), or the owner configures the
-- restaurant's policy by typing in a queue name that only one PC can resolve —
-- and nothing in the schema would say which PC that was.
--
-- ============================================================================
-- WHAT KEEPS A ROW INSIDE ITS OWN TENANT — AND WHY RLS IS NOT THAT THING
-- ============================================================================
-- The draft of this file declared every child reference as a single-column FK
-- ("PrintDeviceTargets".device_id -> "PrintDevices"(id)) and justified it with
-- "cross-tenant pointing is prevented by RLS, as everywhere else in this
-- schema". THAT SENTENCE WAS FALSE, and it was disproved on a real cluster
-- before this file ever reached production:
--
--   set app.res_id = '<tenant A>';
--   insert into "PrintDeviceTargets"(res_id, outlet_id, device_id, destination_id, target)
--   values ('<A>', '<A''s outlet>', '<TENANT B''s device id>', '<A''s destination>', 'tcp://...');
--   -- SUCCEEDS.
--
-- Two independent reasons, and both matter beyond this table:
--   1. The tenant_isolation policy's WITH CHECK tests res_id AND NOTHING ELSE.
--      It has no opinion about what the row's other uuid columns point at.
--   2. A referential-integrity check runs with row security OFF (it is executed
--      as the constraint's owner, in a security-restricted context). So the FK
--      happily FINDS tenant B's parent row that the same session's SELECT cannot
--      see. RLS hides rows from queries; it does not constrain foreign keys.
--
-- And the FK made it worse than a bare uuid would have: it added a cross-tenant
-- CASCADE. Tenant B deleting an old till silently deleted tenant A's binding,
-- dropping A's destination back to broadcast — "everything suddenly prints on
-- every printer" with nothing in A's own audit trail to explain it.
--
-- THE FIX, and it is the only one the schema can actually enforce: every child
-- reference is COMPOSITE and carries the tenant (and the outlet, where the
-- parent is outlet-scoped), so the FK itself is the isolation. That needs
-- matching composite UNIQUE constraints on the parents, which is why
-- "PrintDestinations" carries UNIQUE (id, res_id, outlet_id) and "PrintDevices"
-- carries UNIQUE (id, res_id) below. This is migration 039's shape verbatim
-- ("MenuVariations" references "Menu"(id, res_id, outlet_id), and its header
-- says so in the same words: "which also makes it impossible for a variation to
-- point across a tenant"), and 000's own Bills/Orders/Employees references are
-- all composite for the same reason.
--
-- 038's "tenant integrity is RLS's job, as everywhere else" — which the draft
-- cited — is about "Bills".counter_id, a column with NO foreign key at all. That
-- is a different claim: nothing there cascades, so a mis-pointed id is a dangling
-- attribution and not a delete on somebody else's configuration. The rule this
-- file follows: IF A COLUMN HAS AN FK AT ALL, THE FK CARRIES res_id.
--
-- The outlet half needs one thing the schema did not have: "Outlets" is keyed on
-- (id) alone, so nothing could reference (outlet_id, res_id). This migration adds
-- UNIQUE (id, res_id) to "Outlets" — free by construction (id is already the
-- primary key, so the pair cannot collide), an index build over a handful of
-- branch rows, and it is what stops a "PrintDestinations" row carrying tenant A's
-- res_id and tenant B's outlet_id. It is the only statement in this file that
-- touches a pre-existing table other than "PrintJobs", and it adds no behaviour
-- to it.
--
-- WHAT THIS CHANGES FOR THE ROUTE LAYER, so it is not discovered in production:
-- a binding or a rule that names a destination belonging to ANOTHER OUTLET now
-- raises 23503 (foreign_key_violation) instead of silently writing a rule that
-- can never fire and that the configuration screen renders as if it works. That
-- is the better failure, but it is a failure: the write routes should map 23503
-- on these tables to a 400 ("that printer belongs to another branch"), not to a
-- 500. The read/print path cannot hit it — it never inserts these rows.
--
-- ============================================================================
-- WHY "PrintRoutes".role REUSES THE CLIENT'S VOCABULARY, VERBATIM
-- ============================================================================
--   'bill' | 'kot' | 'kot:<STATION UPPERCASED>'
--
-- These are not new strings. They are PrintRole in
-- restaurant_owner_app/lib/services/printer_service.dart:80-103 — `bill`,
-- `anyKot = 'kot'`, and `kotStation(s) => 'kot:${s.trim().toUpperCase()}'` —
-- which is already the shipped wire contract for the device-local rules, is
-- already what every fielded till has in its SharedPreferences, and is already
-- what 32 pinned tests in test/printer_routing_test.dart describe.
--
-- Inventing a second spelling here (kind + station columns, or a lower-cased
-- role, or a station id) would mean two layers that mean the same thing and
-- agree only as long as somebody maintains the translation between them. That is
-- how "the bar docket printed at the pass" becomes an unanswerable question:
-- with one vocabulary you can put the client's own role string and the server's
-- rule row side by side and read the mismatch. Reusing it also makes the
-- migration path from device-local rules to restaurant-wide rules a straight
-- copy of a string the till is already holding, which is what lets the printer
-- screen offer "this till already sends Bar dockets to EPSON-Bar — set that up
-- for the whole restaurant?" as a PROPOSAL rather than a silent import.
--
-- The station half is stored UPPER-CASED because that is what kotStation()
-- mints and what the resolver matches ('kot:' + station.trim().toUpperCase()).
-- A row written as 'kot:Bar' is not an error the reader can see: it simply never
-- matches, the docket falls through to broadcast, and everything still prints —
-- badly. The unique index below folds case so the two spellings can never both
-- exist, but the WRITE path is what has to canonicalise, and it is the only
-- place that may.
--
-- ============================================================================
-- WHITESPACE: THE SCHEMA TAKES ONE POSITION, AND THIS IS IT
-- ============================================================================
-- THE CONTRACT: name / role / device_key / target are stored ALREADY TRIMMED.
-- Leading and trailing whitespace is not "insignificant" — it CANNOT EXIST, and
-- a `x = btrim(x)` CHECK on each of those columns is what makes that true.
--
-- The draft got this half-right and therefore wrong: the columns were CHECKed
-- with btrim() while the unique indexes folded with a bare lower(), so the file
-- held two positions at once. lower('  Bar  ') is '  bar  ', so '  Bar  ' and
-- 'Bar' both inserted happily — two destinations a human reads as identical,
-- with different bindings, which is precisely the split the index's own comment
-- claims to prevent. For a role it is worse and quieter: 'kot:BAR ' never equals
-- the resolver's 'kot:' + station.trim().toUpperCase(), so the docket falls
-- through to broadcast and still prints. Nobody reports paper that came out.
--
-- WHY THE CHECK AND NOT lower(btrim(...)) IN THE INDEX, which is the other way
-- to make them agree: the two upsert paths infer their conflict target by
-- expression — `on conflict (res_id, outlet_id, lower(name))`
-- (UpsertPrintDestination) and `on conflict (res_id, outlet_id, lower(role))`
-- (SetPrintRoutes). An index expression that no longer matches those makes both
-- statements raise 42P10 at runtime, which is a broken write path traded for a
-- fixed one. The CHECK closes the hole one level lower down: it holds for EVERY
-- writer, present and future, including the ones that forget to trim — and with
-- padding impossible, lower(name) IS lower(btrim(name)) for every row that can
-- exist, so the indexes are honest as written.
--
-- ============================================================================
-- THE ONE LINE TO CHANGE IF "MenuGroups" EVER BECOMES THE ROUTING AXIS
-- ============================================================================
-- Migration 039 added "MenuGroups" with kind='production' — Kitchen / Bar /
-- Bakery — described in its own header as "where it is MADE ... the axis a head
-- chef and a station-wise KOT care about". That is, in words, the same thing
-- `station` is. This migration does NOT route on it, for three reasons: it is
-- category-grained with a per-item override while `station` is per-item; it is
-- outlet-scoped while the grouping asked for is restaurant-wide; and it is
-- unpopulated for every existing tenant, so routing on it today would route
-- everything to nothing.
--
-- If that ever changes, "PrintRoutes".role IS THE SINGLE LINE. It is a text
-- discriminator resolved by one function; a group-keyed rule is 'group:<uuid>'
-- alongside the existing three, matched before the station fallback, and no
-- other table, index, policy or column in this migration moves. That is the
-- whole reason the axis is a string in one column rather than a foreign key.
--
-- THE HONEST COST OF NOT DOING IT NOW: the schema now has TWO taxonomies that
-- both mean "where is this dish made" — "Menu".description's `station`, which
-- routes paper, and "MenuGroups" kind='production', which cuts reports. A tenant
-- who configures one and not the other gets a correct answer from one of them
-- and silence from the other, and nothing in the database says they are supposed
-- to agree. The mitigation is a one-click "import from production groups" on the
-- printer screen (a convenience over GetMenuGroupAssignments, not a coupling),
-- and the acknowledgement that whoever converges these two later inherits a
-- reconciliation nobody has done yet.
--
-- ============================================================================
-- WHY NO FOREIGN KEY ON ANY DEVICE COLUMN OF "PrintJobs"
-- ============================================================================
-- assigned_device_id and printed_by_device point at "PrintDevices" rows and are
-- deliberately NOT declared as references.
--
-- printed_by_device is SETTLED RECEIPT HISTORY: it is the record of which
-- machine printed a guest's bill, kept so "why did the bar docket print at the
-- pass?" has an answer months later. A device is a laptop that gets replaced. If
-- the column were a FK, removing a retired till would either cascade — deleting
-- the print history of every receipt it ever produced — or refuse the delete
-- until somebody hunts down rows nobody wants to keep, which is how people end
-- up running the DELETE with the constraint dropped.
--
-- This is migration 038's rule verbatim ("No FK from "Bills".counter_id ... both
-- are historical attributions that must survive a counter being removed from a
-- tenant's configuration") and migration 027's ("DELIBERATELY NOT UNIQUE, and
-- deliberately not a FK") applied to the same table for the same reason.
-- assigned_device_id gets the same treatment because it is the same id in a
-- shorter-lived state, and a referential check on the insert of every KOT ticket
-- buys nothing the application — which only ever writes an id it just read out
-- of a chain it just built — does not already guarantee.
--
-- Note the asymmetry with the section above, because the two rules read as
-- contradictory and are not: a column with NO FK cannot cascade across a tenant,
-- so a mis-pointed id there is a dangling attribution and nothing more. It is
-- only once a column HAS a foreign key that the key must carry res_id.
--
-- "PrintDeviceTargets" DOES cascade from "PrintDevices" and "PrintDestinations",
-- and that is the opposite call for the opposite reason: a binding is live
-- CONFIGURATION, not history. An address for a machine that no longer exists is
-- not a record of anything — it is a candidate the resolver would keep offering
-- jobs to. The visible consequence is named in the design and repeated here so
-- nobody reports it as a bug: DELETE a device and every destination it was the
-- only binding for resolves to broadcast again, i.e. "everything prints on every
-- printer" — correct, and why retire-don't-delete and "Replace with..." exist.
--
-- ============================================================================
-- NOT CREATED LAZILY, AND THAT IS NOT NEGOTIABLE HERE
-- ============================================================================
-- ensureLazyTable (database_supabase.ts) SWALLOWS 42501 AND MEMOISES SUCCESS: a
-- `create table if not exists` issued at runtime under app_runtime, which holds
-- DML only and has USAGE but not CREATE on public (002:28-30), returns "fine"
-- having created nothing, and the next SELECT raises 42P01 for the life of the
-- process. Migration 026's header records the outage that pattern caused;
-- 027/029/033/038/039 each repeat the rule. The four tables below come from this
-- file and only this file.
--
-- THE NINE COLUMNS ARE THE SAME STORY, and the draft of this header got it
-- wrong in a way worth spelling out, because it is the reason the boot probe
-- exists. ensurePrintRoutingColumns() re-issues the nine `add column if not
-- exists` statements at boot as belt and braces. In production that guard is a
-- GUARANTEED NO-OP: ALTER TABLE is not a grantable privilege in PostgreSQL at
-- all — it requires table OWNERSHIP, which app_runtime (NOSUPERUSER, DML grants
-- only, 002:18-30) does not have and cannot be granted. Every one of those
-- ALTERs raises `must be owner of table "PrintJobs"` — 42501, the very SQLSTATE
-- ensureLazyTable swallows and then memoises as success, so the catch and the
-- logger.warn wrapped around it can never fire either.
--
-- What actually decides whether routing arms is the boot probe
-- `select assigned_device_id from "PrintJobs" limit 0` (initPrintRoutingSchema),
-- which sets printRoutingSchemaReady and, when false, makes
-- ClaimPrintJobsForAgent issue 027's byte-identical SQL. THE COLUMNS COME FROM
-- THIS FILE. The ensure block is a convenience for a developer running as owner
-- against a local database and nothing else — and it runs at BOOT ONLY, never
-- from a print path, because ALTER TABLE wants ACCESS EXCLUSIVE and a print can
-- be issued from inside a settle's transaction.
--
-- text + CHECK rather than Postgres enums, per 024. Every statement is
-- idempotent and the whole file re-runs clean. The DROP ... IF EXISTS lines
-- below are for one specific case: a scratch database that ran the DRAFT of this
-- migration, whose CREATE TABLE IF NOT EXISTS would otherwise skip and leave the
-- old constraint set in place. On a database that has never seen 042 they are
-- no-ops, and production has never seen 042.

-- ---------------------------------------------------------------------------
-- LAYER 1 — the PLACE. No address, ever. Outlet-scoped because a printer is a
-- physical object standing in one branch, and an address that is meaningful in
-- Bandra is meaningless in Andheri.
--
-- outlet_id carries no inline REFERENCES: its foreign key is composite
-- (outlet_id, res_id) and is declared once, in the tenant-key section below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PrintDestinations" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  res_id      uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id   uuid NOT NULL,

  -- What the owner reads on the routing screen and in the route trace. This is
  -- the only human-facing name in the whole feature; the machines' labels are
  -- for identifying hardware, not for saying where paper comes out.
  name        text NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 0,
  -- DEACTIVATION, NOT DELETION (038's rule). Deleting a destination cascades its
  -- rules and its bindings away; setting it inactive keeps the configuration
  -- intact for the week the bar printer is out for repair.
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Stamped by the writer, not by a trigger — there is no updated_at trigger
  -- anywhere in this schema and adding one for this table alone would be a
  -- convention of one.
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive per outlet, for migration 039's reason: 'Bar Printer' and
-- 'bar printer' as two destinations would split one printer's rules in two and
-- the owner would see two identical-looking rows with different bindings.
-- lower(name) and not lower(btrim(name)) on purpose — see WHITESPACE in the
-- header: padding is impossible by CHECK, and UpsertPrintDestination's
-- `on conflict (res_id, outlet_id, lower(name))` has to keep matching this
-- expression exactly or every destination save raises 42P10.
CREATE UNIQUE INDEX IF NOT EXISTS printdestinations_name_idx
  ON "PrintDestinations" (res_id, outlet_id, lower(name));

-- ---------------------------------------------------------------------------
-- LAYER 2 — THE RULE SET. This IS the grouping feature; see the header for why
-- there is no group table. "Bar + Cocktails + Juice on one printer" is three
-- rows sharing destination_id.
--
-- outlet_id and destination_id carry no inline REFERENCES: both keys are
-- composite and are declared once, in the tenant-key section below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PrintRoutes" (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  res_id         uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id      uuid NOT NULL,

  -- 'bill' | 'kot' | 'kot:<STATION UPPERCASED>' — PrintRole in
  -- printer_service.dart:80-103, unchanged. See the header. NO CHECK on the SET
  -- of legal roles, deliberately: the resolver already treats an unmatched role
  -- as "no rule, broadcast", so a malformed row degrades to today's behaviour,
  -- and a constraint here would turn a future role ('group:<uuid>', see the
  -- header) into a schema change instead of a resolver change. The trim CHECK
  -- below is a different thing and is not optional: an untrimmed role is not a
  -- future spelling, it is a rule that silently never matches.
  role           text NOT NULL CHECK (btrim(role) <> ''),
  destination_id uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ONE rule per role per outlet — a role that resolved to two destinations would
-- have to mean either "print twice" (the exact defect this feature exists to
-- remove) or "pick one", and there is no non-arbitrary way to pick. Fan-out is
-- expressed the other way round: many roles, one destination.
-- lower(role) so 'kot:BAR' and 'kot:bar' cannot both exist; the write path is
-- still what has to canonicalise, because only the upper-cased spelling is ever
-- MATCHED (header, and printer_service.dart:87). Padding is handled by the
-- column CHECK, not here — SetPrintRoutes infers `on conflict (res_id,
-- outlet_id, lower(role))` against this exact expression.
CREATE UNIQUE INDEX IF NOT EXISTS printroutes_role_idx
  ON "PrintRoutes" (res_id, outlet_id, lower(role));

-- "which rules point at this place?" — the configuration screen's read, and the
-- index the ON DELETE CASCADE from "PrintDestinations" uses. Without it every
-- destination delete sequential-scans this table. Cheap either way at
-- configuration size; present because a cascade with no supporting index is the
-- kind of thing that is only ever noticed by the person who adds the millionth
-- row.
CREATE INDEX IF NOT EXISTS printroutes_dest_idx
  ON "PrintRoutes" (res_id, outlet_id, destination_id);

-- ---------------------------------------------------------------------------
-- LAYER 3a — THE MACHINE REGISTRY.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PrintDevices" (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  res_id         uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- The outlet this machine MOST RECENTLY registered under, and it is mutable.
  -- Not part of its identity: a manager's laptop that signs into the Bandra
  -- branch on Tuesday is the same laptop, and minting a second row for it would
  -- put a stale duplicate in the owner's device list forever. Composite FK
  -- (outlet_id, res_id) below — mutable, but only ever to one of THIS tenant's
  -- outlets.
  outlet_id      uuid NOT NULL,

  -- CLIENT-MINTED, and the identity. A ULID from the app's existing
  -- newIdempotencyKey() (outbox.dart), stored on the device and mirrored into
  -- SharedPreferences. Never derived from a hostname, MAC or platform: a second
  -- till of the same model must not silently inherit the first's jobs.
  device_key     text NOT NULL CHECK (btrim(device_key) <> ''),
  label          text,                                  -- 'Front till', owner-editable
  platform       text,                                  -- 'windows' | 'android' | 'other'
  agent_version  text,
  -- What THIS machine reported it can reach — spooler queue names it enumerated,
  -- network printers its own user configured. The bindings route REFUSES a
  -- target that is not in here, so the owner cannot bind an address from the
  -- office PC that the tablet has no way of resolving.
  capabilities   jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_target text,
  last_seen_at   timestamptz,
  -- RETIRE, DON'T DELETE. Retiring keeps the row out of every chain while
  -- leaving printed_by_device on old receipts resolvable to a name; deleting
  -- cascades the bindings away and drops the destination back to broadcast.
  retired_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- res_id-unique, NOT (res_id, outlet_id)-unique, and that is the point of the
-- outlet_id comment above: one machine, one row, whichever branch it signed into
-- last. RegisterPrintDevice infers `on conflict (res_id, device_key)` against
-- this index.
--
-- This is also the index that carries the cascade from "Restaurant". The cascade
-- from "Outlets" is the ONE referential path in this migration with no index
-- behind it — deleting a branch sequential-scans this table — and that is
-- accepted rather than overlooked: a device registry is configuration-sized, and
-- deleting an outlet is a once-in-the-life-of-a-tenant admin action, not a
-- service-time one. Every other cascade here has an index named beside it.
CREATE UNIQUE INDEX IF NOT EXISTS printdevices_key_idx
  ON "PrintDevices" (res_id, device_key);

-- ---------------------------------------------------------------------------
-- LAYER 3b — THE ADDRESS. Written only by the device that owns it, via
-- PUT /print/devices/me/targets. See the header for why it lives nowhere else.
--
-- device_id and destination_id carry no inline REFERENCES: both keys are
-- composite (they carry res_id, and destination_id also carries outlet_id) and
-- are declared once, in the tenant-key section below. That is what stops one
-- tenant's "delete this old till" from cascading into another tenant's bindings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PrintDeviceTargets" (
  res_id         uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- The DESTINATION's outlet, which the composite FK below now forces it to be.
  -- A binding is an address for a place, and a place stands in one branch; the
  -- device's own outlet_id is a different fact and may differ from this one.
  outlet_id      uuid NOT NULL,
  device_id      uuid NOT NULL,
  destination_id uuid NOT NULL,

  -- 'EPSON TM-T82 Receipt' (a Windows spooler queue) or 'tcp://192.168.1.50:9100'
  -- (a LAN address). Meaningful only from device_id's machine.
  target         text NOT NULL CHECK (btrim(target) <> ''),
  -- LOWER WINS. windows=10, android=50 by default, so a destination bound by a
  -- desk PC and a tablet prefers the PC and the tablet is the failover — which
  -- is the whole of "desktop-preferred bill printing", expressed as a default
  -- rather than as a special case in the dispatcher.
  priority       smallint NOT NULL DEFAULT 50,
  active         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One address per (machine, place). A machine reaching one printer by two
  -- addresses is one of them being wrong, and the chain builder would have no
  -- way to choose. SetPrintDeviceTargets infers its ON CONFLICT against this
  -- primary key.
  PRIMARY KEY (res_id, outlet_id, device_id, destination_id)
);

-- The chain read: "who can serve this destination, best first", issued once per
-- print action.
--
-- NOT partial on `active`, though the chain read filters on it and the draft was.
-- A `WHERE active` index cannot serve the referential check behind
-- "PrintDestinations"' ON DELETE CASCADE, which has to find the INACTIVE rows
-- too, so the partial version left every destination delete sequential-scanning
-- this table. One unpartial index serves both; the active filter costs a cheap
-- recheck on a handful of rows.
--
-- The DO block is the draft-database case again: CREATE INDEX IF NOT EXISTS
-- matches on NAME, so a scratch database carrying the draft's `WHERE active`
-- version would silently keep it. Drop it only when it is the partial one, so a
-- re-run of this file against a correct database rebuilds nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index
              WHERE indexrelid = to_regclass('public.printdevicetargets_dest_idx')
                AND indpred IS NOT NULL) THEN
    EXECUTE 'DROP INDEX printdevicetargets_dest_idx';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS printdevicetargets_dest_idx
  ON "PrintDeviceTargets" (res_id, outlet_id, destination_id);

-- The device side of the same argument: the cascade from "PrintDevices", and
-- ReplacePrintDevice's `where t.res_id = $1 and t.device_id = $2`, which skips
-- outlet_id and therefore cannot use the primary key's prefix.
CREATE INDEX IF NOT EXISTS printdevicetargets_device_idx
  ON "PrintDeviceTargets" (res_id, device_id);

-- ---------------------------------------------------------------------------
-- TENANT KEYS — the composite UNIQUEs the child references need, then the
-- references themselves. See "WHAT KEEPS A ROW INSIDE ITS OWN TENANT" above:
-- these ARE the isolation for these tables. RLS hides rows from queries; a
-- foreign key check runs with row security off and will happily find another
-- tenant's parent.
--
-- Written as pg_constraint-guarded ALTERs rather than inline in the CREATE
-- TABLEs, in 000's exact idiom, for one reason: CREATE TABLE IF NOT EXISTS is a
-- no-op on a database that ran the draft of this migration, and an inline
-- constraint would silently not be added there — the one place this file could
-- lie about what it enforces. Each constraint is defined in exactly one place,
-- so there is nothing to drift.
-- ---------------------------------------------------------------------------

-- Draft cleanup: the single-column references the draft declared. Dropping them
-- is what removes the cross-tenant CASCADE path proven above; on a database that
-- never ran the draft (i.e. production) every line here is a no-op.
ALTER TABLE "PrintDestinations"  DROP CONSTRAINT IF EXISTS "PrintDestinations_outlet_id_fkey";
ALTER TABLE "PrintRoutes"        DROP CONSTRAINT IF EXISTS "PrintRoutes_outlet_id_fkey";
ALTER TABLE "PrintRoutes"        DROP CONSTRAINT IF EXISTS "PrintRoutes_destination_id_fkey";
ALTER TABLE "PrintDevices"       DROP CONSTRAINT IF EXISTS "PrintDevices_outlet_id_fkey";
ALTER TABLE "PrintDeviceTargets" DROP CONSTRAINT IF EXISTS "PrintDeviceTargets_outlet_id_fkey";
ALTER TABLE "PrintDeviceTargets" DROP CONSTRAINT IF EXISTS "PrintDeviceTargets_device_id_fkey";
ALTER TABLE "PrintDeviceTargets" DROP CONSTRAINT IF EXISTS "PrintDeviceTargets_destination_id_fkey";

DO $$
BEGIN
  -- "Outlets" is keyed on (id) alone, so nothing in this schema could reference
  -- (outlet_id, res_id). This makes that possible. It cannot fail and it cannot
  -- reject an existing row: id is already the primary key, so (id, res_id) is
  -- unique for free. Cost is one index over a tenant's branches.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'outlets_id_res_id_key'
                    AND conrelid = '"Outlets"'::regclass) THEN
    ALTER TABLE "Outlets" ADD CONSTRAINT outlets_id_res_id_key UNIQUE (id, res_id);
  END IF;

  -- A destination is outlet-scoped, so its children reference all three columns:
  -- a rule or a binding cannot point at another tenant's destination, and cannot
  -- point at a destination in another BRANCH of its own tenant either. The
  -- second half is what stops "Bar dockets -> Bar Printer" reading as a live
  -- rule on the screen while the chain read (which filters outlet_id) finds
  -- nothing and every bar docket broadcasts.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdestinations_tenant_key'
                    AND conrelid = '"PrintDestinations"'::regclass) THEN
    ALTER TABLE "PrintDestinations"
      ADD CONSTRAINT printdestinations_tenant_key UNIQUE (id, res_id, outlet_id);
  END IF;

  -- A device is restaurant-scoped (its outlet_id is mutable, see LAYER 3a), so
  -- its children carry res_id and not outlet_id.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevices_tenant_key'
                    AND conrelid = '"PrintDevices"'::regclass) THEN
    ALTER TABLE "PrintDevices"
      ADD CONSTRAINT printdevices_tenant_key UNIQUE (id, res_id);
  END IF;
END $$;

DO $$
BEGIN
  -- Outlet references. ON DELETE CASCADE matches every other outlet-scoped table
  -- (038, 039): configuration for a branch that no longer exists is not history.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdestinations_outlet_fk'
                    AND conrelid = '"PrintDestinations"'::regclass) THEN
    ALTER TABLE "PrintDestinations"
      ADD CONSTRAINT printdestinations_outlet_fk
      FOREIGN KEY (outlet_id, res_id) REFERENCES "Outlets" (id, res_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printroutes_outlet_fk'
                    AND conrelid = '"PrintRoutes"'::regclass) THEN
    ALTER TABLE "PrintRoutes"
      ADD CONSTRAINT printroutes_outlet_fk
      FOREIGN KEY (outlet_id, res_id) REFERENCES "Outlets" (id, res_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevices_outlet_fk'
                    AND conrelid = '"PrintDevices"'::regclass) THEN
    ALTER TABLE "PrintDevices"
      ADD CONSTRAINT printdevices_outlet_fk
      FOREIGN KEY (outlet_id, res_id) REFERENCES "Outlets" (id, res_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevicetargets_outlet_fk'
                    AND conrelid = '"PrintDeviceTargets"'::regclass) THEN
    ALTER TABLE "PrintDeviceTargets"
      ADD CONSTRAINT printdevicetargets_outlet_fk
      FOREIGN KEY (outlet_id, res_id) REFERENCES "Outlets" (id, res_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  -- A rule pointing at a deleted place is not history, it is a rule that can
  -- never fire. Contrast "PrintJobs".printed_by_device in the header.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printroutes_destination_fk'
                    AND conrelid = '"PrintRoutes"'::regclass) THEN
    ALTER TABLE "PrintRoutes"
      ADD CONSTRAINT printroutes_destination_fk
      FOREIGN KEY (destination_id, res_id, outlet_id)
      REFERENCES "PrintDestinations" (id, res_id, outlet_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  -- The two the cross-tenant proof was written against.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevicetargets_device_fk'
                    AND conrelid = '"PrintDeviceTargets"'::regclass) THEN
    ALTER TABLE "PrintDeviceTargets"
      ADD CONSTRAINT printdevicetargets_device_fk
      FOREIGN KEY (device_id, res_id) REFERENCES "PrintDevices" (id, res_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevicetargets_destination_fk'
                    AND conrelid = '"PrintDeviceTargets"'::regclass) THEN
    ALTER TABLE "PrintDeviceTargets"
      ADD CONSTRAINT printdevicetargets_destination_fk
      FOREIGN KEY (destination_id, res_id, outlet_id)
      REFERENCES "PrintDestinations" (id, res_id, outlet_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  -- THE WHITESPACE CONTRACT, enforced. See the header for why this lives on the
  -- column and not in the index expression. Every current writer already trims
  -- (UpsertPrintDestination, canonicalPrintRole, RegisterPrintDevice,
  -- SetPrintDeviceTargets), so this rejects nothing that is written today — it
  -- is the guard the NEXT writer inherits.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdestinations_name_trimmed_chk'
                    AND conrelid = '"PrintDestinations"'::regclass) THEN
    ALTER TABLE "PrintDestinations"
      ADD CONSTRAINT printdestinations_name_trimmed_chk CHECK (name = btrim(name));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printroutes_role_trimmed_chk'
                    AND conrelid = '"PrintRoutes"'::regclass) THEN
    ALTER TABLE "PrintRoutes"
      ADD CONSTRAINT printroutes_role_trimmed_chk CHECK (role = btrim(role));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevices_key_trimmed_chk'
                    AND conrelid = '"PrintDevices"'::regclass) THEN
    ALTER TABLE "PrintDevices"
      ADD CONSTRAINT printdevices_key_trimmed_chk CHECK (device_key = btrim(device_key));
  END IF;

  -- A target with a trailing space is a spooler queue name that resolves to
  -- nothing and a tcp:// address that parses to nothing — the same silent
  -- never-matches failure as an untrimmed role, one layer further down.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'printdevicetargets_target_trimmed_chk'
                    AND conrelid = '"PrintDeviceTargets"'::regclass) THEN
    ALTER TABLE "PrintDeviceTargets"
      ADD CONSTRAINT printdevicetargets_target_trimmed_chk CHECK (target = btrim(target));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- "PrintJobs" — the assignment columns. Additive; every one is NULL or its
-- default on every existing row, and a backend that predates this migration
-- reads and writes the table exactly as it did (027 unchanged).
--
-- Nullable columns with no default and NOT NULL columns with a CONSTANT default
-- are both catalogue-only in PostgreSQL 11+, so none of these rewrites the
-- table (041's note).
-- ---------------------------------------------------------------------------
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS assigned_device_id uuid;
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS assigned_target    text;
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS destination_id     uuid;

-- THE DEADLINE, and also the 027 lease: EnqueuePrintJob writes claimed_until
-- from this same value, one clock.
--
-- WHAT A LAPSED DEADLINE ACTUALLY BUYS — stated precisely, because the draft of
-- this file claimed "fair game to any device on its next reconnect, with no
-- coordinator involved" and a reviewer disproved it against the code:
--
--   A lapsed assignment is fair game to any device THAT SUPPLIES A REGISTERED
--   deviceId.
--
-- ClaimPrintJobsForAgent builds its routing clause two ways. With a deviceId it
-- is `(assigned_device_id is null or assigned_device_id = $n or
-- assign_expires_at < now())` — that third branch is the reconnect door. With a
-- NULL agentDeviceId it collapses to a flat `and assigned_device_id is null`,
-- and the C# agent (its joinOutlet carries no device block at all) plus every
-- client that has not called POST /print/devices/register ARE that NULL case. A
-- device-less printer cannot see a lapsed assignment; the column this migration
-- added is what filters it out.
--
-- THE ONE STRANDED CASE, named so nobody has to rediscover it at 2am: the
-- escalation ladder is IN-PROCESS — a per-job setTimeout plus a 60s sweep over
-- that same in-memory registry, deliberately not a database scan (print_routing.ts
-- explains why: a per-tenant query on a short timer against a 15-slot session
-- pooler is the 2026-08-24 standstill). If the dispatching replica dies
-- mid-ladder AND the only printer still connected to that outlet is device-less,
-- nothing can reach the row. It is not pending-to-everyone, not failed, not
-- broadcast: it is assigned to a machine that is off, and MarkPrintJobBroadcast —
-- the only writer that nulls assigned_device_id and re-opens the row to the
-- outlet — never runs. The row sits until the 15-minute reaper's TTL cutoff marks
-- it 'expired' and logs print_jobs_expired_undelivered. That is a record, not
-- paper.
--
-- NOT FIXED IN THIS FILE, and this is the note for whoever fixes it: the fix is a
-- statement, not an index — a per-tenant reclaim, on a slow timer and only for
-- outlets that have routes, of rows where status in ('pending','delivered') and
-- assigned_device_id is not null and assign_expires_at < now() - grace, nulling
-- assigned_device_id through the existing MarkPrintJobBroadcast CAS and
-- re-emitting on the broadcast rung. Ship the index it wants in that same commit
-- (see below). Until then, this column's expiry is a door for registered devices
-- and nothing more.
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS assign_expires_at  timestamptz;
-- THE FENCE. Every reassignment's compare-and-swap is `and assign_generation =
-- $n`, so two replicas racing to escalate the same job produce exactly one
-- winner and one no-op, and a late 'failed' ack from a superseded assignee is
-- recognisable as stale instead of stomping the live assignment.
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS assign_generation  smallint NOT NULL DEFAULT 0;
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS assign_accepted_at timestamptz;
-- Every device that has already said no to this job — rejected it, or acked
-- 'failed' after exhausting its own three attempts. This is what turns 027's
-- terminal-for-the-JOB 'failed' into terminal-for-the-DEVICE without losing
-- 027's actual rule: "replaying to a printer that already refused it three times
-- just loops" survives, because a device in here is never offered it again.
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS failed_devices     jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS printed_by_device  uuid;
-- Stamped when the ladder gave up and fell back to today's outlet-wide emit. Its
-- presence on a row is the audit trail for "this one printed on everything", and
-- its absence across a service is the evidence that routing is actually routing.
ALTER TABLE "PrintJobs" ADD COLUMN IF NOT EXISTS broadcast_at       timestamptz;

COMMENT ON COLUMN "PrintJobs".assigned_device_id IS
  'The "PrintDevices".id currently holding this job. NO FK, deliberately: a retired machine must not cascade into receipt history (see migration 042 header, 038''s rule). NULL = broadcast job, which is the entire pre-042 row set, and the only set a device-less agent can claim.';
COMMENT ON COLUMN "PrintJobs".printed_by_device IS
  'Which machine reported it printed this. Settled receipt history, set server-side from the row''s assigned_device_id and never from a request body. NO FK, for the same reason as assigned_device_id.';

-- THE INDEX THAT IS DELIBERATELY NOT HERE.
--
-- The draft created printjobs_assign_idx on (res_id, outlet_id,
-- assign_expires_at) WHERE status IN ('pending','delivered') AND
-- assigned_device_id IS NOT NULL — an index shaped for the reclaim sweep
-- described three paragraphs up, which does not exist. The only statement in the
-- tree that reads assign_expires_at in a WHERE clause is
-- ClaimPrintJobsForAgent, and it orders by (created_at asc, seq asc) and is
-- served by 027's printjobs_outstanding_idx; EXPLAIN on a migrated cluster never
-- considers the new index at all.
--
-- A dead index is not free on this table. "PrintJobs" is the hottest table in the
-- print path: every docket is an INSERT and every claim, ack, accept and
-- reassignment is an UPDATE of a live row, and each one would maintain it for no
-- reader. Its build is worse than it looks, too — a PARTIAL index evaluates its
-- predicate per heap tuple, so building it reads the WHOLE table, including every
-- settled row 027's retention still holds and the base64 ESC/POS blobs (logo
-- rasters included) they carry, under ACCESS EXCLUSIVE for the length of the
-- manual root-only migrate on the live VPS. The draft's own comment said the
-- opposite ("the scan is over one table whose live set is small") — the live set
-- is what the finished index HOLDS, not what the build READS.
--
-- Add it in the same commit as the sweep, and size the lock window first:
--   SELECT count(*), pg_size_pretty(pg_total_relation_size('"PrintJobs"'));
DROP INDEX IF EXISTS printjobs_assign_idx;

-- ---------------------------------------------------------------------------
-- RLS, in migration 003's exact policy form. Migration 003 applies RLS by a
-- dynamic loop over information_schema.columns (003:30-45) which does not
-- retro-cover tables created later, so this is not redundant — and it matters
-- here because these rows are a tenant's floor plan and their machines' network
-- addresses. "PrintJobs" was already covered by 027 and is untouched.
--
-- RLS is the READ boundary and nothing more. What stops a row from POINTING
-- across tenants is the composite keys above; see the header for the insert that
-- proves the difference.
-- ---------------------------------------------------------------------------
ALTER TABLE "PrintDestinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintDestinations" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintDestinations";
CREATE POLICY tenant_isolation ON "PrintDestinations"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

ALTER TABLE "PrintRoutes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintRoutes" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintRoutes";
CREATE POLICY tenant_isolation ON "PrintRoutes"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

ALTER TABLE "PrintDevices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintDevices" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintDevices";
CREATE POLICY tenant_isolation ON "PrintDevices"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

ALTER TABLE "PrintDeviceTargets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintDeviceTargets" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintDeviceTargets";
CREATE POLICY tenant_isolation ON "PrintDeviceTargets"
  USING      (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- ---------------------------------------------------------------------------
-- Grants. 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role
-- that set it, so spell them out — a migration run under a different owner would
-- otherwise leave the runtime unable to read the tables it just gained.
-- (023's / 027's / 033's / 041's exact guard.)
--
-- NO SEQUENCE GRANT HERE, and that is not an omission. Migration 027 needed one
-- because "PrintJobs".seq is a bigserial and INSERT on a table is not enough to
-- use the sequence behind it (42501 on every print insert). Every key in this
-- migration is a uuid from gen_random_uuid(), which owns no sequence, so there
-- is nothing to grant. If a bigserial is ever added to one of these tables, 027's
-- pg_get_serial_sequence block has to come with it.
--
-- NO PER-COLUMN PRIVILEGES either: column privileges are not granted anywhere in
-- this schema (grants are table-level, 002:28-30), so the nine columns added to
-- "PrintJobs" above need no further grant. Stated so the omission reads as
-- intentional (040's closing note).
--
-- NO GRANT ON "Outlets": the composite unique added to it above changes nothing
-- about who may read or write it, and app_runtime's existing grants are 002's.
-- A foreign key check does not need any privilege on the parent table.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintDestinations"  TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintRoutes"        TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintDevices"       TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintDeviceTargets" TO app_runtime;
    -- Re-asserted rather than assumed: 027 granted it, but a database branched
    -- or restored between 027 and now must not end up with a runtime that can
    -- write assignments to a table it cannot update.
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PrintJobs"          TO app_runtime;
  END IF;
END $$;

-- Verify:
--   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--    WHERE relname IN ('PrintDestinations','PrintRoutes','PrintDevices','PrintDeviceTargets');
--   -- expect t/t on all four
--
--   SET app.res_id = '<restaurantA-uuid>'; SELECT count(*) FROM "PrintDestinations";
--   SET app.res_id = '<restaurantB-uuid>'; SELECT count(*) FROM "PrintDestinations";
--   -- expect each tenant to see only its own; RESET app.res_id -> 0
--
-- THE CROSS-TENANT PROBE, as app_runtime with app.res_id = tenant A. Each of
-- these SUCCEEDED against the draft and must now raise 23503:
--   INSERT INTO "PrintDeviceTargets"(res_id,outlet_id,device_id,destination_id,target)
--   VALUES ('<A>','<A-outlet>','<B''s PrintDevices.id>','<A''s destination>','tcp://x');
--   INSERT INTO "PrintRoutes"(res_id,outlet_id,role,destination_id)
--   VALUES ('<A>','<A-outlet>','bill','<B''s destination>');
--   INSERT INTO "PrintDestinations"(res_id,outlet_id,name)
--   VALUES ('<A>','<B''s outlet>','Smuggled');
-- And the same-tenant wrong-branch case, which must also raise 23503:
--   INSERT INTO "PrintRoutes"(res_id,outlet_id,role,destination_id)
--   VALUES ('<A>','<A-outlet-2>','bill','<destination in A-outlet-1>');
--
-- THE WHITESPACE PROBE — both must raise 23514, not insert a twin:
--   INSERT INTO "PrintDestinations"(res_id,outlet_id,name) VALUES ('<A>','<A-outlet>','  Bar  ');
--   INSERT INTO "PrintRoutes"(res_id,outlet_id,role,destination_id)
--   VALUES ('<A>','<A-outlet>','kot:BAR ','<A''s destination>');
--
--   \d+ "PrintJobs"   -- expect the nine new columns and NO printjobs_assign_idx
