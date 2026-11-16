import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { MongoClient, type Db } from "mongodb";
import type { Env } from "../env";
import { MongoRepositories } from "./repositories";

export interface DatabaseHealth {
  status: "ok";
  database: string;
  latencyMs: number;
}

export interface DatabaseInitialization {
  initialized: true;
  indexes: number;
}

/**
 * Owns the MongoDB client for one Durable Object instance.
 *
 * MongoDB operations must execute inside this class. Do not return Db,
 * Collection, Cursor, or MongoClient instances through Worker RPC.
 */
export class MongoDBConnection extends DurableObject<Env> {
  private readonly client: MongoClient;
  private databasePromise: Promise<Db> | null = null;
  private initializationPromise: Promise<number> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.client = new MongoClient(env.MONGODB_URI, {
      maxPoolSize: 1,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      maxIdleTimeMS: 20_000,
      retryReads: true,
      retryWrites: true,
    });
  }

  private async getDatabase(): Promise<Db> {
    if (!this.env.MONGODB_URI) {
      throw new Error("MongoDB connection is not configured.");
    }

    if (!this.databasePromise) {
      this.databasePromise = this.client
        .connect()
        .then(() => this.client.db(this.env.MONGODB_DATABASE || "rotsi_payments"))
        .catch((error: unknown) => {
          this.databasePromise = null;
          throw error;
        });
    }

    return this.databasePromise;
  }

  async ping(): Promise<DatabaseHealth> {
    const startedAt = Date.now();
    const db = await this.getDatabase();
    await db.command({ ping: 1 });

    return {
      status: "ok",
      database: db.databaseName,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * Explicit, idempotent schema bootstrap. Call this before enabling traffic
   * in a new environment. Index creation is not performed on every request.
   */
  async initialize(): Promise<DatabaseInitialization> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const db = await this.getDatabase();
        const repositories = new MongoRepositories(db);
        const indexes = await repositories.ensureIndexes(db);
        return indexes.length;
      })().catch((error: unknown) => {
        this.initializationPromise = null;
        throw error;
      });
    }

    return {
      initialized: true,
      indexes: await this.initializationPromise,
    };
  }
}
