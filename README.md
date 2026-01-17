# Antigravity for Copilot

**Expose Google Antigravity models to VS Code via Copilot's official BYOK (Bring Your Own Key) interface** - Manages CLIProxyAPI server lifecycle and configures custom language models using VS Code's supported extension APIs.

> ⚠️ **Disclaimer**: This extension uses VS Code's official [Language Model API](https://code.visualstudio.com/docs/copilot/customization/language-models#_bring-your-own-language-model-key) for custom model configuration. It does not modify GitHub Copilot internals, intercept Copilot traffic, or patch any Copilot files. This project is unofficial and not affiliated with GitHub, Microsoft, Google, or Anthropic.

## 🌟 Features

- **One-Click Server Management**: Start/stop CLIProxyAPI directly from VS Code
- **Automatic Configuration**: Creates default `config.yaml` if missing
- **BYOK Model Registration**: Registers Antigravity models using VS Code's official Language Model API
- **Status Bar Integration**: Quick visual status and server controls
- **Sidebar Dashboard**: Monitor server status, view available models, and manage settings
- **Auto-Start Support**: Configure the server to start automatically with VS Code
- **Authentication Launcher**: Launches Antigravity's authentication flow via CLIProxyAPI
- **Rate Limiting**: Built-in rate limiter to prevent 429 errors with thinking models
- **Optional Throttling Proxy**: Local proxy that queues BYOK requests and can clamp max output tokens to reduce upstream 429s

## 🤖 Available Models (10)

| Model                        | Description            | Capabilities    |
| ---------------------------- | ---------------------- | --------------- |
| Claude Sonnet 4.5            | Latest Claude model    | Tools           |
| Claude Sonnet 4.5 (Thinking) | Extended thinking mode | Tools, Thinking |
| Claude Opus 4.5 (Thinking)   | Most powerful Claude   | Tools, Thinking |
| Gemini 2.5 Flash             | Fast Gemini model      | Tools           |
| Gemini 2.5 Flash Lite        | Lightweight Gemini     | Tools           |
| Gemini 3 Pro (Preview)       | Latest Gemini Pro      | Tools           |
| Gemini 3 Flash (Preview)     | Latest Gemini Flash    | Tools           |
| Gemini 3 Pro Image (Preview) | Gemini with vision     | Tools, Vision   |
| Gemini 2.5 Computer Use      | Computer interaction   | Tools, Vision   |
| gpt-oss-120b-medium          | Open source model      | Basic           |

## 📦 Prerequisites

1. **VS Code Insiders** (required for custom models support)

   ```powershell
   winget install --id Microsoft.VisualStudioCode.Insiders
   ```

2. **GitHub Copilot Pro** subscription

3. **GitHub Copilot Extensions** (pre-release versions)

   ```powershell
   code-insiders --install-extension github.copilot --pre-release
   code-insiders --install-extension github.copilot-chat --pre-release
   ```

4. **CLIProxyAPI** installed in `%USERPROFILE%\CLIProxyAPI\`

   ```powershell
   $zipPath = "$env:TEMP\CLIProxyAPI.zip"
   $extractPath = "$env:USERPROFILE\CLIProxyAPI"
   Invoke-WebRequest -Uri "https://github.com/router-for-me/CLIProxyAPI/releases/download/v6.6.103/CLIProxyAPI_6.6.103_windows_amd64.zip" -OutFile $zipPath
   Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
   Remove-Item $zipPath
   ```

5. **CLIProxyAPI Configuration**: (Optional) The extension will automatically create a default `config.yaml` if one doesn't exist.
   - Default location: `%USERPROFILE%\CLIProxyAPI\config.yaml`
   - Default content:
     ```yaml
     port: 8317
     host: "127.0.0.1"
     auth-dir: "C:\\Users\\<USERNAME>\\.cli-proxy-api"
     providers:
       antigravity:
         enabled: true
     ```

## 🚀 Quick Start

### Step 1: Install the Extension

1. Download the `.vsix` file
2. Open VS Code Insiders
3. Press `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
4. Select the downloaded file

### Step 2: Authenticate

1. Click the **Antigravity** icon in the Activity Bar
2. Click **"Login to Antigravity"** button
3. Follow the authentication flow in the terminal (Server will stop temporarily during login)

### Step 3: Start Server

1. Click **"Start Server"** in the sidebar
2. Wait for the server to start (status will turn green)

### Step 4: Configure Models

1. Click **"Configure Models"** button
2. Reload VS Code when prompted
3. Open Copilot Chat (`Ctrl+Alt+I`)
4. Click the model picker dropdown → **"Manage Models..."**
5. Find the **Antigravity** models and click the **eye icon** to enable them
6. The models will now appear in the model picker dropdown

## ⚙️ Configuration

Open VS Code Settings (`Ctrl+,`) and search for `antigravityCopilot`:

### Server Settings

| Setting                 | Default     | Description                      |
| ----------------------- | ----------- | -------------------------------- |
| `server.enabled`        | `false`     | Enable server on startup         |
| `server.autoStart`      | `false`     | Auto-start server with VS Code   |
| `server.executablePath` | (auto)      | Path to cli-proxy-api.exe        |
| `server.port`           | `8317`      | Starting port (auto-increments if in use) |
| `server.host`           | `127.0.0.1` | Server host                      |
| `autoConfigureCopilot`  | `true`      | Auto-configure models on startup |
| `showNotifications`     | `true`      | Show notifications               |

### Rate Limiting Settings

Rate limiting provides a safety net for thinking models. The primary 429 mitigation is now **aggressive retries** matching Antigravity IDE's behavior.

| Setting                       | Default | Description                      |
| ----------------------------- | ------- | -------------------------------- |
| `rateLimit.enabled`           | `true`  | Enable rate limiting             |
| `rateLimit.cooldownMs`        | `5000`  | Base cooldown between requests   |
| `rateLimit.showNotifications` | `true`  | Show notifications when blocked  |

#### Exponential Backoff

When consecutive 429 errors occur, the rate limiter automatically applies **exponential backoff**:

- Each consecutive 429 doubles the effective cooldown (up to 5× the base)
- The backoff resets after a successful request
- Check current backoff status via Command Palette → "Antigravity: Rate Limit Status"

This prevents hammering the upstream server when quota is exhausted.

### Proxy Settings

The optional throttling proxy queues requests to prevent upstream 429 errors with thinking models. Thinking models use reduced token limits (`maxInputTokens: 32000`, `maxOutputTokens: 2048`) to minimize quota burn.

| Setting                       | Default     | Description                                         |
| ----------------------------- | ----------- | --------------------------------------------------- |
| `proxy.enabled`               | `true`      | Enable the local throttling proxy                   |
| `proxy.host`                  | `127.0.0.1` | Proxy bind host                                     |
| `proxy.port`                  | `8420`      | Starting port for proxy (auto-increments if in use) |
| `proxy.rewriteMaxTokens`      | `true`      | Clamp output tokens to reduce long generations      |
| `proxy.maxTokensThinking`     | `1024`      | Max output tokens for Thinking models               |
| `proxy.maxTokensStandard`     | `4096`      | Max output tokens for standard models               |
| `proxy.logRequests`           | `true`      | Log request metadata (model, status, duration)      |
| `proxy.transformThinking`     | `true`      | Transform streaming responses for thinking display  |
| `proxy.thinkingTransformMode` | `annotate`  | Transform mode: `none`, `annotate`, `enhanced`, or `claude` |
| `proxy.thinkingTimeoutMs`     | `60000`     | Timeout for Thinking requests (abort long runs)     |
| `proxy.requestTimeoutMs`      | `120000`    | Timeout for standard requests                       |
| `proxy.truncateToolOutput`    | `true`      | Truncate very large tool outputs (e.g., git diff)   |
| `proxy.maxToolOutputChars`    | `12000`     | Max chars kept per tool output after truncation     |
| `proxy.toolOutputHeadChars`   | `6000`      | Chars kept from start of tool output                |
| `proxy.toolOutputTailChars`   | `2000`      | Chars kept from end of tool output                  |
| `proxy.maxRequestBodyBytes`   | `10485760`  | Max request body size; returns 413 if exceeded      |
| `proxy.thinkingConcurrency`   | `1`         | Max concurrent requests for Thinking models         |
| `proxy.standardConcurrency`   | `3`         | Max concurrent requests for standard models         |
| `proxy.maxRetries`            | `3`         | Retry attempts for 429 errors (0 to disable)        |
| `proxy.retryBaseDelayMs`      | `1000`      | Base delay before first retry (exponential backoff) |

#### Thinking Transform Modes

The proxy can transform streaming responses from Thinking models to help clients display reasoning content:

- **`none`**: Direct passthrough without any transformation (most compatible)
- **`annotate`** (default): Adds minimal `_is_thinking` markers to delta objects
- **`enhanced`**: Adds comprehensive thinking block markers in OpenAI format
- **`claude`**: Full conversion to Anthropic/Claude streaming format (experimental)

#### Timeouts (prevent long-thinking quota burn)

Long “thinking” runs can consume a lot of quota (even if you didn’t request a huge visible answer). The proxy can abort long-running requests:

- `antigravityCopilot.proxy.thinkingTimeoutMs` (default: 60s)
- `antigravityCopilot.proxy.requestTimeoutMs` (default: 120s)

#### Tool output truncation (reduce context size)

Copilot Chat tool calls like `git diff` can produce very large outputs that get embedded into subsequent requests. This increases prompt size and can trigger upstream `RESOURCE_EXHAUSTED`.

