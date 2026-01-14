import * as vscode from 'vscode';
import { AntigravityServer } from './AntigravityServer';
import { SidebarProvider } from './SidebarProvider';
import { ANTIGRAVITY_MODELS, fetchModelsFromServer } from './models';
import { RateLimiter } from './RateLimiter';
import { ThrottlingProxyServer, ThrottlingProxyConfig } from './ThrottlingProxyServer';

let server: AntigravityServer | undefined;
let rateLimiter: RateLimiter | undefined;
let proxyServer: ThrottlingProxyServer | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Antigravity');
    outputChannel = output;
    context.subscriptions.push(output);

    // Initialize rate limiter
    rateLimiter = RateLimiter.getInstance(output);
    context.subscriptions.push(rateLimiter);

    // Optional throttling proxy (queues/copilots requests to avoid upstream 429s)
    proxyServer = new ThrottlingProxyServer(output, rateLimiter);
    context.subscriptions.push(proxyServer);

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'antigravity-copilot.showServerControls';
    context.subscriptions.push(statusItem);

    // Status Bar Update
    const updateStatusBar = () => {
        if (!server) {
            statusItem.text = '$(circle-slash) Antigravity: OFF';
            statusItem.tooltip = 'Antigravity server is stopped';
            statusItem.backgroundColor = undefined;
            statusItem.show();
            return;
        }

        const status = server.getStatus();
        if (status.running) {
            statusItem.text = '$(broadcast) Antigravity: ON';
            statusItem.tooltip = new vscode.MarkdownString(`
**$(broadcast) Antigravity Server**

| Info | Value |
|------|-------|
| Status | 🟢 Running |
| Port | ${status.config.port} |
| Models | 10 |

*Click to open controls*
            `);
            statusItem.tooltip.isTrusted = true;
            statusItem.backgroundColor = undefined;
        } else {
            statusItem.text = '$(circle-slash) Antigravity: OFF';
            statusItem.tooltip = 'Click to start Antigravity server';
            statusItem.backgroundColor = undefined;
        }
        statusItem.show();
    };

    // Lazy Server Accessor
    const getServer = (): AntigravityServer => {
        if (server) {
            return server;
        }

        const srv = new AntigravityServer(output, context);
        server = srv;
        context.subscriptions.push(srv);

        // Hook up listeners
        server.onDidChangeStatus(() => {
            updateStatusBar();
        });

        updateStatusBar();
        return srv;
    };

    // Rate Limiter Getter
    const getRateLimiter = (): RateLimiter | undefined => rateLimiter;

    // Register Sidebar Provider
    const sidebarProvider = new SidebarProvider(context.extensionUri, getServer, getRateLimiter);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
    );

    // Register Commands
    const startServerCommand = vscode.commands.registerCommand('antigravity-copilot.startServer', async () => {
        try {
            const srv = getServer();
            await srv.start();
            
            const config = vscode.workspace.getConfiguration('antigravityCopilot');
            if (config.get<boolean>('showNotifications', true)) {
                const selection = await vscode.window.showInformationMessage(
                    'Antigravity server started successfully',
                    'Open Dashboard',
                    'Configure Models'
                );
                if (selection === 'Open Dashboard') {
                    await vscode.commands.executeCommand('antigravity-copilot.sidebarView.focus');
                } else if (selection === 'Configure Models') {
                    await vscode.commands.executeCommand('antigravity-copilot.configureModels');
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to start Antigravity server: ${message}`);
            output.appendLine(`[ERROR] ${message}`);
        }
    });

    const stopServerCommand = vscode.commands.registerCommand('antigravity-copilot.stopServer', async () => {
        if (server) {
            await server.stop();
            const config = vscode.workspace.getConfiguration('antigravityCopilot');
            if (config.get<boolean>('showNotifications', true)) {
                vscode.window.showInformationMessage('Antigravity server stopped');
            }
        }
    });

    const restartServerCommand = vscode.commands.registerCommand('antigravity-copilot.restartServer', async () => {
        const srv = getServer();
        await srv.restart();
    });

    const loginCommand = vscode.commands.registerCommand('antigravity-copilot.loginAntigravity', async () => {
        const srv = getServer();
        await srv.login();
    });

    const configureModelsCommand = vscode.commands.registerCommand('antigravity-copilot.configureModels', async () => {
        await configureAntigravityModels();
    });

    const showServerControlsCommand = vscode.commands.registerCommand('antigravity-copilot.showServerControls', async () => {
        const srv = getServer();
        const status = srv.getStatus();
        const items: vscode.QuickPickItem[] = [];

        if (status.running) {
            items.push({
                label: '$(check) Server is Running',
                description: `Port ${status.config.port}`,
                kind: vscode.QuickPickItemKind.Separator
            });
            items.push({
                label: '$(stop-circle) Stop Server',
                description: 'Stop the Antigravity server'
            });
            items.push({
                label: '$(refresh) Restart Server',
                description: 'Restart the server'
            });
        } else {
            items.push({
                label: '$(x) Server is Stopped',
                kind: vscode.QuickPickItemKind.Separator
            });
            items.push({
                label: '$(play-circle) Start Server',
                description: 'Start the Antigravity server'
            });
        }

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(sign-in) Login to Antigravity',
            description: 'Authenticate with Google'
        });
        items.push({
            label: '$(settings-gear) Configure Models',
            description: 'Add models to Copilot Chat'
        });
        items.push({
            label: '$(dashboard) Open Dashboard',
            description: 'View server status and logs'
        });
        items.push({
            label: '$(gear) Open Settings',
            description: 'Configure extension settings'
        });

        // Add rate limit status
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        const rlStatus = rateLimiter?.getStatus();
        if (rlStatus) {
            const rlIcon = rlStatus.isBusy ? '$(sync~spin)' : (rlStatus.isInCooldown ? '$(clock)' : '$(check)');
            const rlText = rlStatus.isBusy ? 'Busy' : (rlStatus.isInCooldown ? `Cooldown (${Math.ceil(rlStatus.remainingCooldownMs / 1000)}s)` : 'Ready');
            items.push({
                label: `${rlIcon} Rate Limit Status`,
                description: `${rlText} | ${rlStatus.intensity} mode`
            });
            if (rlStatus.isBusy || rlStatus.isInCooldown) {
                items.push({
                    label: '$(refresh) Reset Rate Limiter',
                    description: 'Clear cooldown and allow requests'
                });
            }
        }

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'Manage Antigravity Server',
            title: 'Antigravity Controls'
        });

        if (!selection) {
            return;
        }

        if (selection.label.includes('Stop Server')) {
            await srv.stop();
        } else if (selection.label.includes('Start Server')) {
            await srv.start();
        } else if (selection.label.includes('Restart Server')) {
            await srv.restart();
        } else if (selection.label.includes('Login to Antigravity')) {
            await srv.login();
        } else if (selection.label.includes('Configure Models')) {
            await configureAntigravityModels();
        } else if (selection.label.includes('Open Dashboard')) {
            await vscode.commands.executeCommand('antigravity-copilot.sidebarView.focus');
        } else if (selection.label.includes('Open Settings')) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityCopilot');
        } else if (selection.label.includes('Rate Limit Status')) {
            await vscode.commands.executeCommand('antigravity-copilot.rateLimitStatus');
        } else if (selection.label.includes('Reset Rate Limiter')) {
            rateLimiter?.reset();
            vscode.window.showInformationMessage('Rate limiter reset successfully');
        }
    });

    // Rate Limit Status Command
    const rateLimitStatusCommand = vscode.commands.registerCommand('antigravity-copilot.rateLimitStatus', async () => {
        if (!rateLimiter) {
            vscode.window.showErrorMessage('Rate limiter not initialized');
            return;
        }

        const status = rateLimiter.getStatus();
        const statusIcon = status.isBusy ? '$(sync~spin)' : (status.isInCooldown ? '$(clock)' : '$(check)');
        const statusText = status.isBusy ? 'Busy' : (status.isInCooldown ? `Cooldown (${Math.ceil(status.remainingCooldownMs / 1000)}s)` : 'Ready');
        
        const message = `**Rate Limiter Status**\n\n` +
            `| Status | ${statusIcon} ${statusText} |\n` +
            `| Intensity | ${status.intensity} |\n` +
            `| Cooldown | ${status.cooldownMs / 1000}s |`;

        const selection = await vscode.window.showInformationMessage(
            `Rate Limiter: ${statusText} | Intensity: ${status.intensity} | Cooldown: ${status.cooldownMs / 1000}s`,
            'Reset',
            'Open Settings'
        );

        if (selection === 'Reset') {
            rateLimiter.reset();
            vscode.window.showInformationMessage('Rate limiter reset successfully');
        } else if (selection === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityCopilot.rateLimit');
        }
    });

    context.subscriptions.push(
        startServerCommand,
        stopServerCommand,
        restartServerCommand,
        loginCommand,
        configureModelsCommand,
        showServerControlsCommand,
        rateLimitStatusCommand
    );

    // Initial status bar update
    statusItem.text = '$(circle-slash) Antigravity: OFF';
    statusItem.show();

    // Auto-start logic
    const config = vscode.workspace.getConfiguration('antigravityCopilot.server');
    const enabled = config.get<boolean>('enabled', false);
    const autoStart = config.get<boolean>('autoStart', false);

    output.appendLine(`[DEBUG] Activation. Enabled: ${enabled}, AutoStart: ${autoStart}`);

    if (enabled || autoStart) {
        const srv = getServer();
        void srv.start().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`[ERROR] Failed to start server: ${message}`);
        });
    }

    // Start throttling proxy if enabled
    void startProxyIfEnabled(output).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[ERROR] Failed to start throttling proxy: ${message}`);
    });

    // Restart proxy when relevant settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            if (
                e.affectsConfiguration('antigravityCopilot.proxy') ||
                e.affectsConfiguration('antigravityCopilot.rateLimit') ||
                e.affectsConfiguration('antigravityCopilot.server.host') ||
                e.affectsConfiguration('antigravityCopilot.server.port')
            ) {
                void startProxyIfEnabled(output).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    output.appendLine(`[ERROR] Failed to restart throttling proxy: ${message}`);
                });
            }
        })
    );

    // Auto-configure models if enabled
    const autoConfigureCopilot = vscode.workspace.getConfiguration('antigravityCopilot').get<boolean>('autoConfigureCopilot', true);
    if (autoConfigureCopilot) {
        void configureAntigravityModels(true);
    }
}

