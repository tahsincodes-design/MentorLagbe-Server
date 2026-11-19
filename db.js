// db.js
import { MongoClient, ServerApiVersion } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing in .env");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let isConnected = false;

export async function connectDB() {
  if (!isConnected) {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    isConnected = true;
  }
  return client.db("mentor-lagbe");
}

export const db = client.db("mentor-lagbe");