When enabled, the proxy truncates **only** messages with `role: "tool"` that exceed your configured limits:

- `antigravityCopilot.proxy.truncateToolOutput: true`
- `antigravityCopilot.proxy.maxToolOutputChars: 12000`
- `antigravityCopilot.proxy.toolOutputHeadChars: 6000`
- `antigravityCopilot.proxy.toolOutputTailChars: 2000`

If you want to hard-limit request size regardless, set:

- `antigravityCopilot.proxy.maxRequestBodyBytes` (default: 10MB)

#### Concurrency queue (prevent request bursts)

Copilot Chat can fire multiple requests per prompt (tools, retries, follow-ups). For resource-intensive **Thinking** models, this can trip upstream quota even if you only clicked once.

The proxy uses a **semaphore-based concurrency queue** with separate limits for thinking vs standard models:

- `antigravityCopilot.proxy.thinkingConcurrency: 1` (keep low to avoid exhaustion)
- `antigravityCopilot.proxy.standardConcurrency: 3`

Excess requests queue until a slot opens. Thinking requests have lower priority than standard requests.

#### Retry with exponential backoff (Antigravity IDE-style)

When 429 or `RESOURCE_EXHAUSTED` errors occur, the proxy automatically retries with **aggressive short-delay retries** matching Antigravity IDE's approach:

- `antigravityCopilot.proxy.maxRetries: 5` (set to 0 to disable)
- `antigravityCopilot.proxy.retryBaseDelayMs: 100` (almost immediate first retry)

Retry delays: ~200ms → ~400ms → ~800ms → ~1.6s → ~3.2s. Most 429 errors resolve within 2-3 retries.

### Example settings.json

```json
{
  "antigravityCopilot.server.autoStart": true,
  "antigravityCopilot.autoConfigureCopilot": true,
  "antigravityCopilot.showNotifications": true,
  "antigravityCopilot.rateLimit.enabled": true,
  "antigravityCopilot.rateLimit.cooldownMs": 5000,
  "antigravityCopilot.proxy.enabled": true,
  "antigravityCopilot.proxy.thinkingConcurrency": 1,
  "antigravityCopilot.proxy.standardConcurrency": 3,
  "antigravityCopilot.proxy.maxRetries": 5,
  "antigravityCopilot.proxy.retryBaseDelayMs": 100,
  "antigravityCopilot.proxy.thinkingTimeoutMs": 60000,
  "antigravityCopilot.proxy.requestTimeoutMs": 120000,
  "antigravityCopilot.proxy.truncateToolOutput": true,
  "antigravityCopilot.proxy.maxToolOutputChars": 12000,
  "antigravityCopilot.proxy.toolOutputHeadChars": 6000,
  "antigravityCopilot.proxy.toolOutputTailChars": 2000,
  "antigravityCopilot.proxy.maxRequestBodyBytes": 10485760
}
```

## 🎮 Commands

Access commands via Command Palette (`Ctrl+Shift+P`):

- **Antigravity: Start Server** - Start the CLIProxyAPI server
- **Antigravity: Stop Server** - Stop the server
- **Antigravity: Restart Server** - Restart the server
- **Antigravity: Login to Antigravity** - Authenticate with Google
- **Antigravity: Configure Models** - Add models to Copilot Chat
- **Antigravity: Show Server Controls** - Open quick controls menu
- **Antigravity: Rate Limit Status** - View and manage rate limiter status

## ❓ Troubleshooting

### Server won't start

- Verify CLIProxyAPI is installed at `%USERPROFILE%\CLIProxyAPI\cli-proxy-api.exe`
- Check if port 8317 is already in use: `netstat -ano | findstr :8317`
- Review logs: Click "Show Logs" in the dashboard

### Models not appearing in Copilot Chat

- Ensure you're using **VS Code Insiders** (not stable VS Code)
- Ensure Copilot extensions are **pre-release** versions
- Click "Configure Models" and reload VS Code
- Check if Custom OpenAI feature is available (gradual rollout)

### Authentication failed

