import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { Data, Effect } from "effect";
import { runEffectPromise } from "./effect-runtime";
import { isReadOnlyDeployment } from "./config";

const execFileAsync = promisify(execFile) as unknown as (
	command: string,
	args: readonly string[],
	options?: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		maxBuffer?: number;
		killSignal?: NodeJS.Signals | number;
		signal?: AbortSignal;
	},
) => Promise<unknown> & { child?: ChildProcess };

export interface SubprocessOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxBufferBytes?: number;
	killSignal?: NodeJS.Signals | number;
	acceptedExitCodes?: readonly number[];
	redactValues?: readonly string[];
	redact?: (value: string) => string;
}

export interface SubprocessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	signal?: NodeJS.Signals;
}

export class SubprocessError extends Data.TaggedError("SubprocessError")<{
	readonly message: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode?: number;
	readonly signal?: NodeJS.Signals;
	readonly code?: string | number;
	readonly causeWasError: boolean;
	readonly timedOut: boolean;
	readonly aborted: boolean;
}> {}

type ExecFailure = Error & {
	code?: string | number;
	killed?: boolean;
	signal?: NodeJS.Signals;
	stdout?: string | Buffer;
	stderr?: string | Buffer;
};

function outputText(value: unknown) {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}

function resultOutput(value: unknown) {
	if (typeof value === "string" || Buffer.isBuffer(value)) {
		return { stdout: outputText(value), stderr: "" };
	}
	if (!value || typeof value !== "object") {
		return { stdout: "", stderr: "" };
	}
	return {
		stdout: outputText("stdout" in value ? value.stdout : ""),
		stderr: outputText("stderr" in value ? value.stderr : ""),
	};
}

function redactSecretUrls(value: string) {
	return value.replace(
		/([a-z][a-z0-9+.-]*:\/\/)([^/@:\s]+)(?::([^/@\s]+))?@/gi,
		(_match, protocol: string) => `${protocol}REDACTED@`,
	);
}

function createRedactor(options: SubprocessOptions) {
	return (value: string) => {
		let redacted = redactSecretUrls(value);
		for (const secret of options.redactValues ?? []) {
			if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
		}
		return options.redact ? options.redact(redacted) : redacted;
	};
}

function failureDetails(cause: unknown) {
	const failure = cause instanceof Error ? (cause as ExecFailure) : undefined;
	return {
		message: failure?.message ?? String(cause),
		stdout: outputText(failure?.stdout),
		stderr: outputText(failure?.stderr),
		code: failure?.code,
		exitCode: typeof failure?.code === "number" ? failure.code : undefined,
		signal: failure?.signal,
	};
}

function subprocessError(
	options: SubprocessOptions,
	cause: unknown,
	state: { timedOut: boolean; aborted: boolean },
) {
	const redact = createRedactor(options);
	const details = failureDetails(cause);
	const command = redact(options.command);
	const args = (options.args ?? []).map(redact);
	const fallback = `${command}${args.length > 0 ? ` ${args.join(" ")}` : ""} failed`;
	const message = state.timedOut
		? `${fallback}: timed out (aborted)`
		: state.aborted
			? `${fallback}: aborted`
			: redact(details.message || fallback);
	return new SubprocessError({
		message,
		command,
		args,
		stdout: redact(details.stdout),
		stderr: redact(details.stderr),
		...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
		...(details.signal === undefined ? {} : { signal: details.signal }),
		...(details.code === undefined ? {} : { code: details.code }),
		causeWasError: cause instanceof Error,
		timedOut: state.timedOut,
		aborted: state.aborted,
	});
}

function validatedTimeout(options: SubprocessOptions) {
	if (options.timeoutMs === undefined) return undefined;
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
		throw new TypeError("timeoutMs must be a finite non-negative number");
	}
	return options.timeoutMs;
}

export function runSubprocessEffect(
	options: SubprocessOptions,
): Effect.Effect<SubprocessResult, SubprocessError | TypeError> {
	return Effect.suspend(() => {
		if (isReadOnlyDeployment())
			return Effect.fail(
				new TypeError(
					"Subprocesses are disabled in a read-only archive deployment",
				),
			);
		let timeoutMs: number | undefined;
		try {
			timeoutMs = validatedTimeout(options);
		} catch (error) {
			return Effect.fail(error as TypeError);
		}
		return Effect.async<SubprocessResult, SubprocessError>((resume) => {
			const args = options.args ?? [];
			const acceptedExitCodes = new Set(options.acceptedExitCodes ?? [0]);
			const controller =
				timeoutMs !== undefined || options.signal
					? new AbortController()
					: undefined;
			let timedOut = false;
			let aborted = Boolean(options.signal?.aborted);
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => {
				aborted = true;
				controller?.abort();
			};
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const finish = (
				exit: Effect.Effect<SubprocessResult, SubprocessError>,
			) => {
				if (settled) return;
				settled = true;
				cleanup();
				resume(exit);
			};

			if (aborted || timeoutMs === 0) {
				timedOut = !aborted;
				finish(
					Effect.fail(
						subprocessError(options, new Error("aborted"), {
							timedOut,
							aborted,
						}),
					),
				);
				return Effect.void;
			}

			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					timedOut = true;
					controller?.abort();
				}, timeoutMs);
			}
			const execOptions = {
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.env ? { env: options.env } : {}),
				...(options.maxBufferBytes === undefined
					? {}
					: { maxBuffer: options.maxBufferBytes }),
				...(options.killSignal === undefined
					? {}
					: { killSignal: options.killSignal }),
				...(controller ? { signal: controller.signal } : {}),
			};
			const hasExecOptions = Object.keys(execOptions).length > 0;
			let pending: ReturnType<typeof execFileAsync>;
			try {
				pending = hasExecOptions
					? execFileAsync(options.command, args, execOptions)
					: execFileAsync(options.command, args);
			} catch (cause) {
				finish(
					Effect.fail(subprocessError(options, cause, { timedOut, aborted })),
				);
				return Effect.void;
			}
			void pending.then(
				(value) => {
					const output = resultOutput(value);
					finish(
						Effect.succeed({ ...output, exitCode: 0 } as SubprocessResult),
					);
				},
				(cause: unknown) => {
					const details = failureDetails(cause);
					if (
						details.exitCode !== undefined &&
						acceptedExitCodes.has(details.exitCode)
					) {
						finish(
							Effect.succeed({
								stdout: details.stdout,
								stderr: details.stderr,
								exitCode: details.exitCode,
								...(details.signal ? { signal: details.signal } : {}),
							}),
						);
						return;
					}
					finish(
						Effect.fail(subprocessError(options, cause, { timedOut, aborted })),
					);
				},
			);
			return Effect.sync(() => {
				cleanup();
				if (!settled) {
					settled = true;
					controller?.abort();
					pending.child?.kill(options.killSignal);
				}
			});
		});
	});
}

export function runSubprocess(options: SubprocessOptions) {
	return runEffectPromise(runSubprocessEffect(options));
}
