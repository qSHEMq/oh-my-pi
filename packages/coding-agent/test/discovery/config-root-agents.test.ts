import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { __resetDirsFromEnvForTests, getAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const ENV_KEYS = [
	"PI_CONFIG_ROOT",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

describe("relocated user agents", () => {
	let temp: string;
	let home: string;
	let root: string;
	let cwd: string;
	let before: Partial<Record<(typeof ENV_KEYS)[number], string>>;

	beforeEach(async () => {
		before = {};
		for (const key of ENV_KEYS) {
			before[key] = process.env[key];
			delete process.env[key];
		}
		temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-root-agents-"));
		home = path.join(temp, "home");
		root = path.join(temp, "physical");
		cwd = path.join(temp, "project");
		await fs.mkdir(home);
		await fs.mkdir(cwd);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		process.env.PI_CONFIG_ROOT = root;
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			if (before[key] === undefined) delete process.env[key];
			else process.env[key] = before[key];
		}
		__resetDirsFromEnvForTests();
		await fs.rm(temp, { recursive: true, force: true });
	});

	function hub() {
		const auth = createInMemoryAuthStorage();
		const deps = createAgentsHubDeps(cwd, Settings.isolated(), new ModelRegistry(auth), () => ({
			explicit: [],
			configured: [],
			configuredLevel: "user",
			mode: "explicit-only",
		}));
		return { auth, deps };
	}

	it.each([undefined, "work"])("saves and discovers user agents under the selected root/profile %j", async profile => {
		setProfile(profile);
		const agentBase = profile ? path.join(root, "profiles", profile, "agent") : path.join(root, "agent");
		const legacyBase = profile
			? path.join(home, ".omp", "profiles", profile, "agent")
			: path.join(home, ".omp", "agent");
		await Bun.write(
			path.join(legacyBase, "agents", "legacy-decoy.md"),
			"---\nname: legacy-decoy\ndescription: Wrong root\n---\nDo not load this user root.\n",
		);
		const { auth, deps } = hub();
		try {
			const saved = await deps.saveAgent("user", {
				identifier: "root-probe",
				whenToUse: "Review relocated data",
				systemPrompt: "Inspect the selected workspace.",
			});
			expect(saved).toBe(path.join(agentBase, "agents", "root-probe.md"));
			const agents = await deps.loadAgents();
			expect(agents.find(agent => agent.name === "root-probe")?.description).toBe("Review relocated data");
			expect(agents.some(agent => agent.name === "legacy-decoy")).toBe(false);
			await expect(
				deps.saveAgent("user", { identifier: "root-probe", whenToUse: "Replace", systemPrompt: "Replace" }),
			).rejects.toThrow("already exists");
		} finally {
			auth.close();
		}
	});

	it("keeps the same agent name isolated across default and named profiles", async () => {
		const { auth, deps } = hub();
		try {
			await deps.saveAgent("user", {
				identifier: "root-isolated",
				whenToUse: "Default scope",
				systemPrompt: "Default profile",
			});
			setProfile("work");
			expect((await deps.loadAgents()).some(agent => agent.name === "root-isolated")).toBe(false);
			await deps.saveAgent("user", {
				identifier: "root-isolated",
				whenToUse: "Work scope",
				systemPrompt: "Work profile",
			});
			expect((await deps.loadAgents()).find(agent => agent.name === "root-isolated")?.description).toBe(
				"Work scope",
			);
			setProfile(undefined);
			expect((await deps.loadAgents()).find(agent => agent.name === "root-isolated")?.description).toBe(
				"Default scope",
			);
		} finally {
			auth.close();
		}
	});

	it("preserves generic discovery's independence from a custom agent directory", () => {
		process.env.PI_CODING_AGENT_DIR = path.join(temp, "custom-agent");
		__resetDirsFromEnvForTests();
		expect(getAgentDir()).toBe(path.join(temp, "custom-agent"));
		expect(getConfigDirs("agents", { project: false })[0]?.path).toBe(path.join(root, "agent", "agents"));
		delete process.env.PI_CONFIG_ROOT;
		process.env.PI_CONFIG_DIR = ".legacy-omp";
		__resetDirsFromEnvForTests();
		expect(getConfigDirs("agents", { project: false })[0]?.path).toBe(
			path.join(home, ".legacy-omp", "agent", "agents"),
		);
	});
});
