# Contributing to Ameria Bank MCP Server

Thanks for your interest in contributing! This is an unofficial, open-source project and contributions are welcome.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone git@github.com:YOUR_USERNAME/ameria-mcp.git
   cd ameria-mcp
   npm install
   ```
3. Create a branch for your change:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

Run the server locally:

```bash
AMERIA_TOKEN=your_token node server.js
```

Test with MCP Inspector:

```bash
AMERIA_TOKEN=your_token npm run inspect
```

Run tests:

```bash
npm test
```

## Making Changes

- Keep the codebase simple — this is a single-file server by design
- All pure/helper functions go in `helpers.js` with corresponding tests in `helpers.test.js`
- API integration and tool definitions stay in `server.js`
- All tests must pass before submitting a PR

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Add or update tests for any new helper functions
4. Run `npm test` and ensure all tests pass
5. Open a pull request against `main` with a clear description of the change

## Adding New Tools

If you want to add a new Ameria API endpoint as an MCP tool:

1. Capture the request/response from the MyAmeria web app using browser DevTools
2. Add the tool definition in `server.js` following the existing pattern
3. Add any new formatting helpers to `helpers.js` with tests
4. Use the shared `readOnlyAnnotations`, `dateSchema`, and `paginationSchema` where applicable
5. Wrap the handler in try/catch and use `errorResponse()` for errors

## Guidelines

- **Read-only only.** Do not add tools that modify account state (transfers, payments, etc.)
- **No secrets in code.** Never commit tokens, account numbers, or personal data
- **Keep it minimal.** Avoid adding dependencies unless absolutely necessary
- **Test your helpers.** All pure functions in `helpers.js` should have test coverage

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version (`node --version`)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
