import os
from datetime import datetime
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.server_api import ServerApi
from bson.objectid import ObjectId
from google import genai
from util.logger import info, exception
from questions import FeedbackQuestions, count_tokens_with_retry

# =====================================================================
# 1. MongoDB Setup
# =====================================================================
load_dotenv()  # Load environment variables from .env file

# Use MONGO_URI from env, or default to MongoDB Atlas instance
mongo_uri = os.environ.get(
    "MONGO_URI",
    "mongodb+srv://<db_username>:<db_password>@restaurantcluster.sxtqbek.mongodb.net/?appName=restaurantcluster",
)
mongo_db_name = os.environ.get("MONGO_DB_NAME", "reception")

info("Connecting to MongoDB Atlas...")
try:
    # Create a new client and connect to the server with Server API versioning
    mongo_client = MongoClient(mongo_uri, server_api=ServerApi("1"))

    # Select the database
    mongo_db = mongo_client[mongo_db_name]

    # Send a ping to confirm a successful connection
    mongo_client.admin.command("ping")
    info("✅ Pinged your deployment. You successfully connected to MongoDB Atlas!")
except Exception as e:
    exception(f"❌ Failed to connect to MongoDB Atlas: {e}")

# Get all categories dynamically from the Pydantic model
categories = list(FeedbackQuestions.model_fields.keys())

# =====================================================================
# 2. Database Operations Logic
# =====================================================================


def save_to_feedback_database(
    client: genai.Client, model_name: str, feedback_data: FeedbackQuestions
):
    """Calculates tokens and inserts records into MongoDB collections."""
    try:
        total_questions = len(categories) * 20
        processed = 0

        info(
            f"Calculating tokens and inserting {total_questions} questions into MongoDB..."
        )

        for cat in categories:
            collection = mongo_db[cat]
            questions = getattr(feedback_data, cat)

            for q in questions:
                # Count tokens spent on this specific question string
                tokens_spent = count_tokens_with_retry(client, model_name, q)

                # Insert a new document
                collection.insert_one({"question": q, "tokens": tokens_spent})

                processed += 1
                if processed % 10 == 0:
                    info(f"Processed {processed}/{total_questions} items...")

        info("✅ Successfully saved all questions and token counts to MongoDB.")

    except Exception as e:
        exception(f"❌ Error during MongoDB insertion: {e}")
        raise e


def get_all_feedback() -> dict:
    """Retrieves all feedback questions and their token counts from MongoDB."""
    try:
        all_feedback = {}
        for cat in categories:
            collection = mongo_db[cat]
            # Fetch all documents, excluding the MongoDB '_id' field from results
            records = list(collection.find({}, {"_id": 0, "question": 1, "tokens": 1}))
            all_feedback[cat] = records

        return all_feedback

    except Exception as e:
        exception(f"❌ Error retrieving feedback from MongoDB: {e}")
        return {}


def create_valet_record_in_db(number_plate: str, restaurant_id: str) -> dict:
    """Creates a new valet record in the database."""
    try:
        collection = mongo_db["valet_state"]

        new_record = {
            "number_plate": number_plate,
            "restaurant_id": restaurant_id,
            "state": 1,  # Default state when creating a new record
            "entry_time": datetime.now().isoformat(),
            "exit_time": None,
            "bay_id": None,
        }
        collection.insert_one(new_record)
        return {
            "message": "New valet record created successfully.",
            "booking_id": str(new_record["_id"]),
            "entry_time": new_record["entry_time"],
        }

    except Exception as e:
        exception(f"❌ Error creating valet record in MongoDB: {e}")
        return {"error": "Database error occurred."}


# def get_valet_state_from_db(number_plate: str) -> dict:
#     """Retrieves the current state of a valet car based on its number plate."""
#     try:
#         collection = mongo_db["valet_state"]

#         # Sort by entry_time descending to always get the most recent valet interaction for that plate
#         record = collection.find_one(
#             {"number_plate": number_plate}, sort=[("entry_time", -1)]
#         )

#         if record:
#             return {
#                 "booking_id": str(record.get("_id")),
#                 "number_plate": record.get("number_plate"),
#                 "state": record.get("state"),
#                 "entry_time": record.get("entry_time"),
#                 "exit_time": record.get("exit_time"),
#                 "bay_name": record.get("bay_name")
#             }
#         else:
#             return {"error": "No valet found with that number plate."}

#     except Exception as e:
#         exception(f"❌ Error retrieving valet state from MongoDB: {e}")
#         return {"error": "Database error occurred."}


