import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import type { RealtimeItem } from "@openai/agents/realtime";

loadEnv({ path: path.resolve(process.cwd(), "../.env") });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(
  __dirname,
  path.basename(__dirname) === "build" ? ".." : ".",
  "..",
);

const API_BASE_URL = process.env.RECEPTION_SERVER_URL ?? "http://localhost:3000";
const RESTAURANT_ID = process.env.RECEPTION_RESTAURANT_ID ?? "default";
const BOOKING_DURATION_MINUTES = Number.parseInt(
  process.env.RECEPTION_BOOKING_DURATION ?? "120",
  10,
);
const BOOKING_SOURCE = process.env.RECEPTION_BOOKING_SOURCE ?? "Voice";
export const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not configured. Realtime receptionist sessions are disabled.");
}

const reservationsCsvPath = path.resolve(repoRoot, "reservations.csv");

export type RestaurantInfoEntry = {
  field: string;
  value: string;
};

type AvailabilityStatus =
  | "available"
  | "unavailable"
  | "connectivity"
  | "validation";

type AvailabilityResult = {
  status: AvailabilityStatus;
  message: string;
  tables?: Array<{ tableName: string; capacity: number | null }>; // smallest-first order
};

type ReservationPayload = {
  guestName: string;
  contactNumber: string;
  partySize: number;
  reservationDate: string; // YYYY-MM-DD
  reservationTime: string; // HH:MM (24-hour)
  tablePreference?: string | null;
  specialRequests?: string | null;
};

type ReservationResult = {
  status: "confirmed" | "queued" | "failed";
  message: string;
  tableName?: string;
  referenceId?: string | null;
};

type RestaurantKnowledge = {
  infoEntries: RestaurantInfoEntry[];
  infoContext: string;
  openingTime: string;
  closingTime: string;
  timezone: string;
};

// Validate an IANA zone id; fall back to Asia/Kolkata for empty/invalid input.
function sanitizeTimezone(raw: unknown): string {
  const tz = typeof raw === "string" ? raw.trim() : "";
  if (!tz) return "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Kolkata";
  }
}

// Interpret Y-M-D h:mi as wall-clock time in `tz` and return the UTC instant
// (library-free, DST-safe). Mirrors zonedWallToUtc in database_supabase.ts.
function zonedWallToUtc(Y: number, M: number, D: number, h: number, mi: number, tz: string): Date {
  const utc = Date.UTC(Y, M - 1, D, h, mi);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = new Map<string, string>(dtf.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  const g = (t: string) => Number(p.get(t) ?? 0);
  const asUTC = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  const off = asUTC - utc;
  return new Date(utc - off);
}

// Wall-clock minutes-from-midnight of an instant AS SEEN in `tz` (so the
// operating-hours check stays correct on a non-local server).
function wallMinutesInZone(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return get("hour") * 60 + get("minute");
}

const fallbackRestaurantKnowledge: RestaurantKnowledge = {
  infoEntries: [],
  infoContext: "Restaurant knowledge file is unavailable.",
  openingTime: "12:00 PM",
  closingTime: "11:00 PM",
  timezone: "Asia/Kolkata",
};

function loadRestaurantKnowledge(): RestaurantKnowledge {
  const openingTime = process.env.RECEPTION_OPENING_TIME?.trim() || fallbackRestaurantKnowledge.openingTime;
  const closingTime = process.env.RECEPTION_CLOSING_TIME?.trim() || fallbackRestaurantKnowledge.closingTime;
  const timezone = sanitizeTimezone(process.env.RECEPTION_TIMEZONE);

  return {
    infoEntries: [],
    infoContext: "",
    openingTime,
    closingTime,
    timezone,
  };
}

const restaurantKnowledge = loadRestaurantKnowledge();

export function getRestaurantKnowledgeSnapshot(): RestaurantKnowledge {
  return {
    infoEntries: restaurantKnowledge.infoEntries.map((entry) => ({ ...entry })),
    infoContext: restaurantKnowledge.infoContext,
    openingTime: restaurantKnowledge.openingTime,
    closingTime: restaurantKnowledge.closingTime,
    timezone: restaurantKnowledge.timezone,
  };
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/[^0-9+]/g, "").trim();
}

