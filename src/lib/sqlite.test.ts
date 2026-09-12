// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { NativeSqliteDatabase } from "./sqlite";

describe("prepared statement reuse", () => {
	it("reuses native compilation while clearing omitted parameter bindings", () => {
		const db = new NativeSqliteDatabase(":memory:");
		const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
		try {
			expect(db.prepare("select ? a, ? b").get(1, 2)).toEqual({ a: 1, b: 2 });
			expect(db.prepare("select ? a, ? b").get(3)).toEqual({ a: 3, b: null });
			expect(db.prepare("select $a a, $b b").get({ a: 1, b: 2 })).toEqual({
				a: 1,
				b: 2,
			});
			expect(db.prepare("select $a a, $b b").get({ a: 3 })).toEqual({
				a: 3,
				b: null,
			});
			expect(prepare).toHaveBeenCalledTimes(2);
		} finally {
			prepare.mockRestore();
			db.close();
		}
	});

	it("keeps interleaved iterators and point reads independent", () => {
		const db = new NativeSqliteDatabase(":memory:");
		const sql = "select 1 n union all select 2 union all select 3";
		try {
			const first = db.prepare(sql).iterate();
			const second = db.prepare(sql).iterate();
			expect(first.next().value).toEqual({ n: 1 });
			expect(db.prepare(sql).all()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
			expect(second.next().value).toEqual({ n: 1 });
			expect(first.next().value).toEqual({ n: 2 });
			first.return?.();
			expect([...second]).toEqual([{ n: 2 }, { n: 3 }]);
		} finally {
			db.close();
		}
	});

	it("bounds the cache without invalidating retained wrappers and recompiles schema changes", () => {
		const db = new NativeSqliteDatabase(":memory:");
		const retained = db.prepare("select 999 n");
		const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
		try {
			for (let i = 0; i < 128; i++) db.prepare(`select ${i} n`).get();
			expect(retained.get()).toEqual({ n: 999 });
			expect(db.prepare("select 999 n").get()).toEqual({ n: 999 });
			expect(prepare).toHaveBeenCalledTimes(129);
			// The most recently used statement remains cached.
			const calls = prepare.mock.calls.length;
			db.prepare("select 999 n").get();
			expect(prepare).toHaveBeenCalledTimes(calls);
			db.exec("create table sample (a integer); insert into sample values (1)");
			expect(db.prepare("select * from sample").get()).toEqual({ a: 1 });
			db.exec("alter table sample add column b integer default 2");
			expect(db.prepare("select * from sample").get()).toEqual({ a: 1, b: 2 });
		} finally {
			prepare.mockRestore();
			db.close();
		}
		expect(() => db.prepare("select 999 n")).toThrow(
			/closed|not open|finalized|database/iu,
		);
		expect(() => retained.get()).toThrow(
			/closed|not open|finalized|database/iu,
		);
	});
});
