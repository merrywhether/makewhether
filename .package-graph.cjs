module.exports = {
	domain: [],
	machines: ["domain"],
	store: ["domain"],
	config: ["domain"],
	runner: ["domain", "config"],
	host: ["domain", "machines", "store", "config", "runner"],
	cli: ["domain"],
};
