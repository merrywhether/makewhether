# makewhether

makewhether runs agent work as statecharts. The engine advances the machines,
workers report outcomes, and people can answer tasks through the same workflow.

The first milestone focuses on checkpoints, restart recovery, and CLI inspection
and replay with fake workers.

## Develop

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm lint
mise exec -- pnpm typecheck
mise exec -- pnpm test
```

See [AGENTS.md](AGENTS.md) for package boundaries and review guidance.

## License

[MIT](LICENSE).
