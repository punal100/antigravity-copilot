import * as vscode from 'vscode';
import { AntigravityServer } from './AntigravityServer';
import { MODEL_LIST } from './models';
import { RateLimiter } from './RateLimiter';
import { ThrottlingProxyServer } from './ThrottlingProxyServer';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity-copilot.sidebarView';
    private _view?: vscode.WebviewView;
    private _server: AntigravityServer;
    private _updateInterval?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getServer: () => AntigravityServer,
        private readonly _getRateLimiter?: () => RateLimiter | undefined,
        private readonly _getProxyServer?: () => ThrottlingProxyServer | undefined
    ) {
        this._server = _getServer();
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Update view when status changes
        this._server.onDidChangeStatus(() => {
            this._updateWebview();
        });

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (data: { type: string; value?: unknown }) => {
            await this._handleMessage(data);
        });

        // Initial render
        await this._updateWebview();

        // Start periodic updates (UI refresh)
        this._updateInterval = setInterval(() => {
            this._updateWebview();
        }, 5000);

        webviewView.onDidDispose(() => {
            if (this._updateInterval) {
                clearInterval(this._updateInterval);
            }
        });
    }

    private async _handleMessage(data: { type: string; value?: unknown }): Promise<void> {
        switch (data.type) {
            case 'startServer':
                await vscode.commands.executeCommand('antigravity-copilot.startServer');
                break;
            case 'stopServer':
                await vscode.commands.executeCommand('antigravity-copilot.stopServer');
                break;
            case 'restartServer':
                await vscode.commands.executeCommand('antigravity-copilot.restartServer');
                break;
            case 'loginAntigravity':
                await vscode.commands.executeCommand('antigravity-copilot.loginAntigravity');
                break;
            case 'configureModels':
                await vscode.commands.executeCommand('antigravity-copilot.configureModels');
                break;
            case 'openSettings':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityCopilot');
                break;
            case 'showLogs':
                await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
                break;
            case 'resetRateLimiter':
                this._getRateLimiter?.()?.reset();
                await this._updateWebview();
                break;
            case 'openRateLimitSettings':
                await vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityCopilot.rateLimit');
                break;
            case 'openExternal': {
                const url = typeof data.value === 'string' ? data.value : undefined;
                if (!url) {
                    return;
                }
                try {
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                } catch {
                    // Ignore malformed URLs or open failures.
                }
                break;
            }
        }
    }

    private async _updateWebview(): Promise<void> {
        if (!this._view) return;
        this._view.webview.html = await this._getHtml();
    }

    private async _getHtml(): Promise<string> {
        const status = this._server.getStatus();
        const isRunning = status.running;
        
        // Get proxy server status
        const proxyStatus = this._getProxyServer?.()?.getStatus();
        const proxyRunning = proxyStatus?.running ?? false;
        const proxyPort = proxyStatus?.port;
        
        // Get rate limiter status
        const rlStatus = this._getRateLimiter?.()?.getStatus();
        const rlStatusText = rlStatus?.isBusy ? '🔄 Busy' : (rlStatus?.isInCooldown ? `⏳ Cooldown (${Math.ceil((rlStatus?.remainingCooldownMs || 0) / 1000)}s)` : '✅ Ready');
        const rlStatusColor = rlStatus?.isBusy ? '#f59e0b' : (rlStatus?.isInCooldown ? '#3b82f6' : '#22c55e');

        const resources = {
            repository: 'https://github.com/punal100/antigravity-copilot',
            issues: 'https://github.com/punal100/antigravity-copilot/issues',
            license: 'https://github.com/punal100/antigravity-copilot/blob/main/LICENSE',
            microsoftDocs:
                'https://code.visualstudio.com/docs/copilot/customization/language-models#_bring-your-own-language-model-key'
        };

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Antigravity</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 16px;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 16px;
        }
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background-color: ${isRunning ? '#22c55e' : '#64748b'};
            animation: ${isRunning ? 'pulse 2s infinite' : 'none'};
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .status-text {
            font-weight: 600;
            font-size: 14px;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
            width: 100%;
            justify-content: center;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-danger {
            background-color: #dc2626;
            color: white;
        }
        .btn-danger:hover {
            background-color: #b91c1c;
        }
        .actions {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 20px;
        }
        .card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .card h3 {
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-widget-border);
            font-size: 12px;
        }
        .info-row:last-child {
            border-bottom: none;
        }
        .info-label {
            color: var(--vscode-descriptionForeground);
        }
        .info-value {
            font-weight: 500;
        }
        .model-list {
            max-height: 200px;
            overflow-y: auto;
        }
        .model-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
            font-size: 11px;
        }
        .model-item:last-child {
            border-bottom: none;
        }
        .model-name {
            flex: 1;
        }
        .model-badge {
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 500;
        }
        .badge-tool { background-color: #3b82f622; color: #3b82f6; }
        .badge-vision { background-color: #8b5cf622; color: #8b5cf6; }
        .badge-thinking { background-color: #f59e0b22; color: #f59e0b; }
        .alert {
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 16px;
            font-size: 12px;
        }
        .alert-warning {
            background-color: #f59e0b22;
            border: 1px solid #f59e0b44;
            color: var(--vscode-foreground);
        }
        .alert-success {
            background-color: #22c55e22;
            border: 1px solid #22c55e44;
            color: var(--vscode-foreground);
        }
        .resource-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 8px;
        }
        .resource-link {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px;
            border-radius: 6px;
            cursor: pointer;
            user-select: none;
            font-size: 12px;
            color: var(--vscode-foreground);
            text-decoration: none;
        }
        .resource-link:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .resource-icon {
            width: 18px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="status-indicator"></div>
        <span class="status-text">${isRunning ? 'Server Running' : 'Server Stopped'}</span>
    </div>

    ${!isRunning ? `
        <div class="alert alert-warning">
            ⚠️ Antigravity server is not running. Start it to use Claude and Gemini models in Copilot Chat.
        </div>
    ` : `
        <div class="alert alert-success">
            ✅ Server is running! You can now use Antigravity models in Copilot Chat.
        </div>
    `}

    <div class="actions">
        ${isRunning ? `
            <button class="btn btn-danger" onclick="stopServer()">⏹️ Stop Server</button>
            <button class="btn btn-secondary" onclick="restartServer()">🔄 Restart Server</button>
        ` : `
            <button class="btn btn-primary" onclick="startServer()">▶️ Start Server</button>
        `}
        <button class="btn btn-secondary" onclick="loginAntigravity()">🔐 Login to Antigravity</button>
        <button class="btn btn-secondary" onclick="configureModels()">⚙️ Configure Models</button>
        <button class="btn btn-secondary" onclick="openSettings()">⚙️ Settings</button>
        <button class="btn btn-secondary" onclick="showLogs()">📋 Show Logs</button>
    </div>

    <div class="card">
        <h3>ℹ️ Server Info</h3>
        <div class="info-row">
            <span class="info-label">Status</span>
            <span class="info-value">${isRunning ? '🟢 Running' : '🔴 Stopped'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">CLI Server Port</span>
            <span class="info-value">${status.config.port}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Proxy Status</span>
            <span class="info-value">${proxyRunning ? '🟢 Running' : '⚫ Disabled'}</span>
        </div>
        ${proxyRunning && proxyPort ? `
        <div class="info-row">
            <span class="info-label">Proxy Port</span>
            <span class="info-value">${proxyPort}</span>
        </div>
        ` : ''}
        <div class="info-row">
            <span class="info-label">Host</span>
            <span class="info-value">${status.config.host}</span>
        </div>
        ${status.pid ? `
        <div class="info-row">
            <span class="info-label">PID</span>
            <span class="info-value">${status.pid}</span>
        </div>
        ` : ''}
        <div class="info-row">
            <span class="info-label">Executable</span>
            <span class="info-value" style="font-size: 10px; word-break: break-all;">${status.config.executablePath}</span>
        </div>
    </div>

    ${rlStatus ? `
    <div class="card">
        <h3>⚡ Rate Limiter</h3>
        <div class="info-row">
            <span class="info-label">Status</span>
            <span class="info-value" style="color: ${rlStatusColor}">${rlStatusText}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Cooldown</span>
            <span class="info-value">${rlStatus.cooldownMs / 1000}s</span>
        </div>
        <div style="margin-top: 12px; display: flex; gap: 8px;">
            ${rlStatus.isBusy || rlStatus.isInCooldown ? `
                <button class="btn btn-secondary" style="flex: 1;" onclick="resetRateLimiter()">🔄 Reset</button>
            ` : ''}
            <button class="btn btn-secondary" style="flex: 1;" onclick="openRateLimitSettings()">⚙️ Settings</button>
        </div>
    </div>
    ` : ''}

    <div class="card">
        <h3>🤖 Available Models (10)</h3>
        <div class="model-list">
            ${MODEL_LIST.map(model => `
                <div class="model-item">
                    <span class="model-name">${model.name}</span>
                    ${model.toolCalling ? '<span class="model-badge badge-tool">Tools</span>' : ''}
                    ${model.vision ? '<span class="model-badge badge-vision">Vision</span>' : ''}
                    ${model.thinking ? '<span class="model-badge badge-thinking">Thinking</span>' : ''}
                </div>
            `).join('')}
        </div>
    </div>

    <div class="card">
        <h3>🚀 Quick Setup</h3>
        <ol style="font-size: 12px; line-height: 1.6; padding-left: 20px; margin-top: 8px;">
            <li>Click "Login to Antigravity" to authenticate</li>
            <li>Click "Start Server" to run CLIProxyAPI</li>
            <li>Click "Configure Models" to add them to Copilot</li>
            <li>Open Copilot Chat and select an Antigravity model</li>
        </ol>
    </div>

    <div class="card">
        <h3>📖 Requirements</h3>
        <ul style="font-size: 11px; line-height: 1.5; padding-left: 20px; margin-top: 8px; color: var(--vscode-descriptionForeground);">
            <li>VS Code Insiders (for custom models)</li>
            <li>GitHub Copilot Pro subscription</li>
            <li>GitHub Copilot + Chat (pre-release)</li>
            <li>CLIProxyAPI installed in %USERPROFILE%\\CLIProxyAPI</li>
        </ul>
    </div>

    <div class="card">
        <h3>🔗 Resources</h3>
        <div class="resource-list">
            <a class="resource-link" href="#" onclick="openExternal('${resources.repository}'); return false;">
                <span class="resource-icon">📦</span>
                <span>Repository</span>
            </a>
            <a class="resource-link" href="#" onclick="openExternal('${resources.issues}'); return false;">
                <span class="resource-icon">🐛</span>
                <span>Issues</span>
            </a>
            <a class="resource-link" href="#" onclick="openExternal('${resources.license}'); return false;">
                <span class="resource-icon">📄</span>
                <span>License</span>
            </a>
            <a class="resource-link" href="#" onclick="openExternal('${resources.microsoftDocs}'); return false;">
                <span class="resource-icon">🧭</span>
                <span>Microsoft (BYOK docs)</span>
            </a>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function startServer() {
            vscode.postMessage({ type: 'startServer' });
        }

        function stopServer() {
            vscode.postMessage({ type: 'stopServer' });
        }

        function restartServer() {
            vscode.postMessage({ type: 'restartServer' });
        }

        function loginAntigravity() {
            vscode.postMessage({ type: 'loginAntigravity' });
        }

        function configureModels() {
            vscode.postMessage({ type: 'configureModels' });
        }

        function openSettings() {
            vscode.postMessage({ type: 'openSettings' });
        }

        function showLogs() {
            vscode.postMessage({ type: 'showLogs' });
        }

        function resetRateLimiter() {
            vscode.postMessage({ type: 'resetRateLimiter' });
        }

        function openRateLimitSettings() {
            vscode.postMessage({ type: 'openRateLimitSettings' });
        }

        function openExternal(url) {
            vscode.postMessage({ type: 'openExternal', value: url });
        }
    </script>
</body>
</html>`;
    }
}
