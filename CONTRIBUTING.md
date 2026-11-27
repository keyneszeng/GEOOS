# Contributing to GEO/OS

## Local development

Use Node.js >=22.13.0. The live workbench is under `geo/`; `app/` is the historical demonstration frontend. See [repository guide](docs/repository-guide.md) and [business workflow](docs/business-workflow.md).

1. Branch from `main` and scope each change to a single concern.
2. Run `npm run format` before committing. The pinned Prettier release is fetched by npx when necessary; it does not change runtime dependencies.
3. Run `npm run format:check` and `npm run geo:test`. UI changes should also pass the Chromium test described in the repository guide.
4. Open a pull request explaining behavior changes, test coverage and migration/security implications. Avoid mixing formatting-only changes with feature changes.

## Security and data

Do not commit API keys, credentials, databases, customer documents or other sensitive data. Preserve workspace isolation, authorization, human approval, explicit external API consent and quota limits. Report suspected vulnerabilities privately to the repository maintainer.

## License

Contributions to the project's own software are made under the repository's MIT license. Do not relicense third-party resources or remove their attribution. The ESO photograph is separately licensed; see [its notice](geo/assets/README.md).