function parseTimeString(value: string): string {
  const raw = value.trim().toLowerCase();
  const timeMatch = raw.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i,
  );
  if (!timeMatch) {
    throw new Error(
      `Expected a time in HH:MM format (optionally with AM/PM). Received: ${value}`,
    );
  }

  const hourText = timeMatch[1];
  if (hourText == null) {
    throw new Error(`Hour component could not be parsed from time: ${value}`);
  }
  const minuteText = timeMatch[2] ?? "0";
  const meridiem = timeMatch[3]?.toLowerCase();

  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);

  if (minute < 0 || minute > 59) {
    throw new Error(`Minute component is out of range in time: ${value}`);
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      throw new Error(`Hour component is out of range in time: ${value}`);
    }
    const normalizedHour = meridiem.startsWith("p")
      ? hour === 12
        ? 12
        : hour + 12
      : hour === 12
        ? 0
        : hour;
    return `${normalizedHour.toString().padStart(2, "0")}:${minute
      .toString()
      .padStart(2, "0")}`;
  }

  if (hour < 0 || hour > 23) {
    throw new Error(`Hour component must be 0-23 in time: ${value}`);
  }

  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

function toReservationDateTime(dateIso: string, timeValue: string, tz: string): Date {
  const trimmed = dateIso.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(
      `Reservation date must be provided as YYYY-MM-DD. Received: ${dateIso}`,
    );
  }
  const time24 = parseTimeString(timeValue); // "HH:MM" (24-hour)
  // The guest states a wall-clock date+time; interpret it in the restaurant's
  // timezone so the stored instant is correct regardless of the server's zone.
  const [Y, M, D] = trimmed.split("-").map(Number);
  const [hh, mi] = time24.split(":").map(Number);
  const combined = zonedWallToUtc(Y as number, M as number, D as number, hh as number, mi as number, sanitizeTimezone(tz));
  if (Number.isNaN(combined.getTime())) {
    throw new Error(`Unable to interpret reservation slot ${dateIso} ${timeValue}`);
  }
  return combined;
}

function minutesFromMidnight(timeLabel: string): number {
  const time24 = parseTimeString(timeLabel);
  const [hourText, minuteText] = time24.split(":");
  if (hourText == null || minuteText == null) {
    throw new Error(`Unable to parse minutes for ${time24}`);
  }
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  return hour * 60 + minute;
}

class ReservationService {
  private readonly openingMinutes: number | null;
  private readonly closingMinutes: number | null;

  constructor(private readonly info: RestaurantKnowledge) {
    this.openingMinutes = this.safeMinutes(info.openingTime);
    this.closingMinutes = this.safeMinutes(info.closingTime);
  }

  private safeMinutes(label: string): number | null {
    try {
      return minutesFromMidnight(label);
    } catch (error) {
      console.warn(
        `Unable to parse operating hour "${label}" – operating hour checks disabled for this bound`,
      );
      return null;
    }
  }

  isWithinOperatingHours(slot: Date): boolean {
    if (this.openingMinutes === null || this.closingMinutes === null) {
      return true;
    }
    const minutes = wallMinutesInZone(slot, this.info.timezone);
    if (this.closingMinutes < this.openingMinutes) {
      return minutes >= this.openingMinutes || minutes < this.closingMinutes;
    }
    return minutes >= this.openingMinutes && minutes < this.closingMinutes;
  }

  async determineAvailability(
    request: Pick<ReservationPayload, "partySize" | "reservationDate" | "reservationTime">,
  ): Promise<AvailabilityResult> {
    try {
      const slot = toReservationDateTime(request.reservationDate, request.reservationTime, this.info.timezone);
      if (!this.isWithinOperatingHours(slot)) {
        return {
          status: "validation",
          message: `That slot is outside our usual hours of ${this.info.openingTime} to ${this.info.closingTime}.`,
        };
      }

      const params = new URLSearchParams({
        time: slot.toISOString(),
        restaurantId: RESTAURANT_ID,
      });

      const response = await fetch(`${API_BASE_URL}/get-tables?${params.toString()}`, {
        headers: { "X-Restaurant-Id": RESTAURANT_ID },
      });

      if (!response.ok) {
        console.error("table_fetch_failed", response.status, await response.text());
        return {
          status: "connectivity",
          message:
            "I could not reach our booking system just now. Could we try again in a moment?",
        };
      }

      const tablesRaw = (await response.json()) as Array<{
        table_name?: string;
        name?: string;
        capacity?: number | null;
        booked?: boolean;
      }>;

      const tables = tablesRaw
        .filter((table) => !table.booked)
        .map((table) => ({
          tableName: table.table_name ?? table.name ?? "",
          capacity: table.capacity ?? null,
        }))
        .filter((entry) => Boolean(entry.tableName))
        .sort((a, b) => {
          const capacityA = a.capacity ?? Number.MAX_SAFE_INTEGER;
          const capacityB = b.capacity ?? Number.MAX_SAFE_INTEGER;
          if (capacityA !== capacityB) {
            return capacityA - capacityB;
          }
          return a.tableName.localeCompare(b.tableName);
        });

      const suitableTables = tables.filter((entry) => {
        if (entry.capacity == null) {
          return true;
        }
        return entry.capacity >= request.partySize;
      });

      if (suitableTables.length === 0) {
        return {
          status: "unavailable",
          message:
            "Every table that fits that group size is reserved at that time. Would another time work?",
          tables,
        };
      }

      const primaryTable = suitableTables[0];
      return {
        status: "available",
        message: primaryTable
          ? `I can hold ${primaryTable.tableName} for that slot.`
          : "A table is available for that time.",
        tables: suitableTables,
      };
    } catch (error) {
      console.error("availability_check_failed", error);
      return {
        status: "validation",
        message:
          error instanceof Error ? error.message : "I ran into an unexpected issue checking that slot.",
      };
    }
  }

