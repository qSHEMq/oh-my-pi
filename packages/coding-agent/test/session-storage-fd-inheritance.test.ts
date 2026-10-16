/**
 * Descriptors omp holds for its own lifetime — session/advisor transcripts and
 * the rotating log — must not reach the commands the bash tool runs.
 *
 * The bash tool executes through the natives brush shell, which `fork`/`exec`s
 * external commands. Before #13224 a command — or any daemon it started —
 * could hold a writable handle to the session it was launched from.
 *
 * Oracle: verify the private descriptors are open in the parent, then list a
 * real child's descriptor table. The child explicitly opens a control fd
 * before execing `ls`, so the listing cannot pass vacuously. Do not assume a
 * raw Bun fs.openSync descriptor is inheritable: Bun 1.4.3 sets O_CLOEXEC.
 * /proc makes this Linux-only; the helper's flag handling is covered on every
 * platform by `packages/utils/test/fs-open.test.ts`.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { RotatingFileSink } from "@oh-my-pi/pi-utils/logger/rotating-file";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { FileSessionStorage } from "../src/session/session-storage";

const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);

	const storage = new FileSessionStorage();
	const transcript = path.join(root, "session.jsonl");
	const writer = storage.openWriter(transcript);
	await writer.append('{"type":"session_start"}\n');

	const logsDir = path.join(root, "logs");
	await fsp.mkdir(logsDir, { recursive: true });
	const logSink = new RotatingFileSink({
		directory: logsDir,
		filenamePrefix: "omp",
		filenameSuffix: String(process.pid),
		maxBytes: 1 << 20,
		maxFiles: 2,
	});
	logSink.write("entry");

	const control = path.join(root, "control.jsonl");
	let output = "";
	try {
		const parentTargets: string[] = [];
		for (const fd of fs.readdirSync("/proc/self/fd")) {
			try {
				parentTargets.push(fs.readlinkSync(`/proc/self/fd/${fd}`));
			} catch (error) {
				// The directory listing itself can have already closed its fd.
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		expect(parentTargets).toContain(transcript);
		expect(parentTargets.some(target => target.startsWith(`${logsDir}${path.sep}`))).toBe(true);
		const result = await new Shell().run(
			{ command: "sh -c 'exec 9>>control.jsonl; ls -l /proc/$$/fd'", cwd: root },
			(_err, chunk) => {
				output += chunk;
			},
		);
		expect(result.exitCode).toBe(0);
	} finally {
		logSink.close();
		await writer.close();
	}

	const inherited = output.split("\n").filter(line => line.includes(root));
	expect(inherited.join("\n"), "control: the child's explicit descriptor must reach ls").toContain(control);
	expect(inherited.join("\n")).not.toContain(transcript);
	expect(inherited.join("\n")).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
