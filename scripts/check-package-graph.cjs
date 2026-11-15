const { readdirSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const allowed = require("../.package-graph.cjs");

const packagesDir = resolve("packages");
let failed = false;
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const name = entry.name;
	const manifest = JSON.parse(
		readFileSync(resolve(packagesDir, name, "package.json"), "utf8"),
	);
	const dependencies = allowed[name];
	if (!dependencies) {
		console.error(`Package ${name} is missing from the package graph`);
		failed = true;
		continue;
	}
	for (const field of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
			const alias = /^(?:npm:|workspace:)(@makewhether\/[^@/]+)(?:@|$)/.exec(
				version,
			)?.[1];
			const local = /^(?:file:|link:|workspace:)(\.\.?\/.*)$/.exec(
				version,
			)?.[1];
			const target = alias ?? dependency;
			let internal;
			if (target.startsWith("@makewhether/")) {
				internal = target.slice("@makewhether/".length);
			} else if (local) {
				const localPath = resolve(packagesDir, name, local);
				internal = Object.keys(allowed).find(
					(packageName) => localPath === resolve(packagesDir, packageName),
				);
			}
			if (internal && !dependencies.includes(internal)) {
				console.error(
					`${name}: forbidden ${field} dependency ${dependency} on ${internal}`,
				);
				failed = true;
			}
		}
	}
}
if (failed) process.exitCode = 1;
