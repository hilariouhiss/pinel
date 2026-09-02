import { describe, expect, it, vi } from "vitest";
import pinelWorkflowsExtension from "./pinel-workflows.js";

// /startup 注册器是 Symbol.for 全局槽——stub 掉注册调用，冒烟验证工厂接线即可。
vi.mock("@juicesharp/rpiv-workflow/startup", () => {
	const fn = () => {};
	return {
		registerBuiltInsProvider: vi.fn(),
		registerSkillContractsProvider: vi.fn(),
		registerLifecycle: vi.fn((l: unknown) => l),
		registerBuiltIns: vi.fn(),
		registerSkillContracts: vi.fn(),
	};
});

describe("pinel-workflows 扩展工厂", () => {
	it("无 PINEL_PLUGIN 也注册工作流/契约/生命周期（不抛错）", async () => {
		delete process.env.PINEL_PLUGIN;
		const pi = { on: vi.fn(), registerCommand: vi.fn() };
		expect(() => pinelWorkflowsExtension(pi as never)).not.toThrow();
		const startup = await import("@juicesharp/rpiv-workflow/startup");
		expect(startup.registerBuiltInsProvider).toHaveBeenCalled();
		expect(startup.registerSkillContractsProvider).toHaveBeenCalled();
		expect(startup.registerLifecycle).toHaveBeenCalled();
	});

	it("provider 求值后注册 3 条工作流与 5 份契约", async () => {
		const startup = await import("@juicesharp/rpiv-workflow/startup");
		const providers = (startup.registerBuiltInsProvider as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
		const contracts = (startup.registerSkillContractsProvider as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
		await providers[0]();
		await contracts[0]();
		expect(startup.registerBuiltIns).toHaveBeenCalled();
		const wfs = (startup.registerBuiltIns as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(wfs.map((w: { name: string }) => w.name)).toEqual(["sp-build", "sp-fix", "sp-review"]);
		expect(startup.registerSkillContracts).toHaveBeenCalled();
		const pairs = (startup.registerSkillContracts as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(pairs).toHaveLength(5);
		expect((startup.registerSkillContracts as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("pi-pinel");
	});
});
