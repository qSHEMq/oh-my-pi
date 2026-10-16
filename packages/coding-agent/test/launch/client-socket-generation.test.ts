import { expect, it, vi } from "bun:test";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";

class ControlledConnection implements IpcConnection {
	closed = false;
	readonly sent = Promise.withResolvers<string>();
	onLine: ((line: string) => void) | undefined;
	onClose: ((reason: string | null) => void) | undefined;

	start(onLine: (line: string) => void, onClose: (reason: string | null) => void): void {
		this.onLine = onLine;
		this.onClose = onClose;
	}

	startRaw(): never {
		throw new Error("Expected line framing");
	}

	send(frame: string | Uint8Array): boolean {
		if (typeof frame !== "string") throw new Error("Expected a text RPC frame");
		this.sent.resolve(frame);
		return !this.closed;
	}

	async drained(): Promise<void> {}
	end(): void {
		this.destroy();
	}
	destroy(): void {
		this.closed = true;
		this.onClose?.(null);
	}
	ref(): void {}
	unref(): void {}
}

function requestId(frame: string): string {
	const value: unknown = JSON.parse(frame);
	if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
		throw new Error("Invalid RPC request");
	}
	return value.id;
}

it.each(["close", "malformed frame"] as const)(
	"does not reject a replacement connection's RPC after an old socket's %s",
	async event => {
		using root = TempDir.createSync("@omp-client-generation-");
		const oldSocket = new ControlledConnection();
		const newSocket = new ControlledConnection();
		let connections = 0;
		const client = await createDaemonBrokerClient(root.path(), { runtimeDir: path.join(root.path(), "runtime") });
		const connect = vi
			.spyOn(IpcConnection, "connect")
			.mockImplementation(async () => (connections++ === 0 ? oldSocket : newSocket));
		try {
			const oldRequest = client.request({ op: "ping" }).then(
				value => ({ status: "resolved", value }),
				error => ({ status: "rejected", error }),
			);
			await oldSocket.sent.promise;
			// Native closed state can become visible before its final JS callbacks arrive.
			oldSocket.closed = true;
			const newRequest = client.request({ op: "ping" }).then(
				value => ({ status: "resolved", value }),
				error => ({ status: "rejected", error }),
			);
			const frame = await newSocket.sent.promise;
			if (event === "close") oldSocket.onClose?.(null);
			else oldSocket.onLine?.("not-json");
			newSocket.onLine?.(
				JSON.stringify({ id: requestId(frame), ok: true, result: { op: "ping", projectDir: client.projectDir } }),
			);
			expect((await oldRequest).status).toBe("rejected");
			expect(await newRequest).toEqual({
				status: "resolved",
				value: { op: "ping", projectDir: client.projectDir },
			});
		} finally {
			client.close();
			connect.mockRestore();
		}
	},
);