async function startProxyIfEnabled(output: vscode.OutputChannel): Promise<void> {
    if (!proxyServer) {
        return;
    }

    const proxyCfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
    const serverCfg = vscode.workspace.getConfiguration('antigravityCopilot.server');

    const enabled = proxyCfg.get<boolean>('enabled', false);
    if (!enabled) {
        await proxyServer.stop();
        return;
    }

    const cfg: ThrottlingProxyConfig = {
        enabled: true,
        host: proxyCfg.get<string>('host', '127.0.0.1'),
        port: proxyCfg.get<number>('port', 8320),
        upstreamHost: serverCfg.get<string>('host', '127.0.0.1'),
        upstreamPort: serverCfg.get<number>('port', 8317),
    };

    await proxyServer.start(cfg);
    output.appendLine(`[DEBUG] Proxy enabled. Base URL: http://${cfg.host}:${cfg.port}/v1`);
}

async function configureAntigravityModels(silent: boolean = false): Promise<void> {
    try {
        const serverConfig = vscode.workspace.getConfiguration('antigravityCopilot.server');
        const host = serverConfig.get<string>('host', '127.0.0.1');
        const port = serverConfig.get<number>('port', 8317);

        // Determine which base URL Copilot should use.
        const proxyConfig = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
        const proxyEnabled = proxyConfig.get<boolean>('enabled', false);
        const proxyHost = proxyConfig.get<string>('host', '127.0.0.1');
        const proxyPort = proxyConfig.get<number>('port', 8320);
        const baseUrl = proxyEnabled ? `http://${proxyHost}:${proxyPort}/v1` : `http://${host}:${port}/v1`;

        // Ensure the proxy is running before pointing Copilot at it.
        if (proxyEnabled && outputChannel) {
            await startProxyIfEnabled(outputChannel);
        }

        let models: Record<string, unknown>;

        // Try to fetch models dynamically from the server
        try {
            models = await fetchModelsFromServer(host, port);
            if (!silent) {
                vscode.window.showInformationMessage(`Fetched ${Object.keys(models).length} models from Antigravity server`);
            }
        } catch (fetchError) {
            // Fallback to static models if server is not available
            const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
            if (!silent) {
                vscode.window.showWarningMessage(`Could not fetch models from server (${message}). Using default models.`);
            }
            models = ANTIGRAVITY_MODELS;
        }

        // Ensure all configured model URLs point at the chosen base URL (direct or proxy).
        models = rewriteModelUrls(models, baseUrl);

        const config = vscode.workspace.getConfiguration('github.copilot');
        const existingModels = config.get<Record<string, unknown>>('chat.customOAIModels', {});
        
        // Merge with existing models
        const updatedModels = { ...existingModels, ...models };
        
        await config.update('chat.customOAIModels', updatedModels, vscode.ConfigurationTarget.Global);
        
        if (!silent) {
            const selection = await vscode.window.showInformationMessage(
                'Antigravity models configured! After reload, go to Copilot Chat → Model Picker → Manage Models to enable them.',
                'Reload',
                'Open Manage Models'
            );
            if (selection === 'Reload') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else if (selection === 'Open Manage Models') {
                vscode.commands.executeCommand('workbench.action.chat.openLanguageModelsSettings');
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to configure models: ${message}`);
    }
}

function rewriteModelUrls(models: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
    const updated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(models)) {
        if (value && typeof value === 'object' && 'url' in value) {
            updated[key] = { ...(value as any), url: baseUrl };
        } else {
            updated[key] = value;
        }
    }
    return updated;
}

export function deactivate() {
    // Cleanup handled by subscriptions
}
