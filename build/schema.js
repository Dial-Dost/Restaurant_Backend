import { MongoClient } from "mongodb";
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME ?? "reception";
let client = null;
let db = null;
let connectPromise = null;
async function connectToMongo() {
    if (db) {
        return db;
    }
    if (!mongoUri) {
        throw new Error("MONGODB_URI environment variable is not set.");
    }
    if (!connectPromise) {
        client = new MongoClient(mongoUri);
        connectPromise = client
            .connect()
            .then((connectedClient) => {
            db = connectedClient.db(databaseName);
            console.log(`Connected to MongoDB database: ${databaseName}`);
            return db;
        })
            .catch((error) => {
            connectPromise = null;
            console.error("Failed to connect to MongoDB", error);
            throw error;
        });
    }
    return connectPromise;
}
export async function getDb() {
    return connectToMongo();
}
export async function getCollection(name) {
    const database = await connectToMongo();
    return database.collection(name);
}
export async function closeMongoConnection() {
    if (client) {
        await client.close();
        client = null;
        db = null;
        connectPromise = null;
    }
}
//# sourceMappingURL=schema.js.map