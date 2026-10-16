import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initLoaderContext, prepareNativeVersionDir } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"PI_NATIVES_DIR",
	"PI_CONFIG_ROOT",
	"OMP_PROFILE",
	"PI_PROFILE",
	"XDG_DATA_HOME",
	"PI_NATIVE_VARIANT",
	"__PI_NATIVE_VARIANT_CACHE",
] as const;

describe("native addon directory override", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dir-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_NATIVE_VARIANT = "baseline";
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("places the versioned cache outside a fresh HOME and takes precedence over initialized XDG", async () => {
		const shared = path.join(tempRoot, "shared");
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.PI_NATIVES_DIR = ` ${shared} `;
		process.env.PI_CONFIG_ROOT = path.join(tempRoot, "config-root");

		const ctx = initLoaderContext({ isCompiledBinary: true });
		prepareNativeVersionDir(ctx.versionedDir);

		expect(ctx.versionedDir).toBe(path.join(shared, packageJson.version));
		process.env.XDG_DATA_HOME = xdgData;
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(ctx.versionedDir);
		expect(await fs.readdir(shared)).toEqual([packageJson.version]);
		expect(await fs.readdir(home)).toEqual([]);
		expect(await fs.readdir(path.join(xdgData, "omp"))).toEqual([]);
	});
	it("uses PI_CONFIG_ROOT for compiled extraction independently of the active profile", async () => {
		const root = path.join(tempRoot, "config-root");
		process.env.PI_CONFIG_ROOT = ` ${root} `;

		process.env.OMP_PROFILE = "work";
		const workContext = initLoaderContext({ isCompiledBinary: true });
		prepareNativeVersionDir(workContext.versionedDir);
		process.env.OMP_PROFILE = "other";
		const otherContext = initLoaderContext({ isCompiledBinary: true });

		const nativesDir = path.join(root, "natives");
		expect(workContext.versionedDir).toBe(path.join(nativesDir, packageJson.version));
		expect(otherContext.versionedDir).toBe(workContext.versionedDir);
		expect(await fs.readdir(nativesDir)).toEqual([packageJson.version]);
		expect(await fs.readdir(home)).toEqual([]);
	});
	it("expands a home-relative PI_CONFIG_ROOT before adding the shared natives directory", () => {
		process.env.PI_CONFIG_ROOT = " ~/unused/../config ";

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(home, "config", "natives", packageJson.version),
		);
	});

	it("expands home-relative overrides before appending the package version", () => {
		process.env.PI_NATIVES_DIR = "~";
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(path.join(home, packageJson.version));

		process.env.PI_NATIVES_DIR = " ~/unused/../shared ";
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(home, "shared", packageJson.version),
		);
	});

	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/natives"],
	])("falls back to XDG when the override is %s", async (_label, override) => {
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;
		process.env.PI_NATIVES_DIR = override;

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(xdgData, "omp", "natives", packageJson.version),
		);
	});
	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/config"],
		...(process.platform === "win32"
			? [
					["drive-relative", "C:relative"],
					["root-relative", "\\root-relative"],
				]
			: []),
	])("falls back to XDG when PI_CONFIG_ROOT is %s", async (_label, override) => {
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;
		process.env.PI_CONFIG_ROOT = override;

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(xdgData, "omp", "natives", packageJson.version),
		);
	});
});
