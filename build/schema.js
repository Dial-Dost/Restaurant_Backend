import { MongoClient } from "mongodb";
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME ?? "reception";
let client = null;
let db = null;
let connectPromise = null;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function connectToMongo() {
    if (db) {
        return db;
    }
    if (!mongoUri) {
        throw new Error("MONGODB_URI environment variable is not set.");
    }
    if (!connectPromise) {
        connectPromise = (async () => {
            const maxRetries = Number(process.env.MONGODB_CONNECT_RETRIES ?? 5);
            const baseDelay = Number(process.env.MONGODB_CONNECT_BASE_DELAY_MS ?? 250);
            const serverSelectionTimeoutMS = Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000);
            const connectTimeoutMS = Number(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? 10000);
            let lastError = null;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    client = new MongoClient(mongoUri, {
                        serverSelectionTimeoutMS,
                        connectTimeoutMS,
                        retryWrites: true,
                    });
                    const connectedClient = await client.connect();
                    db = connectedClient.db(databaseName);
                    // Sanity ping to ensure we truly have connectivity
                    await db.command({ ping: 1 });
                    console.log(`Connected to MongoDB database: ${databaseName}`);
                    return db;
                }
                catch (error) {
                    lastError = error;
                    console.error(`MongoDB connect attempt ${attempt + 1}/${maxRetries} failed`, error);
                    try {
                        if (client) {
                            await client.close();
                        }
                    }
                    catch { }
                    client = null;
                    db = null;
                    if (attempt < maxRetries - 1) {
                        const delay = baseDelay * Math.pow(2, attempt);
                        await sleep(delay);
                    }
                }
            }
            connectPromise = null;
            throw lastError ?? new Error("Unknown MongoDB connection error");
        })();
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