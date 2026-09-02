import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts", "workflows/**/*.test.ts", "skills/**/*.test.ts"],
		testTimeout: 15_000,
		passWithNoTests: true,
	},
});
