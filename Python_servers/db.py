import os
import re
from datetime import datetime, timezone
from uuid import uuid4

from dotenv import load_dotenv
from google import genai

from util.logger import info, exception
from questions import FeedbackQuestions, count_tokens_with_retry

try:
    import psycopg
    from psycopg.rows import dict_row
except ModuleNotFoundError as exc:
    raise RuntimeError(
        "psycopg is required for Supabase/Postgres access. Install with: pip install 'psycopg[binary]'"
    ) from exc

# =====================================================================
# 1. Supabase/Postgres Setup
# =====================================================================
load_dotenv()

connection_string = (
    os.environ.get("SUPABASE_DIRECT_URL")
    or os.environ.get("DATABASE_URL")
    or os.environ.get("DIRECT_URL")
)
ipv4_fallback_string = os.environ.get("SUPABASE_IPV4_URL")

if not connection_string:
    raise RuntimeError(
        "SUPABASE_DIRECT_URL (or DATABASE_URL / DIRECT_URL) is required for Python services."
    )

_pg_conn = None

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Get all categories dynamically from the Pydantic model
categories = list(FeedbackQuestions.model_fields.keys())

DEFAULT_QUESTIONS = {
    "initial_greeting": "How was your welcome experience when you arrived?",
    "waiter_serving": "How was the attentiveness and helpfulness of your waiter?",
    "food": "How satisfied were you with the food quality and taste?",
    "ambience": "How did you feel about the ambience and overall atmosphere?",
    "restroom": "How would you rate the cleanliness of the restroom?",
    "valet": "How was your valet parking experience today?",
    "follow_up": "You rated the <service> as <rate>. Could you share what influenced that rating?",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_restaurant_id(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _is_uuid(value: str) -> bool:
    return bool(UUID_RE.match(value.strip()))


def _get_conn():
    global _pg_conn

    if _pg_conn is not None and not _pg_conn.closed:
        return _pg_conn

    info("Connecting to Supabase Postgres...")
    try:
        _pg_conn = psycopg.connect(connection_string, row_factory=dict_row)
    except Exception as e:
        info("Failed to connect to Supabase Postgres. Trying IPv4 fallback...")
        if ipv4_fallback_string:
            _pg_conn = psycopg.connect(ipv4_fallback_string, row_factory=dict_row)
        else:
            raise e

    with _pg_conn.cursor() as cur:
        cur.execute("select 1")
    info("Connected to Supabase Postgres successfully.")

    _ensure_feedback_questions_table(_pg_conn)
    _ensure_valet_vehicle_meta_table(_pg_conn)
    return _pg_conn


def _ensure_feedback_questions_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists feedback_questions (
                id uuid primary key,
                category text not null,
                question text not null,
                tokens integer not null default 0,
                created_at timestamptz not null default now()
            )
            """
        )
        cur.execute(
            """
            create index if not exists idx_feedback_questions_category_created
            on feedback_questions (category, created_at)
            """
        )
    conn.commit()


def _ensure_valet_vehicle_meta_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists "Valet_vehicle_meta" (
                booking_id uuid primary key,
                res_id uuid not null,
                outlet_id uuid not null,
                number_plate text not null,
                customer_name text,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            )
            """
        )
        cur.execute(
            """
            create unique index if not exists idx_valet_vehicle_meta_res_outlet_booking
            on "Valet_vehicle_meta" (res_id, outlet_id, booking_id)
            """
        )
    conn.commit()


def _resolve_restaurant_context(
    restaurant_id: str, outlet_override: str | None = None
) -> dict:
    conn = _get_conn()
    normalized = _normalize_restaurant_id(restaurant_id)

    if outlet_override and outlet_override.strip():
        with conn.cursor() as cur:
            cur.execute(
                """
                select
                    r.id as res_id,
                    o.id as outlet_id,
                    r.res_username as restaurant_slug,
                    r.res_name as restaurant_name
                from "Restaurant" r
                left join "Outlets" o on o.res_id = r.id
                where
                    (lower(r.res_username) = lower(%s)
                        or lower(r.res_username) = lower(%s)
                        or r.id::text = %s)
                    and (o.id::text = %s or lower(o.outlet_name) = lower(%s))
                limit 1
                """,
                (
                    restaurant_id,
                    normalized,
                    restaurant_id,
                    outlet_override,
                    outlet_override,
                ),
            )
            row = cur.fetchone()
    else:
        with conn.cursor() as cur:
            cur.execute(
                """
                select
                    r.id as res_id,
                    o.id as outlet_id,
                    r.res_username as restaurant_slug,
                    r.res_name as restaurant_name
                from "Restaurant" r
                left join "Outlets" o on o.res_id = r.id
                where
                    lower(r.res_username) = lower(%s)
                    or lower(r.res_username) = lower(%s)
                    or r.id::text = %s
                order by o.created_at asc nulls last
                limit 1
                """,
                (restaurant_id, normalized, restaurant_id),
            )
            row = cur.fetchone()

    if not row or not row.get("outlet_id"):
        raise ValueError(f"Unknown restaurant id: {restaurant_id}")

    return {
        "input_id": restaurant_id,
        "res_id": row["res_id"],
        "outlet_id": row["outlet_id"],
        "restaurant_slug": row["restaurant_slug"],
        "restaurant_name": row["restaurant_name"],
    }


def _resolve_bay_id(context: dict, bay_identifier: str | None):
    if not bay_identifier:
        return None

    ident = bay_identifier.strip()
    if not ident:
        return None

    conn = _get_conn()

    with conn.cursor() as cur:
        if _is_uuid(ident):
            cur.execute(
                """
                select id
                from "Parking_Bays"
                where res_id = %s and outlet_id = %s and id = %s
                limit 1
                """,
                (context["res_id"], context["outlet_id"], ident),
            )
            row = cur.fetchone()
            if row:
                return row["id"]

        cur.execute(
            """
            select id
            from "Parking_Bays"
            where res_id = %s and outlet_id = %s and lower(bay_name) = lower(%s)
            limit 1
            """,
            (context["res_id"], context["outlet_id"], ident),
        )
        row = cur.fetchone()
        return row["id"] if row else None


def _ensure_default_parking_bay_id(context: dict) -> str:
    conn = _get_conn()

    with conn.cursor() as cur:
        cur.execute(
            """
            select id
            from "Parking_Bays"
            where res_id = %s and outlet_id = %s and lower(bay_name) = lower(%s)
            limit 1
            """,
            (context["res_id"], context["outlet_id"], "Main"),
        )
        row = cur.fetchone()
        if row:
            return row["id"]

        cur.execute(
            """
            select id
            from "Parking_Bays"
            where res_id = %s and outlet_id = %s
            order by created_at asc
            limit 1
            """,
            (context["res_id"], context["outlet_id"]),
        )
        row = cur.fetchone()
        if row:
            return row["id"]

        bay_id = str(uuid4())
        cur.execute(
            """
            insert into "Parking_Bays"
                (id, created_at, bay_name, current_capacity, total_capacity, res_id, outlet_id)
            values
                (%s, now(), %s, %s, %s, %s, %s)
            """,
            (bay_id, "Main", 0, 5, context["res_id"], context["outlet_id"]),
        )

    conn.commit()
    return bay_id


def _adjust_bay_capacity_by_context(context: dict, bay_id: str | None, delta: int):
    if not bay_id:
        return

    conn = _get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            update "Parking_Bays"
            set current_capacity = greatest(0, coalesce(current_capacity, 0) + %s)
            where id = %s and res_id = %s and outlet_id = %s
            """,
            (int(delta), bay_id, context["res_id"], context["outlet_id"]),
        )


def _normalize_plate(value: str) -> str:
    return "".join(value.split()).upper()


# =====================================================================
# 2. Database Operations Logic (Supabase/Postgres)
# =====================================================================


def save_to_feedback_database(
    client: genai.Client, model_name: str, feedback_data: FeedbackQuestions
):
    """Calculates tokens and upserts feedback question bank in Supabase Postgres."""
    conn = _get_conn()

    try:
        total_questions = len(categories) * 20
        processed = 0

        info(
            f"Calculating tokens and inserting {total_questions} questions into Supabase Postgres..."
        )

        with conn.transaction():
            with conn.cursor() as cur:
                for cat in categories:
                    # cur.execute("delete from feedback_questions where category = %s", (cat,))
                    questions = getattr(feedback_data, cat)

                    for q in questions:
                        tokens_spent = count_tokens_with_retry(client, model_name, q)
                        cur.execute(
                            """
                            insert into feedback_questions (id, category, question, tokens, created_at)
                            values (%s, %s, %s, %s, now())
                            """,
                            (str(uuid4()), cat, q, int(tokens_spent)),
                        )

                        processed += 1
                        if processed % 10 == 0:
                            info(f"Processed {processed}/{total_questions} items...")

        info("Successfully saved all questions and token counts to Supabase Postgres.")

    except Exception as e:
        exception(f"Error during feedback question persistence: {e}")
        raise e


def get_all_feedback() -> dict:
    """Retrieves all feedback questions and token counts from Supabase Postgres."""
    conn = _get_conn()

    all_feedback = {cat: [] for cat in categories}

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                select category, question, tokens
                from feedback_questions
                where category = any(%s)
                order by created_at asc
                """,
                (categories,),
            )
            rows = cur.fetchall()

        for row in rows:
            cat = row.get("category")
            if cat in all_feedback:
                all_feedback[cat].append(
                    {
                        "question": row.get("question") or "",
                        "tokens": int(row.get("tokens") or 0),
                    }
                )

    except Exception as e:
        exception(f"Error retrieving feedback question bank: {e}")

    # Keep service bootable even when DB has no seed rows.
    for cat in categories:
        if not all_feedback[cat]:
            all_feedback[cat] = [
                {
                    "question": DEFAULT_QUESTIONS.get(
                        cat, "How was your experience today?"
                    ),
                    "tokens": 0,
                }
            ]

    return all_feedback