  private ensureReservationCsv(): void {
    if (!fs.existsSync(reservationsCsvPath)) {
      const header = "Name,Contact,NumPeople,Time,TableType,BookingDate,FreeUpTime\n";
      fs.writeFileSync(reservationsCsvPath, header, { encoding: "utf-8" });
    }
  }

  private appendReservationCsv(payload: ReservationPayload, tableName: string, slot: Date): void {
    this.ensureReservationCsv();
    const freeUp = new Date(slot.getTime() + BOOKING_DURATION_MINUTES * 60 * 1000);
    const line = [
      JSON.stringify(payload.guestName),
      JSON.stringify(payload.contactNumber),
      JSON.stringify(String(payload.partySize)),
      JSON.stringify(`${slot.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}`),
      JSON.stringify(tableName),
      JSON.stringify(payload.reservationDate),
      JSON.stringify(freeUp.toISOString()),
    ].join(",");
    fs.appendFileSync(reservationsCsvPath, `${line}\n`, { encoding: "utf-8" });
  }

  private async commitReservationViaApi(
    payload: ReservationPayload,
    slot: Date,
    tableName: string,
  ): Promise<{ success: boolean; referenceId?: string | null }> {
    const body = {
      customer: {
        name: payload.guestName,
        number: payload.contactNumber,
      },
      booking: {
        table_name: tableName,
        date: slot.toISOString(),
        duration: BOOKING_DURATION_MINUTES,
        number_of_people: payload.partySize,
        source: BOOKING_SOURCE,
        status: "Confirmed",
        from: "voice-realtime-agent",
        notes: payload.specialRequests ?? null,
      },
      restaurantId: RESTAURANT_ID,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/add-booking`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Restaurant-Id": RESTAURANT_ID,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error("booking_api_failed", response.status, await response.text());
        return { success: false };
      }

      const responseBody = (await response.json()) as { id?: string };
      return { success: true, referenceId: responseBody?.id ?? null };
    } catch (error) {
      console.error("booking_api_exception", error);
      return { success: false };
    }
  }

  async createReservation(payload: ReservationPayload): Promise<ReservationResult> {
    try {
      const slot = toReservationDateTime(payload.reservationDate, payload.reservationTime, this.info.timezone);
      if (!this.isWithinOperatingHours(slot)) {
        return {
          status: "failed",
          message: `That time is just outside our service window of ${this.info.openingTime} to ${this.info.closingTime}.`,
        };
      }

      const availability = await this.determineAvailability({
        partySize: payload.partySize,
        reservationDate: payload.reservationDate,
        reservationTime: payload.reservationTime,
      });

      if (availability.status === "connectivity") {
        this.appendReservationCsv(payload, payload.tablePreference ?? "Unassigned", slot);
        return {
          status: "queued",
          message:
            "Our booking system was momentarily unreachable, so I logged the details for the team to add manually. We'll honour the reservation and confirm shortly.",
        };
      }

      if (availability.status === "unavailable" || !availability.tables?.length) {
        return {
          status: "failed",
          message:
            "I couldn't find an open table that fits that group at that time. I'm happy to look at another slot if you'd like!",
        };
      }

      const chosenTable = payload.tablePreference
        ? availability.tables.find((entry) => entry.tableName === payload.tablePreference) ??
          availability.tables[0]
        : availability.tables[0];

      if (!chosenTable) {
        return {
          status: "failed",
          message: "I wasn't able to identify a table to hold for that reservation.",
        };
      }

      const apiResult = await this.commitReservationViaApi(payload, slot, chosenTable.tableName);
      if (apiResult.success) {
        return {
          status: "confirmed",
          message: `All set! I've booked ${chosenTable.tableName} for ${payload.guestName} on ${payload.reservationDate} at ${payload.reservationTime}.` +
            (apiResult.referenceId ? ` Confirmation ID: ${apiResult.referenceId}.` : ""),
          tableName: chosenTable.tableName,
          referenceId: apiResult.referenceId ?? null,
        };
      }