- Run `Antigravity: Login to Antigravity` command
- Follow the browser authentication flow
- Check auth files in `%USERPROFILE%\.cli-proxy-api\`

### Rate limit (429) errors

429 `RESOURCE_EXHAUSTED` indicates a **quota or concurrency limit** on the server side — not a syntax error. Common causes:

- Too many concurrent requests (especially with Thinking models)
- Hitting model-provider GPU/compute quota
- Very large context causing expensive internal passes
- Repeated long "thinking" requests consuming extra backend resources

**Quick fixes:**

- Enable rate limiting: `antigravityCopilot.rateLimit.enabled: true`
- Increase cooldown if errors persist: `antigravityCopilot.rateLimit.cooldownMs: 30000`
- Enable tool output truncation to reduce context size
- Check rate limiter status via Command Palette → "Antigravity: Rate Limit Status"
- Reset the rate limiter from the sidebar dashboard if needed

The rate limiter applies **exponential backoff** automatically after consecutive 429s.

#### If 429 happens repeatedly with Thinking models

Copilot Chat can send multiple requests per prompt (tools, retries, follow-ups). For resource-intensive **Thinking** models, this can trip upstream quota/throttling even if you only clicked once.

This extension includes an **optional local throttling proxy** that queues requests before they reach CLIProxyAPI. It does not modify Copilot internals; it simply changes the BYOK endpoint URL Copilot uses.

1. Enable the proxy:
   - `antigravityCopilot.proxy.enabled: true`
2. Re-run **Antigravity: Configure Models**, then reload VS Code.
3. Use a longer cooldown (start with 30–60s):
   - `antigravityCopilot.rateLimit.cooldownMs: 60000`

If you still see `RESOURCE_EXHAUSTED` immediately, your Antigravity account/model quota may be exhausted; switch to a lighter model or wait for quota reset.

#### Diagnosing 429s (proxy request logging)

If you want to understand _why_ 429s happen (bursting, large requested outputs, etc.), you can enable proxy request logging.

- Setting: `antigravityCopilot.proxy.logRequests: true`
- What it logs: request metadata only (endpoint, model, token limits, status code, duration)
- What it does **not** log: your prompt text or chat content

Open the **Antigravity** output channel to view `[PROXY ...]` log lines.

## 🛠️ Building from Source

### Prerequisites

1. **Node.js** (v18 or later)

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

2. **VS Code Extension Manager (vsce)**
   ```powershell
   npm install -g @vscode/vsce
   ```

### Build Steps

1. **Clone the repository**

   ```powershell
   git clone https://github.com/punal100/antigravity-copilot.git
   cd antigravity-copilot
   ```

2. **Install dependencies**

   ```powershell
   npm install
   ```

3. **Compile TypeScript**

   ```powershell
   npm run compile
   ```

4. **Package the extension**

   ```powershell
   # Using npm script
   npm run package

   # Or directly with vsce
   vsce package
   ```

   This creates a `.vsix` file (e.g., `antigravity-copilot-1.5.1.vsix`) in the project root.

### Development

- **Watch mode** (auto-recompile on changes):

  ```powershell
  npm run watch
  ```

- **Lint the code**:
  ```powershell
  npm run lint
  ```

### Installing the Built Extension

1. Open VS Code Insiders
2. Press `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
3. Select the generated `.vsix` file

## 🔗 Resources

- [Repository](https://github.com/punal100/antigravity-copilot)
- [Issues](https://github.com/punal100/antigravity-copilot/issues)
- [License](https://github.com/punal100/antigravity-copilot/blob/main/LICENSE)
- [Microsoft (Copilot BYOK docs)](https://code.visualstudio.com/docs/copilot/customization/language-models#_bring-your-own-language-model-key)
- [CLIProxyAPI GitHub](https://github.com/router-for-me/CLIProxyAPI)

## 📝 License

MIT License

## 🏗️ Architecture

This extension:

1. **Manages CLIProxyAPI**: A local OpenAI-compatible proxy server that launches and manages Antigravity authentication via CLIProxyAPI
2. **Registers Models via BYOK**: Uses VS Code/Copilot's BYOK setting `github.copilot.chat.customOAIModels` to register custom OpenAI-compatible endpoints
3. **Displays Status**: Provides a sidebar UI for server management and status monitoring

No Copilot internals are modified. The extension only uses documented VS Code APIs and settings.

## Compliance Boundary

This extension explicitly does **NOT**:

- ❌ Modify GitHub Copilot internals or files
- ❌ Host or redistribute any AI models
- ❌ Collect, store, or transmit user credentials
- ❌ Intercept or proxy GitHub Copilot’s own service traffic
- ❌ Provide access to Antigravity (users must obtain access independently)
- ❌ Connect to any internal/private services

Notes:

- ✅ If you enable `antigravityCopilot.proxy.enabled`, the extension runs an optional _local_ throttling proxy **only for the BYOK endpoint you configured** (Copilot → your local endpoint). This is used to queue requests and reduce upstream 429s.

## Credits

- **Punal Manalan** - Author and maintainer
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - The proxy server powering this extension

---

## ⚠️ Legal Notice

**This extension requires CLIProxyAPI and a Google account with Antigravity access.**

- This project **does not provide access to Antigravity** — users must obtain access independently
- This project is **unofficial** and **not affiliated** with GitHub, Microsoft, Google, Anthropic, or OpenAI
- Users are responsible for ensuring their use complies with all applicable terms of service
- The authors assume no liability for any misuse or ToS violations
- Antigravity access may be subject to eligibility requirements or usage policies set by Google