def get_valet_info_from_db(booking_id: str) -> dict:
    """Retrieves the current state of a valet car based on its booking ID."""
    try:
        collection = mongo_db["valet_state"]

        # Sort by entry_time descending to always get the most recent valet interaction for that plate
        record = collection.find_one({"_id": ObjectId(booking_id)})

        if record:
            return {
                "booking_id": str(record.get("_id")),
                "number_plate": record.get("number_plate"),
                "state": record.get("state"),
                "entry_time": record.get("entry_time"),
                "exit_time": record.get("exit_time"),
                "bay_id": record.get("bay_id"),
            }
        else:
            return {"error": f"No valet found with that booking ID - {booking_id}."}

    except Exception as e:
        exception(f"❌ Error retrieving valet state from MongoDB: {e}")
        return {"error": "Database error occurred."}


# def update_valet_state_from_db(number_plate: str, state: int) -> dict:
#     """Updates the state of a valet car or creates a new one if exit time is None."""
#     try:
#         collection = mongo_db["valet_state"]

#         # Look for an active session (where the car hasn't exited yet)
#         active_record = collection.find_one(
#             {"number_plate": number_plate, "exit_time": None}
#         )

#         if active_record:
#             update_data: dict[str, int | str] = {"state": state}
#             if state == 6:  # If the state is 'Car Picked Up', set the exit time
#                 update_data["exit_time"] = datetime.now().isoformat()

#             collection.update_one({"_id": active_record["_id"]}, {"$set": update_data})
#             return {"message": "Valet state updated successfully.", "booking_id": str(active_record["_id"]), "entry_time": active_record["entry_time"], "exit_time": update_data.get("exit_time"), "bay_name": active_record["bay_name"]}
#         else:
#             # If no active record exists, we can choose to create a new one or return an error
#             return {"error": "No active valet record found for that number plate."}

#     except Exception as e:
#         exception(f"❌ Error updating valet state in MongoDB: {e}")
#         return {"error": "Database error occurred."}


def update_valet_state_from_db(booking_id: str, state: int) -> dict:
    """Updates the state of a valet car or creates a new one if exit time is None."""
    try:
        collection = mongo_db["valet_state"]

        # Look for an active session (where the car hasn't exited yet)
        active_record = collection.find_one({"_id": ObjectId(booking_id)})

        if active_record:
            prev_state = int(active_record.get("state", 1) or 1)
            bay_id = active_record.get("bay_id")

            # Determine capacity effect based on state transition
            # Counted states: 2,3,4 -> vehicle is occupying bay
            counted = lambda s: 2 <= int(s) <= 4

            try:
                # If transitioning from non-counted -> counted, increment bay
                if not counted(prev_state) and counted(state):
                    _adjust_bay_capacity(active_record.get("restaurant_id"), bay_id, 1)

                # If transitioning from counted -> non-counted, decrement bay
                if counted(prev_state) and not counted(state):
                    _adjust_bay_capacity(active_record.get("restaurant_id"), bay_id, -1)
            except Exception as e:
                # log but proceed with updating state
                exception(
                    f"❌ Error while updating capacities during state change: {e}"
                )

            update_data: dict[str, int | str] = {"state": state}
            if state == 6:  # If the state is 'Car Picked Up', set the exit time
                update_data["exit_time"] = datetime.now().isoformat()

            collection.update_one({"_id": active_record["_id"]}, {"$set": update_data})

            # If vehicle has left (states 5 or 6), clear bay assignment so it becomes unassigned
            try:
                if int(state) in (5, 6) and bay_id:
                    collection.update_one(
                        {"_id": active_record["_id"]}, {"$set": {"bay_id": None}}
                    )
            except Exception as e:
                exception(f"❌ Error while clearing bay assignment on exit: {e}")

            return {
                "message": "Valet state updated successfully.",
                "booking_id": str(active_record["_id"]),
            }
        else:
            # If no active record exists, we can choose to create a new one or return an error
            return {
                "error": f"No active valet record found for that booking ID - {booking_id}."
            }

    except Exception as e:
        exception(f"❌ Error updating valet state in MongoDB: {e}")
        return {"error": "Database error occurred."}


