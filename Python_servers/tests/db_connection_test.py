from pymongo import MongoClient
from pymongo.server_api import ServerApi
import os
from dotenv import load_dotenv

load_dotenv()  # Load environment variables from .env file

# Use MONGO_URI from env, or default to local Mongo instance
mongo_uri = os.environ.get(
    "MONGO_URI",
    "mongodb+srv://<db_username>:<db_password>@restaurantcluster.sxtqbek.mongodb.net/?appName=restaurantcluster",
)
mongo_db_name = os.environ.get("MONGO_DB_NAME", "reception")

# new connection setup with Server API versioning for better compatibility with MongoDB Atlas
# Create a new client and connect to the server
client = MongoClient(mongo_uri, server_api=ServerApi("1"))
mongo_db = client[mongo_db_name]
# Send a ping to confirm a successful connection
try:
    client.admin.command("ping")
    print("Pinged your deployment. You successfully connected to MongoDB!")
    print(mongo_db.list_collection_names())
except Exception as e:
    print(e)