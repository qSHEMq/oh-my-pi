import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getBaseConfigRoot,
	getConfigDirName,
	getConfigRootDir,
	getLogsDir,
	getNativesDir,
	getPluginsDir,
	getProjectAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";

const ENV_KEYS = [
	"PI_CONFIG_ROOT",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_NATIVES_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

describe("explicit config root", () => {
	let tempRoot: string;
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-root-"));
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("relocates global state without changing legacy project directory names", () => {
		process.env.PI_CONFIG_ROOT = ` ${tempRoot}/unused/../state `;
		process.env.PI_CONFIG_DIR = ".legacy-omp";
		__resetDirsFromEnvForTests();
		const root = path.join(tempRoot, "state");
		expect(getBaseConfigRoot()).toBe(root);
		expect(getConfigRootDir()).toBe(root);
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		expect(getPluginsDir()).toBe(path.join(root, "plugins"));
		expect(getLogsDir()).toBe(path.join(root, "logs"));
		expect(getConfigDirName()).toBe(".legacy-omp");
		expect(getProjectAgentDir(tempRoot)).toBe(path.join(tempRoot, ".omp"));
	});

	it("keeps profiles under the explicit root and shares its native cache", () => {
		process.env.PI_CONFIG_ROOT = tempRoot;
		process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "custom-agent");
		__resetDirsFromEnvForTests();
		expect(getAgentDir()).toBe(path.join(tempRoot, "custom-agent"));
		setProfile("work");
		expect(getBaseConfigRoot()).toBe(tempRoot);
		expect(getConfigRootDir()).toBe(path.join(tempRoot, "profiles", "work"));
		expect(getAgentDir()).toBe(path.join(tempRoot, "profiles", "work", "agent"));
		expect(getPluginsDir()).toBe(path.join(tempRoot, "profiles", "work", "plugins"));
		expect(getNativesDir()).toBe(path.join(tempRoot, "natives"));
		setProfile(undefined);
		expect(getAgentDir()).toBe(path.join(tempRoot, "custom-agent"));
	});

	it("prefers the explicit root over initialized XDG data, state and cache", async () => {
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const) {
			const dir = path.join(tempRoot, key);
			await fs.mkdir(path.join(dir, "omp"), { recursive: true });
			process.env[key] = dir;
		}
		const root = path.join(tempRoot, "physical-state");
		process.env.PI_CONFIG_ROOT = root;
		__resetDirsFromEnvForTests();
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		expect(getPluginsDir()).toBe(path.join(root, "plugins"));
		expect(getLogsDir()).toBe(path.join(root, "logs"));
		expect(getNativesDir()).toBe(path.join(root, "natives"));
	});

	it("keeps the explicit native-cache override above the root and profile", () => {
		process.env.PI_CONFIG_ROOT = path.join(tempRoot, "state");
		process.env.PI_NATIVES_DIR = path.join(tempRoot, "separate-native-cache");
		__resetDirsFromEnvForTests();
		setProfile("work");
		expect(getNativesDir()).toBe(path.join(tempRoot, "separate-native-cache"));
	});

	it("expands tilde before resolving the global root", () => {
		process.env.PI_CONFIG_ROOT = " ~/unused/../omp-state ";
		__resetDirsFromEnvForTests();
		expect(getBaseConfigRoot()).toBe(path.join(os.homedir(), "omp-state"));
	});

	it.each([
		undefined,
		"",
		"  ",
		"relative/state",
		...(process.platform === "win32" ? ["C:relative", "\\root-relative"] : []),
	])("ignores invalid root %j", root => {
		process.env.PI_CONFIG_DIR = ".legacy-omp";
		if (root !== undefined) process.env.PI_CONFIG_ROOT = root;
		__resetDirsFromEnvForTests();
		expect(getBaseConfigRoot()).toBe(path.join(os.homedir(), ".legacy-omp"));
	});
});