def create_valet_record_in_db(
    number_plate: str, restaurant_id: str, outlet_override: str | None = None
) -> dict:
    """Creates a new valet record in Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        conn = _get_conn()

        booking_id = str(uuid4())
        bay_id = _ensure_default_parking_bay_id(context)
        normalized_plate = _normalize_plate(number_plate)

        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into "Valet_vehicle_state"
                        (id, entry_time, res_id, outlet_id, state, exit_time, bay_id)
                    values
                        (%s, %s, %s, %s, 1, null, %s)
                    """,
                    (
                        booking_id,
                        _now_iso(),
                        context["res_id"],
                        context["outlet_id"],
                        bay_id,
                    ),
                )

                cur.execute(
                    """
                    insert into "Valet_vehicle_meta"
                        (booking_id, res_id, outlet_id, number_plate, customer_name, created_at, updated_at)
                    values
                        (%s, %s, %s, %s, null, now(), now())
                    on conflict (booking_id)
                    do update set
                        number_plate = excluded.number_plate,
                        updated_at = now()
                    """,
                    (
                        booking_id,
                        context["res_id"],
                        context["outlet_id"],
                        normalized_plate,
                    ),
                )

        return {
            "message": "New valet record created successfully.",
            "booking_id": booking_id,
            "entry_time": _now_iso(),
        }

    except Exception as e:
        exception(f"Error creating valet record in Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def get_valet_info_from_db(booking_id: str, outlet_override: str | None = None) -> dict:
    """Retrieves valet state by booking ID from Supabase Postgres."""
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            if outlet_override and outlet_override.strip():
                cur.execute(
                    """
                    select
                        s.id as booking_id,
                        s.state,
                        s.entry_time,
                        s.exit_time,
                        s.bay_id,
                        m.number_plate
                    from "Valet_vehicle_state" s
                    left join "Valet_vehicle_meta" m
                        on m.booking_id = s.id and m.res_id = s.res_id and m.outlet_id = s.outlet_id
                    where s.id = %s and s.outlet_id = %s
                    limit 1
                    """,
                    (booking_id, outlet_override),
                )
            else:
                cur.execute(
                    """
                    select
                        s.id as booking_id,
                        s.state,
                        s.entry_time,
                        s.exit_time,
                        s.bay_id,
                        m.number_plate
                    from "Valet_vehicle_state" s
                    left join "Valet_vehicle_meta" m
                        on m.booking_id = s.id and m.res_id = s.res_id and m.outlet_id = s.outlet_id
                    where s.id = %s
                    limit 1
                    """,
                    (booking_id,),
                )
            row = cur.fetchone()

        if not row:
            return {"error": f"No valet found with that booking ID - {booking_id}."}

        return {
            "booking_id": row.get("booking_id"),
            "number_plate": row.get("number_plate"),
            "state": int(row.get("state") or 0),
            "entry_time": row.get("entry_time").isoformat()
            if row.get("entry_time")
            else None,
            "exit_time": row.get("exit_time").isoformat()
            if row.get("exit_time")
            else None,
            "bay_id": row.get("bay_id"),
        }

    except Exception as e:
        exception(f"Error retrieving valet info from Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def update_valet_state_from_db(
    booking_id: str, state: int, outlet_override: str | None = None
) -> dict:
    """Updates valet state and adjusts bay capacity using Supabase Postgres."""
    try:
        conn = _get_conn()
        with conn.transaction():
            with conn.cursor() as cur:
                if outlet_override and outlet_override.strip():
                    cur.execute(
                        """
                        select id, state, bay_id, res_id, outlet_id
                        from "Valet_vehicle_state"
                        where id = %s and outlet_id = %s
                        limit 1
                        """,
                        (booking_id, outlet_override),
                    )
                else:
                    cur.execute(
                        """
                        select id, state, bay_id, res_id, outlet_id
                        from "Valet_vehicle_state"
                        where id = %s
                        limit 1
                        """,
                        (booking_id,),
                    )
                active_record = cur.fetchone()

                if not active_record:
                    return {
                        "error": f"No active valet record found for that booking ID - {booking_id}."
                    }

                context = {
                    "res_id": active_record["res_id"],
                    "outlet_id": active_record["outlet_id"],
                }
                prev_state = int(active_record.get("state") or 1)
                bay_id = active_record.get("bay_id")
                next_state = int(state)

                counted = lambda s: 2 <= int(s) <= 4

                if not counted(prev_state) and counted(next_state):
                    _adjust_bay_capacity_by_context(context, bay_id, 1)
                if counted(prev_state) and not counted(next_state):
                    _adjust_bay_capacity_by_context(context, bay_id, -1)

                cur.execute(
                    """
                    update "Valet_vehicle_state"
                    set
                        state = %s,
                        exit_time = case when %s = 6 then now() else exit_time end
                    where id = %s and res_id = %s and outlet_id = %s
                    """,
                    (
                        next_state,
                        next_state,
                        booking_id,
                        context["res_id"],
                        context["outlet_id"],
                    ),
                )

                if next_state in (5, 6) and bay_id:
                    cur.execute(
                        """
                        update "Valet_vehicle_state"
                        set bay_id = null
                        where id = %s and res_id = %s and outlet_id = %s
                        """,
                        (booking_id, context["res_id"], context["outlet_id"]),
                    )

        return {
            "message": "Valet state updated successfully.",
            "booking_id": booking_id,
        }

    except Exception as e:
        exception(f"Error updating valet state in Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def update_valet_bay_from_db(
    booking_id: str, bay_id: str, outlet_override: str | None = None
) -> dict:
    """Updates bay assignment for a valet record in Supabase Postgres."""
    try:
        conn = _get_conn()
        with conn.transaction():
            with conn.cursor() as cur:
                if outlet_override and outlet_override.strip():
                    cur.execute(
                        """
                        select id, state, bay_id, res_id, outlet_id
                        from "Valet_vehicle_state"
                        where id = %s and outlet_id = %s
                        limit 1
                        """,
                        (booking_id, outlet_override),
                    )
                else:
                    cur.execute(
                        """
                        select id, state, bay_id, res_id, outlet_id
                        from "Valet_vehicle_state"
                        where id = %s
                        limit 1
                        """,
                        (booking_id,),
                    )
                active_record = cur.fetchone()

                if not active_record:
                    return {
                        "error": f"No active valet record found for that booking ID - {booking_id}."
                    }

                context = {
                    "res_id": active_record["res_id"],
                    "outlet_id": active_record["outlet_id"],
                }
                prev_bay = active_record.get("bay_id")
                state = int(active_record.get("state") or 1)
                counted = lambda s: 2 <= int(s) <= 4

                next_bay = None
                if bay_id and bay_id.strip():
                    next_bay = _resolve_bay_id(
                        {
                            "res_id": context["res_id"],
                            "outlet_id": context["outlet_id"],
                        },
                        bay_id,
                    )
                    if not next_bay:
                        return {"error": "Bay not found"}

                if prev_bay and prev_bay != next_bay and counted(state):
                    _adjust_bay_capacity_by_context(context, prev_bay, -1)
                    _adjust_bay_capacity_by_context(context, next_bay, 1)
                elif not prev_bay and next_bay and counted(state):
                    _adjust_bay_capacity_by_context(context, next_bay, 1)
                elif prev_bay and not next_bay and counted(state):
                    _adjust_bay_capacity_by_context(context, prev_bay, -1)

                cur.execute(
                    """
                    update "Valet_vehicle_state"
                    set bay_id = %s
                    where id = %s and res_id = %s and outlet_id = %s
                    """,
                    (next_bay, booking_id, context["res_id"], context["outlet_id"]),
                )

        return {
            "message": "Valet bay updated successfully.",
            "booking_id": booking_id,
        }

    except Exception as e:
        exception(f"Error updating valet bay in Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def get_all_valet_records_from_db(
    restaurant_id: str, outlet_override: str | None = None
) -> list[dict]:
    """Retrieves all valet records for a restaurant from Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        conn = _get_conn()

        with conn.cursor() as cur:
            cur.execute(
                """
                select
                    s.id as booking_id,
                    s.state,
                    s.entry_time,
                    s.exit_time,
                    s.bay_id,
                    m.number_plate
                from "Valet_vehicle_state" s
                left join "Valet_vehicle_meta" m
                    on m.booking_id = s.id and m.res_id = s.res_id and m.outlet_id = s.outlet_id
                where s.res_id = %s and s.outlet_id = %s
                order by s.entry_time desc nulls last
                """,
                (context["res_id"], context["outlet_id"]),
            )
            rows = cur.fetchall()

        return [
            {
                "booking_id": row.get("booking_id"),
                "number_plate": row.get("number_plate"),
                "state": int(row.get("state") or 0),
                "entry_time": row.get("entry_time").isoformat()
                if row.get("entry_time")
                else None,
                "exit_time": row.get("exit_time").isoformat()
                if row.get("exit_time")
                else None,
                "bay_id": row.get("bay_id"),
                "restaurant_id": restaurant_id,
            }
            for row in rows
        ]
    except Exception as e:
        exception(f"Error fetching valet records from Supabase Postgres: {e}")
        return []


def get_all_bays_from_db(
    restaurant_id: str, outlet_override: str | None = None
) -> list[dict]:
    """Retrieves all bays for a restaurant from Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        conn = _get_conn()

        with conn.cursor() as cur:
            cur.execute(
                """
                select id, bay_name, current_capacity, total_capacity
                from "Parking_Bays"
                where res_id = %s and outlet_id = %s
                order by created_at asc
                """,
                (context["res_id"], context["outlet_id"]),
            )
            rows = cur.fetchall()

        return [
            {
                "Bay_id": row.get("id"),
                "Bay_name": row.get("bay_name"),
                "current_capacity": int(row.get("current_capacity") or 0),
                "total_capacity": int(row.get("total_capacity") or 0),
                "restaurant_id": restaurant_id,
            }
            for row in rows
        ]

    except Exception as e:
        exception(f"Error fetching bays from Supabase Postgres: {e}")
        return []


def _adjust_bay_capacity(
    restaurant_id: str,
    bay_id: str | None,
    delta: int,
    outlet_override: str | None = None,
) -> None:
    if not bay_id:
        return

    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        resolved = _resolve_bay_id(context, bay_id)
        if not resolved:
            return

        _adjust_bay_capacity_by_context(context, resolved, int(delta))
        _get_conn().commit()
    except Exception as e:
        exception(f"Error adjusting bay capacity: {e}")


def add_bay_in_db(
    restaurant_id: str,
    bay_name: str,
    total_capacity: int | None = None,
    outlet_override: str | None = None,
) -> dict:
    """Adds a new bay in Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        conn = _get_conn()
        normalized_name = bay_name.strip()
        cap = max(0, int(total_capacity) if total_capacity is not None else 0)

        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, bay_name, current_capacity, total_capacity
                    from "Parking_Bays"
                    where res_id = %s and outlet_id = %s and lower(bay_name) = lower(%s)
                    limit 1
                    """,
                    (context["res_id"], context["outlet_id"], normalized_name),
                )
                existing = cur.fetchone()
                if existing:
                    return {
                        "message": "Bay already exists",
                        "Bay_id": existing.get("id"),
                        "Bay_name": existing.get("bay_name"),
                        "current_capacity": int(existing.get("current_capacity") or 0),
                        "total_capacity": int(existing.get("total_capacity") or 0),
                    }

                new_id = str(uuid4())
                cur.execute(
                    """
                    insert into "Parking_Bays"
                        (id, created_at, bay_name, current_capacity, total_capacity, res_id, outlet_id)
                    values
                        (%s, now(), %s, 0, %s, %s, %s)
                    """,
                    (
                        new_id,
                        normalized_name,
                        cap,
                        context["res_id"],
                        context["outlet_id"],
                    ),
                )

        return {
            "message": "Bay added",
            "Bay_id": new_id,
            "Bay_name": normalized_name,
            "current_capacity": 0,
            "total_capacity": cap,
        }

    except Exception as e:
        exception(f"Error adding bay in Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def update_bay_in_db(
    restaurant_id: str,
    bay_id: str | None,
    bay_name: str,
    total_capacity: int | None = None,
    outlet_override: str | None = None,
) -> dict:
    """Updates an existing bay in Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        conn = _get_conn()
        normalized_name = bay_name.strip()
        cap = max(0, int(total_capacity) if total_capacity is not None else 0)

        target_id = (
            _resolve_bay_id(context, bay_id)
            if bay_id
            else _resolve_bay_id(context, bay_name)
        )
        if not target_id:
            return {"error": "Bay not found"}

        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update "Parking_Bays"
                    set bay_name = %s, total_capacity = %s
                    where id = %s and res_id = %s and outlet_id = %s
                    returning id, bay_name, current_capacity, total_capacity
                    """,
                    (
                        normalized_name,
                        cap,
                        target_id,
                        context["res_id"],
                        context["outlet_id"],
                    ),
                )
                updated = cur.fetchone()

        if not updated:
            return {"error": "Bay not found"}

        return {
            "message": "Bay updated",
            "Bay_id": updated.get("id"),
            "Bay_name": updated.get("bay_name"),
            "total_capacity": int(updated.get("total_capacity") or 0),
            "current_capacity": int(updated.get("current_capacity") or 0),
        }
    except Exception as e:
        exception(f"Error updating bay in Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def delete_bay_in_db(
    restaurant_id: str,
    bay_id: str | None = None,
    bay_name: str | None = None,
    outlet_override: str | None = None,
) -> dict:
    """Deletes a bay and related valet rows for that bay in Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        target = _resolve_bay_id(context, bay_id if bay_id else bay_name)
        if not target:
            return {"error": "Bay not found"}

        conn = _get_conn()

        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    delete from "Valet_vehicle_state"
                    where res_id = %s and outlet_id = %s and bay_id = %s
                    """,
                    (context["res_id"], context["outlet_id"], target),
                )
                deleted_valet_count = cur.rowcount

                cur.execute(
                    """
                    delete from "Parking_Bays"
                    where id = %s and res_id = %s and outlet_id = %s
                    """,
                    (target, context["res_id"], context["outlet_id"]),
                )

        return {
            "message": "Bay deleted",
            "Bay_id": target,
            "deleted_valet_count": int(deleted_valet_count or 0),
        }
    except Exception as e:
        exception(f"Error deleting bay from Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def set_bay_current_in_db(
    restaurant_id: str,
    bay_id: str,
    current_capacity: int,
    outlet_override: str | None = None,
) -> dict:
    """Sets current bay capacity in Supabase Postgres."""
    try:
        context = _resolve_restaurant_context(restaurant_id, outlet_override)
        target = _resolve_bay_id(context, bay_id)
        if not target:
            return {"error": "Bay not found"}

        conn = _get_conn()
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update "Parking_Bays"
                    set current_capacity = %s
                    where id = %s and res_id = %s and outlet_id = %s
                    returning id, bay_name, total_capacity, current_capacity
                    """,
                    (
                        max(0, int(current_capacity)),
                        target,
                        context["res_id"],
                        context["outlet_id"],
                    ),
                )
                updated = cur.fetchone()

        if not updated:
            return {"error": "Bay not found"}

        return {
            "message": "Bay current capacity set",
            "Bay_id": updated.get("id"),
            "Bay_name": updated.get("bay_name"),
            "total_capacity": int(updated.get("total_capacity") or 0),
            "current_capacity": int(updated.get("current_capacity") or 0),
        }
    except Exception as e:
        exception(f"Error setting bay current capacity in Supabase Postgres: {e}")
        return {"error": "Database error occurred."}


def shutdown_db():
    """Closes the Supabase Postgres connection gracefully."""
    global _pg_conn
    try:
        if _pg_conn is not None and not _pg_conn.closed:
            _pg_conn.close()
            info("Supabase Postgres connection closed successfully.")
    except Exception as e:
        exception(f"Error closing Supabase Postgres connection: {e}")
    finally:
        _pg_conn = None
