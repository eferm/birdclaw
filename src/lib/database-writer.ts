import { Effect } from "effect";
import { assertWritableDeployment } from "./config";
import type { Database } from "./sqlite";
import {
	defaultServerRuntimeServices,
	type ServerRuntimeServices,
} from "./server-runtime-services";
import {
	recordDatabaseWriteCompleted,
	recordDatabaseWriteQueued,
	recordDatabaseWriteStarted,
} from "./database-metrics";

let writeTails = new Map<string | object, Promise<void>>();

export function enqueueDatabaseWrite<T>(
	write: (db: Database) => T,
	providedDb?: Database,
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): Promise<T> {
	try {
		assertWritableDeployment();
	} catch (error) {
		return Promise.reject(error);
	}
	const db = providedDb ?? runtime.getDatabase({ seedDemoData: false });
	const writeIdentity = db.writeIdentity;
	const queuedAt = performance.now();
	recordDatabaseWriteQueued();
	const writeTail = writeTails.get(writeIdentity) ?? Promise.resolve();
	const pending = writeTail.then(() => {
		assertWritableDeployment();
		recordDatabaseWriteStarted(performance.now() - queuedAt);
		try {
			const result = db.transaction(() => write(db))();
			recordDatabaseWriteCompleted(false);
			return result;
		} catch (error) {
			recordDatabaseWriteCompleted(true);
			throw error;
		}
	});
	const settled = pending.then(
		() => undefined,
		() => undefined,
	);
	writeTails.set(writeIdentity, settled);
	void settled.then(() => {
		if (writeTails.get(writeIdentity) === settled) {
			writeTails.delete(writeIdentity);
		}
	});
	return pending;
}

export function databaseWriteEffect<T>(
	write: (db: Database) => T,
	providedDb?: Database,
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
) {
	return Effect.tryPromise({
		try: () => enqueueDatabaseWrite(write, providedDb, runtime),
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

export function resetDatabaseWriterForTests() {
	writeTails = new Map();
}