      this.appendReservationCsv(payload, chosenTable.tableName, slot);
      return {
        status: "queued",
        message:
          "I saved the reservation details locally because the booking system didn't respond. Our staff will secure the table manually and follow up with a confirmation message.",
        tableName: chosenTable.tableName,
      };
    } catch (error) {
      console.error("reservation_creation_failed", error);
      return {
        status: "failed",
        message:
          error instanceof Error ? error.message : "I ran into an unexpected issue finalizing that reservation.",
      };
    }
  }

  lookupInfo(topic: string): {
    summary: string;
    related: RestaurantInfoEntry[];
  } {
    const normalized = topic.trim().toLowerCase();
    if (!normalized) {
      return { summary: "", related: [] };
    }

    const matches = this.info.infoEntries
      .map((entry) => ({
        entry,
        score: this.computeSimilarity(entry, normalized),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((candidate) => candidate.entry);

    if (!matches.length) {
      return { summary: "", related: [] };
    }

    const summary = matches
      .map((entry) => `${entry.field}: ${entry.value}`)
      .join("\n");

    return { summary, related: matches };
  }

  private computeSimilarity(entry: RestaurantInfoEntry, query: string): number {
    const field = entry.field.toLowerCase();
    const value = entry.value.toLowerCase();
    if (field.includes(query)) {
      return 3;
    }
    if (value.includes(query)) {
      return 2;
    }
    const tokens = query.split(/[^a-z0-9]+/gi).filter(Boolean);
    const matches = tokens.filter(
      (token) => field.includes(token) || value.includes(token),
    ).length;
    return matches;
  }
}

const reservationService = new ReservationService(restaurantKnowledge);

export async function checkAvailabilityForRequest(
  request: Pick<ReservationPayload, "partySize" | "reservationDate" | "reservationTime">,
): Promise<AvailabilityResult> {
  return reservationService.determineAvailability(request);
}

export async function createReservationForRequest(
  payload: ReservationPayload,
): Promise<ReservationResult> {
  return reservationService.createReservation(payload);
}

const checkAvailabilityTool = tool({
  name: "check_availability",
  description:
    "Check whether a table is open for the requested time slot before committing the reservation.",
  parameters: z.object({
    reservationDate: z
      .string()
      .describe("Date in YYYY-MM-DD format"),
    reservationTime: z
      .string()
      .describe("Time in HH:MM 24-hour format. Append AM/PM only if needed."),
    partySize: z
      .number()
      .int()
      .min(1)
      .describe("Number of guests the caller mentioned."),
  }),
  execute: async ({ reservationDate, reservationTime, partySize }) => {
    const result = await reservationService.determineAvailability({
      reservationDate,
      reservationTime,
      partySize,
    });
    return result;
  },
});

const createReservationTool = tool({
  name: "create_reservation",
  description:
    "Commit a reservation once all details are confirmed with the caller. The agent must repeat sensitive details like names and phone numbers back to the guest before calling this tool.",
  parameters: z.object({
    guestName: z.string().min(2).describe("Guest's full name."),
    contactNumber: z
      .string()
      .min(6)
      .describe("Digits-only contact number with optional country code."),
    partySize: z
      .number()
      .int()
      .min(1)
      .describe("Number of guests."),
    reservationDate: z
      .string()
      .describe("Date in YYYY-MM-DD format."),
    reservationTime: z
      .string()
      .describe("Time in HH:MM 24-hour format. 7:30 PM is acceptable."),
    tablePreference: z
      .string()
      .optional()
      .nullable()
      .describe(
        "Specific table identifier requested by the guest. Leave null to auto-select the smallest suitable table.",
      ),
    specialRequests: z
      .string()
      .optional()
      .nullable()
      .describe("Any additional notes the guest shared."),
  }),
  execute: async ({
    guestName,
    contactNumber,
    partySize,
    reservationDate,
    reservationTime,
    tablePreference,
    specialRequests,
  }) => {
    const normalizedContact = normalizePhoneNumber(contactNumber);
    const result = await reservationService.createReservation({
      guestName,
      contactNumber: normalizedContact,
      partySize,
      reservationDate,
      reservationTime,
      tablePreference: tablePreference ?? null,
      specialRequests: specialRequests ?? null,
    });
    return result;
  },
});

const restaurantInfoTool = tool({
  name: "lookup_restaurant_fact",
  description:
    "Look up quick facts about the restaurant such as operating hours, amenities, or signature dishes.",
  parameters: z.object({
    topic: z.string().describe("The subject the guest is asking about."),
    includeFullContext: z
      .boolean()
      .optional()
      .describe("Set true if the caller requested a detailed overview."),
  }),
  execute: async ({ topic, includeFullContext = false }) => {
    if (includeFullContext) {
      return restaurantKnowledge.infoContext;
    }
    const info = reservationService.lookupInfo(topic);
    if (!info.summary) {
      return "I don't have that detail on file.";
    }
    return info.summary;
  },
});

export const receptionistPersona = `
You are Mia, a warm and attentive receptionist for Iron Hill Bengaluru. You speak naturally, using polite courtesies, gentle empathy, and concise guidance. Keep the caller informed about the next step.

# Core Responsibilities
1. Greet the caller and offer help proactively.
2. When handling reservations:
   - Gather and confirm the guest name, contact number, party size, reservation date, and reservation time.
   - Repeat back names and numbers for confirmation before moving forward.
   - Use \`check_availability\` whenever the guest proposes a time.
   - Only call \`create_reservation\` after all details are confirmed and the caller agrees.
   - Offer nearby alternatives if the requested slot is unavailable.
3. For general questions, use \`lookup_restaurant_fact\` to stay accurate. If the fact isn't in the file, gently say you don't have that data and pivot back to helping with reservations.
4. Never invent answers, menu items, or policies not present in the provided data or confirmed by the caller.
5. Keep the conversation friendly, concise, and goal-oriented. Close the call with an offer for further assistance.

# Voice & Tone
- Warm, upbeat, and professional.
- Express genuine enthusiasm about welcoming the guest.
- Pace is steady and confident—no rushing.
- Use light filler words only when it sounds natural (e.g., "sure thing" or "let me just confirm that").

# Operating Hours
- Opening: ${restaurantKnowledge.openingTime}
- Closing: ${restaurantKnowledge.closingTime}

# Safety Checks
- Always confirm spelling for names and digits for phone numbers.
- If details are unclear, politely ask the caller to repeat them.
- If the system connection fails, reassure the caller that you'll log the details manually and a teammate will follow up.

# Knowledge Base Snapshot
${restaurantKnowledge.infoContext}
`;

export type ReceptionAgentContext = {
  restaurantName: string;
};

export const receptionistAgent = new RealtimeAgent<ReceptionAgentContext>({
  name: "ironhill-receptionist",
  instructions: receptionistPersona,
  voice: "alloy",
  tools: [checkAvailabilityTool, createReservationTool, restaurantInfoTool],
});

export function createReceptionSession(options?: {
  transport?: "webrtc" | "websocket";
  context?: ReceptionAgentContext;
}) {
  const session = new RealtimeSession(receptionistAgent, {
    transport: options?.transport ?? "websocket",
    context: options?.context ?? {
      restaurantName: "Iron Hill Bengaluru",
    },
    config: {
      voice: "alloy",
      outputModalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: {
            model: "gpt-4o-transcribe",
            prompt:
              "The caller is speaking to Iron Hill Bengaluru's receptionist Mia about reservations.",
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: "alloy",
        },
      },
    },
  });
  return session;
}

function logAssistantMessage(item: RealtimeItem): void {
  if (item.type !== "message" || item.role !== "assistant") {
    return;
  }
  const transcript = item.content
    .filter((chunk) => chunk.type === "output_text" && chunk.text)
    .map((chunk) => chunk.type === "output_text" ? chunk.text : "")
    .join("");
  if (transcript) {
    console.log(`Assistant: ${transcript}`);
  }
}

export async function runCliDemo(): Promise<void> {
  const session = createReceptionSession({ transport: "websocket" });

  session.on("history_added", (item) => {
    logAssistantMessage(item);
  });
  session.on("error", ({ error }) => {
    console.error("Session error", error);
  });

  await session.connect({
    apiKey: process.env.OPENAI_API_KEY!,
    model: OPENAI_REALTIME_MODEL,
  });

  console.log("Realtime receptionist connected. Type messages to simulate a caller. Type 'exit' to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.toLowerCase() === "exit") {
      rl.close();
      session.close();
      return;
    }
    session.sendMessage({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: trimmed }],
    });
  });

  rl.on("close", () => {
    session.close();
    console.log("Disconnected from realtime session.");
  });
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  runCliDemo().catch((error) => {
    console.error("Failed to start realtime receptionist demo", error);
    process.exitCode = 1;
  });
}
