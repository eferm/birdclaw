// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BirdclawMcpRuntime } from "./mcp-http";
import { startProductionServer } from "./production-server";

const tempDirs: string[] = [];
const originalLocalWeb = process.env.BIRDCLAW_LOCAL_WEB;
const originalAllowRemoteWeb = process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
const productionMcpToken = [
	"production-mcp",
	"test-token",
	"0123456789",
	"abcdef",
].join("-");

function serverAddress(
	server: Awaited<ReturnType<typeof startProductionServer>>,
) {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no address");
	return address;
}

function requestServer({
	port,
	path: requestPath,
	host,
	method = "GET",
	body,
	headers = {},
}: {
	port: number;
	path: string;
	host: string;
	method?: string;
	body?: string;
	headers?: Record<string, string>;
}) {
	return new Promise<{
		status: number;
		body: string;
		headers: Record<string, string | string[] | undefined>;
	}>((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path: requestPath,
				method,
				headers: { host, ...headers },
			},
			(response) => {
				let responseBody = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					responseBody += chunk;
				});
				response.once("end", () => {
					resolve({
						status: response.statusCode ?? 0,
						body: responseBody,
						headers: response.headers,
					});
				});
			},
		);
		request.once("error", reject);
		if (body !== undefined) request.write(body);
		request.end();
	});
}

function rawRequest(port: number, payload: string) {
	return new Promise<string>((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let output = "";
		socket.setEncoding("utf8");
		socket.setTimeout(2_000, () => socket.destroy(new Error("raw timeout")));
		socket.once("connect", () => socket.write(payload));
		socket.on("data", (chunk) => {
			output += chunk;
		});
		socket.once("end", () => resolve(output));
		socket.once("error", reject);
	});
}

