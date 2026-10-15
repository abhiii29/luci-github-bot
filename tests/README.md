# Tests

## Running

```bash
npm test          # Run all tests once
npm run test:watch  # Run in watch mode
npm run typecheck   # TypeScript type check (no emit)
```

## What is tested

| File | Coverage |
|---|---|
| `tests/llm-parser.test.ts` | `isLocalModelTrigger`, `extractLocalPrompt`, `parseLLMResponse` (valid, CRLF, fallback, dedup, NEEDS_CLARIFICATION, error paths), `parseDecompositionResponse` (JSON, fenced JSON, bad JSON, missing fields, duplicates) |
| `tests/webhook-routing.test.ts` | HMAC signature verification (valid, invalid, missing), event routing (issues vs push), payload validation, repo filtering, assignee filtering (case-sensitive), retry label trigger |
| `tests/metrics.test.ts` | All `MetricsCollector` methods: record, snapshot, recent activity limits, reset |

## Known limitations

- **DynamicSemaphore**: The semaphore class is private inside `docker-worker.ts`. To test it directly, add an export. This was intentionally left unchanged to keep test scope tight.
- **No end-to-end verification**: Real GitHub API, container runtime (podman/docker), and Ollama are not available in CI. All network calls are mocked via `vi.mock`.
- **No config parsing tests**: `config.ts` reads from `.env` and validates with Zod. Testing it would require `.env` manipulation.
- **No resource-monitor tests**: macOS-specific (`top`, `vm_stat`) and not portable.
