import os
from datetime import datetime
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.server_api import ServerApi

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


def get_valet_state_from_db(number_plate: str) -> dict:
    """Retrieves the current state of a valet car based on its number plate."""
    try:
        collection = mongo_db["valet_state"]

        # Sort by entry_time descending to always get the most recent valet interaction for that plate
        record = collection.find_one(
            {"number_plate": number_plate}, sort=[("entry_time", -1)]
        )

        if record:
            return {
                "number_plate": record.get("number_plate"),
                "state": record.get("state"),
                "entry_time": record.get("entry_time"),
                "exit_time": record.get("exit_time"),
            }
        else:
            return {"error": "No valet found with that number plate."}

    except Exception as e:
        exception(f"❌ Error retrieving valet state from MongoDB: {e}")
        return {"error": "Database error occurred."}


def update_valet_state_from_db(number_plate: str, state: int) -> dict:
    """Updates the state of a valet car or creates a new one if exit time is None."""
    try:
        collection = mongo_db["valet_state"]

        # Look for an active session (where the car hasn't exited yet)
        active_record = collection.find_one(
            {"number_plate": number_plate, "exit_time": None}
        )

        if active_record:
            update_data = {"state": state}
            if state == 6:  # If the state is 'Car Picked Up', set the exit time
                update_data["exit_time"] = datetime.now()

            collection.update_one({"_id": active_record["_id"]}, {"$set": update_data})
            return {"message": "Valet state updated successfully."}
        else:
            new_record = {
                "number_plate": number_plate,
                "state": state,
                "entry_time": datetime.now(),
                "exit_time": None,
            }
            collection.insert_one(new_record)
            return {"message": "New valet record created successfully."}

    except Exception as e:
        exception(f"❌ Error updating valet state in MongoDB: {e}")
        return {"error": "Database error occurred."}


def shutdown_db():
    """Closes the MongoDB connection gracefully."""
    try:
        mongo_client.close()
        info("✅ MongoDB connection closed successfully.")
    except Exception as e:
        exception(f"❌ Error closing MongoDB connection: {e}")