async function closeServer(
	server: Awaited<ReturnType<typeof startProductionServer>>,
) {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
	if (originalLocalWeb === undefined) delete process.env.BIRDCLAW_LOCAL_WEB;
	else process.env.BIRDCLAW_LOCAL_WEB = originalLocalWeb;
	if (originalAllowRemoteWeb === undefined)
		delete process.env.BIRDCLAW_ALLOW_REMOTE_WEB;
	else process.env.BIRDCLAW_ALLOW_REMOTE_WEB = originalAllowRemoteWeb;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("production server", () => {
	it("admits cached reads and assets but rejects mutation and live API handlers only in read-only mode", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-read-only-http-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(clientDir);
		writeFileSync(path.join(clientDir, "birdclaw-mark.png"), "static logo");
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			'export default {fetch(){return new Response("handler reached")}}',
		);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
			mcpRuntime: null,
		});
		try {
			const base = `http://127.0.0.1:${serverAddress(server).port}`;
			for (const pathname of [
				"/api/query",
				"/api/status",
				"/api/conversation",
				"/birdclaw-mark.png",
			]) {
				expect((await fetch(base + pathname)).status).toBe(200);
			}
			for (const pathname of ["/api/action", "/api/sync", "/api/query"]) {
				for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
					const result = await fetch(base + pathname, { method });
					expect(result.status).toBe(405);
					expect(await result.text()).not.toContain("handler reached");
				}
			}
			for (const pathname of [
				"/api/period-digest",
				"/api/search-discussion",
				"/api/profile-analysis",
				"/api/profile-hydrate",
				"/api/data-sources",
				"/api/xurl-rate-limits",
			]) {
				expect((await fetch(base + pathname)).status).toBe(403);
			}
			vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
			expect(
				await fetch(base + "/api/action", { method: "POST" }).then((value) =>
					value.text(),
				),
			).toBe("handler reached");
		} finally {
			await closeServer(server);
		}
	});
	it("serves built assets before delegating requests to the SSR handler", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-server-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(path.join(clientDir, "assets"), { recursive: true });
		writeFileSync(path.join(clientDir, "assets", "app.js"), "built asset");
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch(request) { return new Response("SSR " + new URL(request.url).pathname + " " + request.headers.get("x-birdclaw-local-peer"), { headers: { "content-type": "text/plain" } }); } };`,
		);

		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
			mcpRuntime: null,
		});
		const address = serverAddress(server);
		const baseUrl = `http://127.0.0.1:${String(address.port)}`;

		await expect(
			fetch(`${baseUrl}/route`, {
				headers: { "x-birdclaw-local-peer": "forged" },
			}).then((response) => response.text()),
		).resolves.toBe("SSR /route 1");
		const asset = await fetch(`${baseUrl}/assets/app.js`);
		expect(await asset.text()).toBe("built asset");
		expect(asset.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect(process.env.BIRDCLAW_LOCAL_WEB).toBe("socket");

		await closeServer(server);
	});

	it("reserves an external MCP hostname before static files and write APIs", async () => {
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB = "1";
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-mcp-host-"),
		);
		tempDirs.push(packageRoot);
		const clientDir = path.join(packageRoot, "client");
		mkdirSync(path.join(clientDir, "assets"), { recursive: true });
		writeFileSync(path.join(clientDir, "assets", "app.js"), "built asset");
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch(request) { return new Response("SSR " + new URL(request.url).pathname, { headers: { "content-type": "text/plain" } }); } };`,
		);
		const mcpRuntime: BirdclawMcpRuntime = {
			config: {
				token: productionMcpToken,
				publicUrl: new URL("https://mcp.example.test/mcp"),
				reserveHost: true,
			},
			account: { id: "acct_primary", handle: "@owner" },
			serverVersion: "test",
		};
		const server = await startProductionServer({
			packageRoot,
			clientDir,
			serverEntry,
			port: 0,
			mcpRuntime,
		});
		const { port } = serverAddress(server);

		try {
			for (const reservedHost of [
				"mcp.example.test",
				"mcp.example.test.",
				"mcp.example.test:443",
			] as const) {
				for (const deniedPath of [
					"/",
					"/api/action",
					"/assets/app.js",
				] as const) {
					const denied = await requestServer({
						port,
						path: deniedPath,
						host: reservedHost,
						method: deniedPath === "/api/action" ? "POST" : "GET",
						body: deniedPath === "/api/action" ? '{"type":"post"}' : undefined,
					});
					expect(denied.status).toBe(404);
					expect(denied.body).not.toContain("SSR");
					expect(denied.body).not.toContain("built asset");
				}
			}

			const app = await requestServer({
				port,
				path: "/api/action",
				host: "app.example.test",
			});
			expect(app.body).toBe("SSR /api/action");

			const mcp = await requestServer({
				port,
				path: "/mcp",
				host: "mcp.example.test",
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
				headers: {
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${productionMcpToken}`,
					"content-type": "application/json",
				},
			});
			expect(mcp.status).toBe(200);
			expect(JSON.parse(mcp.body)).toMatchObject({
				jsonrpc: "2.0",
				id: 1,
				result: {},
			});
		} finally {
			await closeServer(server);
		}
	});

	it("rejects absolute-form and mismatched-authority request targets", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-raw-target-"),
		);
		tempDirs.push(packageRoot);
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch() { return new Response("SSR"); } };`,
		);
		const server = await startProductionServer({
			packageRoot,
			clientDir: packageRoot,
			serverEntry,
			port: 0,
			mcpRuntime: null,
		});
		const { port } = serverAddress(server);

		try {
			const rawTargets = [
				"POST http://mcp.example.test/mcp HTTP/1.1\r\nHost: evil.example",
				"POST //mcp.example.test/mcp HTTP/1.1\r\nHost: evil.example",
				"POST /\\evil.example/mcp HTTP/1.1\r\nHost: evil.example",
				"OPTIONS * HTTP/1.1\r\nHost: evil.example",
				"POST /mcp HTTP/1.1\r\nHost: first.example\r\nHost: second.example",
			] as const;
			for (const requestLineAndHost of rawTargets) {
				const response = await rawRequest(
					port,
					`${requestLineAndHost}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
				);
				expect(response).toContain(" 400 ");
				expect(response).not.toContain("SSR");
			}

			for (const ambiguousTarget of [
				"/mcp?",
				"/mcp.evil",
				"/%6dcp",
				"/mcp%2fevil",
				"/prefix/../mcp",
			] as const) {
				const response = await rawRequest(
					port,
					`POST ${ambiguousTarget} HTTP/1.1\r\n` +
						"Host: app.example.test\r\n" +
						"Content-Length: 100\r\n\r\n" +
						"{",
				);
				expect(response).toContain(" 404 ");
				expect(response.toLowerCase()).toContain("connection: close");
				expect(response).not.toContain("SSR");
			}
		} finally {
			await closeServer(server);
		}
	});

	it("closes unread rejected MCP bodies instead of preserving slow sockets", async () => {
		const packageRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-production-slow-body-"),
		);
		tempDirs.push(packageRoot);
		const serverEntry = path.join(packageRoot, "server.mjs");
		writeFileSync(
			serverEntry,
			`export default { fetch() { return new Response("SSR"); } };`,
		);
		const mcpRuntime: BirdclawMcpRuntime = {
			config: {
				token: productionMcpToken,
				publicUrl: new URL("https://mcp.example.test/mcp"),
				reserveHost: true,
			},
			account: { id: "acct_primary", handle: "@owner" },
			serverVersion: "test",
		};
		const server = await startProductionServer({
			packageRoot,
			clientDir: packageRoot,
			serverEntry,
			port: 0,
			mcpRuntime,
		});
		const { port } = serverAddress(server);

		try {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await new Promise<void>((resolve, reject) => {
					const socket = connect(port, "127.0.0.1");
					socket.once("error", (error) => {
						if ((error as NodeJS.ErrnoException).code === "ECONNRESET")
							resolve();
						else reject(error);
					});
					socket.once("connect", () => {
						socket.write(
							"POST /mcp HTTP/1.1\r\n" +
								"Host: mcp.example.test\r\n" +
								`Authorization: Bearer ${productionMcpToken}\r\n` +
								"Content-Type: application/json\r\n" +
								"Content-Length: 100\r\n\r\n" +
								"{",
							() => {
								socket.destroy();
								setTimeout(resolve, 100);
							},
						);
					});
				});
				expect(errorSpy).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
			}

			const rpcBody = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ping",
			});
			for (const authorizationHeaders of [
				"Authorization: Bearer wrong\r\n" +
					`Authorization: Bearer ${productionMcpToken}`,
				`Authorization: Bearer ${productionMcpToken}\r\n` +
					"Authorization: Bearer wrong",
			] as const) {
				const ambiguous = await rawRequest(
					port,
					"POST /mcp HTTP/1.1\r\n" +
						"Host: mcp.example.test\r\n" +
						`${authorizationHeaders}\r\n` +
						"Content-Type: application/json\r\n" +
						"Accept: application/json, text/event-stream\r\n" +
						`Content-Length: ${String(Buffer.byteLength(rpcBody))}\r\n` +
						"Connection: close\r\n\r\n" +
						rpcBody,
				);
				expect(ambiguous).toContain(" 400 ");
				expect(ambiguous).not.toContain('"result"');
			}

			const streamedOversize = await requestServer({
				port,
				path: "/mcp",
				host: "mcp.example.test",
				method: "POST",
				body: "x".repeat(64 * 1024 + 1),
				headers: {
					authorization: `Bearer ${productionMcpToken}`,
					"content-type": "application/json",
				},
			});
			expect(streamedOversize.status).toBe(413);
			expect(streamedOversize.headers.connection).toBe("close");

			const response = await rawRequest(
				port,
				"POST /mcp HTTP/1.1\r\n" +
					"Host: mcp.example.test\r\n" +
					"Authorization: Bearer wrong\r\n" +
					"Content-Type: application/json\r\n" +
					"Transfer-Encoding: chunked\r\n\r\n" +
					"1\r\n{\r\n",
			);
			expect(response).toContain(" 401 ");
			expect(response.toLowerCase()).toContain("connection: close");
		} finally {
			await closeServer(server);
		}
	});
});