def update_valet_bay_from_db(booking_id: str, bay_id: str) -> dict:
    """Updates the bay_id of a valet car or creates a new one if exit time is None."""
    try:
        collection = mongo_db["valet_state"]

        # Look for an active session (where the car hasn't exited yet)
        active_record = collection.find_one({"_id": ObjectId(booking_id)})

        if active_record:
            prev_bay = active_record.get("bay_id")
            state = int(active_record.get("state", 1) or 1)

            # If vehicle is in counted state (2-4) we must move occupancy
            counted = lambda s: 2 <= int(s) <= 4
            try:
                if prev_bay and prev_bay != bay_id and counted(state):
                    # decrement previous bay
                    _adjust_bay_capacity(
                        active_record.get("restaurant_id"), prev_bay, -1
                    )
                    # increment new bay
                    _adjust_bay_capacity(active_record.get("restaurant_id"), bay_id, 1)
                elif not prev_bay and counted(state):
                    # newly assigned while counted -> increment new bay
                    _adjust_bay_capacity(active_record.get("restaurant_id"), bay_id, 1)
                elif prev_bay and not bay_id and counted(state):
                    # unassigning while counted -> decrement previous bay
                    _adjust_bay_capacity(
                        active_record.get("restaurant_id"), prev_bay, -1
                    )
            except Exception as e:
                exception(
                    f"❌ Error while adjusting bay capacities during bay update: {e}"
                )

            update_data: dict[str, str] = {"bay_id": bay_id}

            collection.update_one({"_id": active_record["_id"]}, {"$set": update_data})
            return {
                "message": "Valet bay updated successfully.",
                "booking_id": str(active_record["_id"]),
            }
        else:
            return {
                "error": f"No active valet record found for that booking ID - {booking_id}."
            }

    except Exception as e:
        exception(f"❌ Error updating valet bay in MongoDB: {e}")
        return {"error": "Database error occurred."}


def get_all_valet_records_from_db(restaurant_id: str) -> list[dict]:
    """Retrieves all valet records for a specific restaurant."""
    try:
        collection = mongo_db["valet_state"]
        raw_records = list(collection.find({"restaurant_id": restaurant_id}))

        # Convert ObjectId to string and normalize field names for JSON transport
        records: list[dict] = []
        for r in raw_records:
            rec = {
                "booking_id": str(r.get("_id")) if r.get("_id") is not None else None,
                "number_plate": r.get("number_plate"),
                "state": r.get("state"),
                "entry_time": r.get("entry_time"),
                "exit_time": r.get("exit_time"),
                "bay_id": r.get("bay_id"),
                "restaurant_id": r.get("restaurant_id"),
            }
            records.append(rec)

        return records
    except Exception as e:
        exception(f"❌ Error fetching valet records from MongoDB: {e}")
        return []


def get_all_bays_from_db(restaurant_id: str) -> list[dict]:
    """Retrieves all Bays for a specific restaurant."""
    try:
        collection = mongo_db["Bays"]
        raw = list(collection.find({"restaurant_id": restaurant_id}))

        bays: list[dict] = []
        for r in raw:
            bays.append(
                {
                    "Bay_id": str(r.get("_id")) if r.get("_id") is not None else None,
                    "Bay_name": r.get("Bay_name"),
                    "current_capacity": int(r.get("current_capacity", 0) or 0),
                    "total_capacity": int(r.get("total_capacity", 0) or 0),
                    "restaurant_id": r.get("restaurant_id"),
                }
            )

        return bays
    except Exception as e:
        exception(f"❌ Error fetching Bays from MongoDB: {e}")
        return []


def _adjust_bay_capacity(restaurant_id: str, bay_id: str | None, delta: int) -> None:
    """Safely adjusts the current_capacity of a Bay by delta (can be negative).
    Clamps to >= 0. No-op when bay_id is falsy.
    """
    if not bay_id:
        return
    try:
        collection = mongo_db["Bays"]
        try:
            obj_id = ObjectId(bay_id)
            query = {"_id": obj_id, "restaurant_id": restaurant_id}
        except Exception:
            query = {"_id": bay_id, "restaurant_id": restaurant_id}

        # Use a find_one to get current value then update with clamp
        doc = collection.find_one(query)
        if not doc:
            # Try resolving by Bay_name as a fallback (frontend may send name instead of id)
            try:
                doc = collection.find_one(
                    {"Bay_name": bay_id, "restaurant_id": restaurant_id}
                )
            except Exception:
                doc = None
        if not doc:
            return
        curr = int(doc.get("current_capacity", 0) or 0)
        new = max(0, curr + int(delta))
        collection.update_one({"_id": doc["_id"]}, {"$set": {"current_capacity": new}})
    except Exception as e:
        exception(f"❌ Error adjusting bay capacity: {e}")


def add_bay_in_db(
    restaurant_id: str, bay_name: str, total_capacity: int | None = None
) -> dict:
    """Adds a new Bay document for a restaurant."""
    try:
        collection = mongo_db["Bays"]
        new_doc = {
            "Bay_name": bay_name,
            "current_capacity": 0,
            "total_capacity": int(total_capacity) if total_capacity is not None else 0,
            "restaurant_id": restaurant_id,
        }
        result = collection.insert_one(new_doc)
        return {
            "message": "Bay added",
            "Bay_id": str(result.inserted_id),
            "Bay_name": bay_name,
            "current_capacity": 0,
            "total_capacity": new_doc["total_capacity"],
        }
    except Exception as e:
        exception(f"❌ Error adding Bay to MongoDB: {e}")
        return {"error": "Database error occurred."}


