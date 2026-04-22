# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity for Copilot is a VS Code extension that bridges GitHub Copilot Chat to Google Antigravity models (Claude, Gemini, etc.) via VS Code's official Language Model BYOK API. It manages a local CLIProxyAPI process and a local throttling proxy between Copilot and that process.

> **VS Code Insiders required** — the BYOK Language Model API is only available in VS Code Insiders builds.

## Commands

```bash
npm run compile       # Build extension via esbuild (entry: src/extension.ts → dist/extension.js)
npm run watch         # Watch mode for development
npm run package       # Package as .vsix with vsce
npm run lint          # ESLint TypeScript files
```

There is **no test suite**. The `.vscode/launch.json` provides an Extension Host debug configuration.

Build uses `esbuild.js`: CommonJS output, `vscode` externalized, source maps in dev, minified in production.

## Architecture

Three runtime layers sit between Copilot and the Antigravity backend:

```
Copilot Chat
    │
    ▼
ThrottlingProxyServer (port 8420, local)
    │  • ConcurrencyQueue (semaphore per model type)
    │  • RateLimiter (session-level burst prevention)
    │  • Tool output truncation, token clamping
    │  • Thinking stream transformation
    ▼
AntigravityServer / CLIProxyAPI process (port 8317, local)
    │  • Config managed at ~/CLIProxyAPI/config.yaml
    │  • Auth files in ~/.cli-proxy-api/
    ▼
Antigravity backend (Google)
```

### Core Modules

**[src/extension.ts](src/extension.ts)** — Activation entry point. Registers commands, creates the singleton `RateLimiter`, lazily initializes `AntigravityServer` on first command, and wires up `ThrottlingProxyServer` to start/stop alongside the server.

**[src/AntigravityServer.ts](src/AntigravityServer.ts)** — Spawns and manages the CLIProxyAPI child process. Auto-increments port if occupied (up to 10 attempts). Emits `onDidChangeStatus` events consumed by the sidebar and extension.

**[src/ThrottlingProxyServer.ts](src/ThrottlingProxyServer.ts)** — The heaviest file (~1032 lines). An HTTP proxy that: (1) gates requests through `ConcurrencyQueue`, (2) clamps `max_tokens` per model type, (3) truncates oversized tool outputs (keeps head + tail with gap notation), (4) retries on 429/RESOURCE_EXHAUSTED with exponential backoff, (5) pipes streaming responses through `ThinkingStreamTransformer`.

**[src/RateLimiter.ts](src/RateLimiter.ts)** — Singleton. Prevents request bursts. Tracks consecutive 429s and applies exponential backoff on the cooldown (up to 5× base). Works at the session level, complementing the per-request `ConcurrencyQueue`.

**[src/ConcurrencyQueue.ts](src/ConcurrencyQueue.ts)** — Semaphore queue. Thinking models get a separate, lower-concurrency lane (default 1) vs. standard models (default 3).

**[src/models.ts](src/models.ts)** — Static model definitions (`ANTIGRAVITY_MODELS`) plus dynamic fetching from the server's `/v1/models`. Capability flags (tool calling, vision, thinking, token limits) are inferred per model.

**[src/ThinkingStreamTransformer.ts](src/ThinkingStreamTransformer.ts)** — Transforms thinking/reasoning content in SSE streams. Four modes: `none` (passthrough), `annotate`, `enhanced`, `claude`.

**[src/SidebarProvider.ts](src/SidebarProvider.ts)** — Webview sidebar. Polls server status every 5 seconds and surfaces models, start/stop controls, and rate limiter state.

**[src/CLIProxyAPIDownloader.ts](src/CLIProxyAPIDownloader.ts)** — Downloads and extracts the CLIProxyAPI binary into `~/CLIProxyAPI` using `yauzl`.

### Key Constraints

- **Model enablement is manual** — The BYOK API registers model endpoints but cannot enable them in the Copilot UI. Users must click the eye icon per model.
- **Thinking model limits** — Separate concurrency (1 vs 3), lower max output tokens (1024 vs 4096), and a separate timeout (`thinkingTimeoutMs`, default 60s) to avoid quota exhaustion.
- **Tool output truncation** — Only applies to `role: "tool"` messages. Keeps configurable head + tail chars with a gap marker. Default: 6000 head + 2000 tail out of 12000 max.
- **Port auto-increment** — Handles multiple VS Code instances sharing the same machine.
- **No credentials stored in extension** — Auth entirely managed by CLIProxyAPI in `~/.cli-proxy-api/`.

### Where to Make Changes

| Task | File |
|------|------|
| Add/remove models | [src/models.ts](src/models.ts) (`ANTIGRAVITY_MODELS`) |
| New VS Code command | [src/extension.ts](src/extension.ts) + `package.json` `contributes.commands` |
| Rate limiting behavior | [src/RateLimiter.ts](src/RateLimiter.ts) |
| Proxy request/response handling | [src/ThrottlingProxyServer.ts](src/ThrottlingProxyServer.ts) |
| Thinking stream transforms | [src/ThinkingStreamTransformer.ts](src/ThinkingStreamTransformer.ts) |
| Sidebar UI | [src/SidebarProvider.ts](src/SidebarProvider.ts) |
| Server process lifecycle | [src/AntigravityServer.ts](src/AntigravityServer.ts) |
| New user-facing settings | `package.json` `contributes.configuration` |
