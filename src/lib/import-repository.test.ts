// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
	getImportRepository,
	resetImportRepositoriesForTests,
} from "./import-repository";
import { NativeSqliteDatabase } from "./sqlite";

let db: NativeSqliteDatabase | undefined;

afterEach(() => {
	db?.close();
	db = undefined;
	resetImportRepositoriesForTests();
});

describe("import repository", () => {
	it("owns bulk row and FTS persistence", () => {
		db = new NativeSqliteDatabase(":memory:");
		db.exec(`
      create table items (id text primary key, value text);
      create table tweets_fts (tweet_id text, text text);
    `);
		const repository = getImportRepository(db);

		repository.insertRows(
			"insert into items (id, value) values (?, ?)",
			[{ id: "one", value: "first" }],
			["id", "value"],
		);
		repository.insertFtsRows({
			target: { table: "tweets_fts", idColumn: "tweet_id" },
			rows: [
				{ id: "one", text: "first" },
				{ id: "one", text: "duplicate" },
			],
			idKey: "id",
			textKey: "text",
		});

		expect(db.prepare("select * from items").all()).toEqual([
			{ id: "one", value: "first" },
		]);
		expect(db.prepare("select * from tweets_fts").all()).toEqual([
			{ tweet_id: "one", text: "first" },
		]);
	});

	it("reindexes a batch from final canonical text without exposing tombstones", () => {
		const statements: string[] = [];
		db = new NativeSqliteDatabase(":memory:", {
			onStatement: (sql) => statements.push(sql),
		});
		db.exec(`
			create table tweets (id text primary key, text text, deleted_at text, superseded_at text);
			create virtual table tweets_fts using fts5(tweet_id unindexed, text);
			insert into tweets values ('one', 'complete Note Tweet', null, null),
			  ('deleted', 'deleted body', '2026-01-01', null),
			  ('superseded', 'old revision', null, '2026-01-01');
			insert into tweets_fts values ('one', 'preview'), ('one', 'duplicate'),
			  ('deleted', 'deleted body'), ('superseded', 'old revision'), ('other', 'untouched');
		`);
		statements.length = 0;
		getImportRepository(db).reindexTweets(
			[
				{ id: "one", text: "preview" },
				{ id: "one" },
				{ id: "deleted" },
				{ id: "superseded" },
				{ id: null },
			],
			"id",
		);
		expect(
			statements.filter((sql) => sql.startsWith("delete from tweets_fts")),
		).toHaveLength(1);
		expect(
			db.prepare("select * from tweets_fts order by tweet_id").all(),
		).toEqual([
			{ tweet_id: "one", text: "complete Note Tweet" },
			{ tweet_id: "other", text: "untouched" },
		]);
	});

	it("clears only account-owned mention sync state", () => {
		db = new NativeSqliteDatabase(":memory:");
		db.exec("create table sync_cache (cache_key text primary key)");
		const keys = [
			"mentions:sync:cursor:v2:mode=xurl:account=acct_primary:page=100:boundary=auto",
			"mentions:sync:result:v2:mode=xurl:account=acct_primary:page=100:boundary=auto:single:all-pages",
			"mentions:sync:result:v2:mode=bird:account=acct_primary:page=100:boundary=auto:all:all-pages",
			"mentions:sync:high-water:v1:mode=xurl:account=acct_primary",
			"mentions:sync:cursor:v2:mode=xurl:account=acct_other:page=100:boundary=auto",
			"mentions:sync:high-water:v1:mode=xurl:account=acct_other",
			"mentions:export:xurl:acct_primary:100:all:all-pages",
		];
		const insert = db.prepare("insert into sync_cache (cache_key) values (?)");
		for (const key of keys) insert.run(key);

		getImportRepository(db).clearMentionSyncState("acct_primary");

		expect(
			db.prepare("select cache_key from sync_cache order by cache_key").all(),
		).toEqual(
			keys
				.slice(4)
				.sort()
				.map((cache_key) => ({ cache_key })),
		);
	});
});