def update_bay_in_db(
    restaurant_id: str,
    bay_id: str | None,
    bay_name: str,
    total_capacity: int | None = None,
) -> dict:
    """Updates an existing Bay by Bay_id and restaurant_id. Returns updated doc."""
    try:
        collection = mongo_db["Bays"]
        query = {"restaurant_id": restaurant_id}
        if bay_id:
            try:
                query["_id"] = ObjectId(bay_id)
            except Exception:
                # fallback to string match
                query["_id"] = bay_id

        match = collection.find_one(query)
        if not match:
            return {"error": "Bay not found"}

        update_fields: dict = {
            "Bay_name": bay_name,
            "total_capacity": int(total_capacity) if total_capacity is not None else 0,
        }
        collection.update_one({"_id": match["_id"]}, {"$set": update_fields})
        # Preserve existing current_capacity if present (avoid accidental reset)
        existing_current = int(match.get("current_capacity", 0) or 0)
        collection.update_one({"_id": match["_id"]}, {"$set": update_fields})

        updated = collection.find_one({"_id": match["_id"]})
        # If for some reason current_capacity is missing after update, restore it
        if updated is not None and (updated.get("current_capacity") is None):
            try:
                collection.update_one(
                    {"_id": match["_id"]},
                    {"$set": {"current_capacity": existing_current}},
                )
                updated = collection.find_one({"_id": match["_id"]})
            except Exception:
                # ignore failure to restore
                pass
        return {
            "message": "Bay updated",
            "Bay_id": str(updated.get("_id")),
            "Bay_name": updated.get("Bay_name"),
            "total_capacity": int(updated.get("total_capacity", 0) or 0),
            "current_capacity": int(updated.get("current_capacity", 0) or 0),
        }
    except Exception as e:
        exception(f"❌ Error updating Bay in MongoDB: {e}")
        return {"error": "Database error occurred."}


def delete_bay_in_db(
    restaurant_id: str, bay_id: str | None = None, bay_name: str | None = None
) -> dict:
    """Deletes a Bay document by Bay_id+restaurant_id or by Bay_name+restaurant_id and removes any valet_state entries referencing it."""
    try:
        collection = mongo_db["Bays"]
        query = {"restaurant_id": restaurant_id}
        if bay_id:
            try:
                query["_id"] = ObjectId(bay_id)
            except Exception:
                query["_id"] = bay_id
        elif bay_name:
            query["Bay_name"] = bay_name
        else:
            return {"error": "Provide Bay_id or Bay_name"}

        match = collection.find_one(query)
        if not match:
            return {"error": "Bay not found"}

        bay_obj_id = match.get("_id")
        collection.delete_one({"_id": bay_obj_id})

        valet_col = mongo_db["valet_state"]
        res = valet_col.delete_many({"bay_id": str(bay_obj_id)})

        return {
            "message": "Bay deleted",
            "Bay_id": str(bay_obj_id),
            "deleted_valet_count": res.deleted_count,
        }

    except Exception as e:
        exception(f"❌ Error deleting Bay from MongoDB: {e}")
        return {"error": "Database error occurred."}


def set_bay_current_in_db(
    restaurant_id: str, bay_id: str, current_capacity: int
) -> dict:
    """Sets the current_capacity of a Bay document to the provided value (clamped >= 0).
    Returns the updated Bay document representation.
    """
    try:
        collection = mongo_db["Bays"]
        try:
            query = {"_id": ObjectId(bay_id), "restaurant_id": restaurant_id}
        except Exception:
            query = {"_id": bay_id, "restaurant_id": restaurant_id}

        match = collection.find_one(query)
        if not match:
            return {"error": "Bay not found"}

        new_val = max(0, int(current_capacity))
        collection.update_one(
            {"_id": match["_id"]}, {"$set": {"current_capacity": new_val}}
        )

        updated = collection.find_one({"_id": match["_id"]})
        return {
            "message": "Bay current capacity set",
            "Bay_id": str(updated.get("_id")),
            "Bay_name": updated.get("Bay_name"),
            "total_capacity": int(updated.get("total_capacity", 0) or 0),
            "current_capacity": int(updated.get("current_capacity", 0) or 0),
        }
    except Exception as e:
        exception(f"❌ Error setting Bay current_capacity in MongoDB: {e}")
        return {"error": "Database error occurred."}


def shutdown_db():
    """Closes the MongoDB connection gracefully."""
    try:
        mongo_client.close()
        info("✅ MongoDB connection closed successfully.")
    except Exception as e:
        exception(f"❌ Error closing MongoDB connection: {e}")
