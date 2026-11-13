import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: 30_000,
		// a test must not reach a real provider
		env: { PI_OFFLINE: "1" },
	},
});
