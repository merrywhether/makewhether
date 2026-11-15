const allowed = require("./.package-graph.cjs");

module.exports = {
	forbidden: [
		{
			name: "pure-packages-no-node",
			severity: "error",
			from: { path: "^packages/(domain|machines)/src/" },
			to: { dependencyTypes: ["core"] },
		},
		...Object.entries(allowed).map(([name, dependencies]) => ({
			name: `${name}-dependencies`,
			severity: "error",
			from: { path: `^packages/${name}/` },
			to: {
				path: "^(packages/|@makewhether/)[^/]+(/|$)",
				pathNot: `^(packages/|@makewhether/)(${[name, ...dependencies].join("|")})(/|$)`,
			},
		})),
	],
	options: {
		tsConfig: { fileName: "tsconfig.json" },
		tsPreCompilationDeps: true,
		doNotFollow: { path: "node_modules" },
		exclude: { path: "node_modules" },
	},
};
