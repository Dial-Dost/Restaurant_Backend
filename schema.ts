import { MongoClient, type Collection, type Db, type Document } from "mongodb";

const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME ?? "reception";

let client: MongoClient | null = null;
let db: Db | null = null;
let connectPromise: Promise<Db> | null = null;

async function connectToMongo(): Promise<Db> {
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
			.then((connectedClient: MongoClient) => {
				db = connectedClient.db(databaseName);
				console.log(`Connected to MongoDB database: ${databaseName}`);
				return db;
			})
			.catch((error: unknown) => {
				connectPromise = null;
				console.error("Failed to connect to MongoDB", error);
				throw error;
			});
	}

	return connectPromise;
}

export async function getDb(): Promise<Db> {
	return connectToMongo();
}

export async function getCollection<TSchema extends Document = Document>(
	name: string,
): Promise<Collection<TSchema>> {
	const database = await connectToMongo();
	return database.collection<TSchema>(name);
}

export async function closeMongoConnection(): Promise<void> {
	if (client) {
		await client.close();
		client = null;
		db = null;
		connectPromise = null;
	}
}
