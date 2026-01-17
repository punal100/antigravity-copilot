import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AntigravityServer } from './AntigravityServer';
import { SidebarProvider } from './SidebarProvider';
import { ANTIGRAVITY_MODELS, CopilotModelConfig, fetchModelsFromServer } from './models';
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

        let autoConfiguredOnce = false;

        // Hook up listeners
        server.onDidChangeStatus(() => {
            updateStatusBar();
            // Start/stop proxy based on server status
            const status = server!.getStatus();
            if (status.running) {
                // Server started - start proxy pointing to actual port
                void (async () => {
                    try {
                        const proxyPort = await startProxyIfEnabled(output, status.config.port);
                        
                        // Determine the active endpoint URL
                        const proxyConfig = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
                        const proxyEnabled = proxyConfig.get<boolean>('enabled', false);
                        const proxyHost = proxyConfig.get<string>('host', '127.0.0.1');
                        const serverHost = status.config.host;
                        
                        const activeUrl = proxyEnabled && proxyPort
                            ? `http://${proxyHost}:${proxyPort}/v1`
                            : `http://${serverHost}:${status.config.port}/v1`;
                        
                        // Always update stored endpoints to match current config
                        await updateStoredEndpoints(activeUrl);
                        output.appendLine(`[INFO] Updated stored model endpoints to: ${activeUrl}`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        output.appendLine(`[ERROR] Failed during server startup: ${message}`);
                    }
                })();

                // Auto-configure models only after the server is running.
                // This avoids noisy BYOK warnings when the server is OFF.
                const autoConfigureCopilot = vscode.workspace
                    .getConfiguration('antigravityCopilot')
                    .get<boolean>('autoConfigureCopilot', true);
                if (autoConfigureCopilot && !autoConfiguredOnce) {
                    autoConfiguredOnce = true;
                    void configureAntigravityModels(true);
                }
            } else {
                // Server stopped - stop proxy too
                void proxyServer?.stop();
            }
        });

        updateStatusBar();
        return srv;
    };

    // Rate Limiter Getter
    const getRateLimiter = (): RateLimiter | undefined => rateLimiter;

    // Proxy Server Getter
    const getProxyServer = () => proxyServer;

    // Register Sidebar Provider
    const sidebarProvider = new SidebarProvider(context.extensionUri, getServer, getRateLimiter, getProxyServer);
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
        // Stop proxy first
        if (proxyServer) {
            await proxyServer.stop();
        }
        // Restart main server (proxy will auto-start via onDidChangeStatus)
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
                description: `${rlText} | Cooldown ${rlStatus.cooldownMs / 1000}s`
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
        const statusText = status.isBusy ? 'Busy' : (status.isInCooldown ? `Cooldown (${Math.ceil(status.remainingCooldownMs / 1000)}s)` : 'Ready');

        const selection = await vscode.window.showInformationMessage(
            `Rate Limiter: ${statusText} | Cooldown: ${status.cooldownMs / 1000}s`,
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
        // Proxy will auto-start via onDidChangeStatus when server becomes ready
        void srv.start().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`[ERROR] Failed to start server: ${message}`);
        });
    }

    // Restart proxy when relevant settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            if (
                e.affectsConfiguration('antigravityCopilot.proxy') ||
                e.affectsConfiguration('antigravityCopilot.rateLimit') ||
                e.affectsConfiguration('antigravityCopilot.server.host') ||
                e.affectsConfiguration('antigravityCopilot.server.port')
            ) {
                // Only restart proxy if server is running
                const serverStatus = server?.getStatus();
                if (serverStatus?.running) {
                    void startProxyIfEnabled(output, serverStatus.config.port).catch((error: unknown) => {
                        const message = error instanceof Error ? error.message : String(error);
                        output.appendLine(`[ERROR] Failed to restart throttling proxy: ${message}`);
                    });
                }
            }
        })
    );

    // Auto-configure models is now triggered only after server start (see onDidChangeStatus)
}

async function startProxyIfEnabled(output: vscode.OutputChannel, actualUpstreamPort?: number): Promise<number | undefined> {
    if (!proxyServer) {
        return undefined;
    }

    const proxyCfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
    const serverCfg = vscode.workspace.getConfiguration('antigravityCopilot.server');

    const enabled = proxyCfg.get<boolean>('enabled', false);
    if (!enabled) {
        await proxyServer.stop();
        return undefined;
    }

    // Use actual upstream port if provided, otherwise fall back to configured port
    const upstreamPort = actualUpstreamPort ?? serverCfg.get<number>('port', 8317);

    const cfg: ThrottlingProxyConfig = {
        enabled: true,
        host: proxyCfg.get<string>('host', '127.0.0.1'),
        port: proxyCfg.get<number>('port', 8420),
        upstreamHost: serverCfg.get<string>('host', '127.0.0.1'),
        upstreamPort: upstreamPort,
    };

    const boundPort = await proxyServer.start(cfg);
    output.appendLine(`[DEBUG] Proxy enabled. Base URL: http://${cfg.host}:${boundPort}/v1 -> upstream port ${upstreamPort}`);
    return boundPort;
}

async function configureAntigravityModels(silent: boolean = false): Promise<void> {
    let baseUrlForUi: string | undefined;
    try {
        const serverConfig = vscode.workspace.getConfiguration('antigravityCopilot.server');
        const host = serverConfig.get<string>('host', '127.0.0.1');
        const port = serverConfig.get<number>('port', 8317);

        // Determine which base URL Copilot should use.
        const proxyConfig = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
        const proxyEnabledSetting = proxyConfig.get<boolean>('enabled', false);
        const proxyHost = proxyConfig.get<string>('host', '127.0.0.1');

        // Check if proxy is already running (started by server's onDidChangeStatus handler).
        // Do NOT start the proxy here - it should only start after server starts.
        let proxyReady = false;
        let actualProxyPort: number | undefined;
        let actualServerPort = port; // Default to configured port
        
        // Get actual server port and proxy status if server is running
        if (server) {
            const serverStatus = server.getStatus();
            if (serverStatus.running) {
                actualServerPort = serverStatus.config.port;
                
                // Only check proxy status if server is running
                if (proxyEnabledSetting && proxyServer) {
                    const proxyStatus = proxyServer.getStatus();
                    if (proxyStatus.running) {
                        proxyReady = true;
                        actualProxyPort = proxyStatus.port;
                    }
                }
            }
        }

        const baseUrl = proxyReady && actualProxyPort ? `http://${proxyHost}:${actualProxyPort}/v1` : `http://${host}:${actualServerPort}/v1`;
        baseUrlForUi = baseUrl;

        let models: Record<string, CopilotModelConfig>;

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

        // Prefer the new Language Models storage (Manage Models → Add Models → OpenAI Compatible).
        // This avoids writing deprecated/unregistered settings like github.copilot.chat.customOAIModels.
        const lmCfg = vscode.workspace.getConfiguration('antigravityCopilot.copilot');
        const providerGroupName = lmCfg.get<string>('providerGroupName', 'Antigravity');
        const configuredViaLm = await tryConfigureViaLanguageModels(models, { silent, providerGroupName });
        if (configuredViaLm) {
            if (!silent) {
                const selection = await vscode.window.showInformationMessage(
                    'Antigravity models configured! They should now appear under Copilot Chat → Manage Models.',
                    'Open Manage Models',
                    'Reload'
                );
                if (selection === 'Open Manage Models') {
                    void vscode.commands.executeCommand('workbench.action.chat.openLanguageModelsSettings');
                } else if (selection === 'Reload') {
                    void vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            }
            return;
        }

        // Legacy fallback: older Copilot Chat builds used settings-based configuration.
        // We keep this path for backward compatibility.
        const copilotConfig = vscode.workspace.getConfiguration('github.copilot');
        const candidateSettingKeys = ['chat.customOAIModels', 'chat.customModels'];

        let updatedKey: string | undefined;
        let lastUpdateError: unknown;

        for (const key of candidateSettingKeys) {
            const existingModels = copilotConfig.get<Record<string, unknown>>(key, {});
            const updatedModels = { ...existingModels, ...models };

            try {
                await copilotConfig.update(key, updatedModels, vscode.ConfigurationTarget.Global);
                updatedKey = key;
                break;
            } catch (updateError) {
                lastUpdateError = updateError;
                const msg = updateError instanceof Error ? updateError.message : String(updateError);
                if (/not a registered configuration/i.test(msg)) {
                    continue;
                }
                throw updateError;
            }
        }

        if (!updatedKey) {
            const raw = lastUpdateError instanceof Error ? lastUpdateError.message : String(lastUpdateError);
            outputChannel?.appendLine(
                `[WARN] Copilot BYOK configuration setting not registered. Last error: ${raw}`
            );

            const msg =
                'Unable to configure Copilot models automatically because the BYOK setting is not registered in your current VS Code/Copilot environment.\n\n' +
                'This happens when the “OpenAI Compatible” BYOK feature is not enabled/rolled out for your account, Copilot Chat is missing/disabled, or you are on a Business/Enterprise managed plan where BYOK is unavailable.\n\n' +
                'Workaround: use the UI flow: Copilot Chat → Model Picker → Manage Models → Add Models → OpenAI Compatible.';

            if (!silent) {
                const selection = await vscode.window.showErrorMessage(
                    msg,
                    'Open Docs',
                    'Open Extensions',
                    'Open Manage Models',
                    'Copy Base URL'
                );
                if (selection === 'Open Docs') {
                    void vscode.env.openExternal(
                        vscode.Uri.parse(
                            'https://code.visualstudio.com/docs/copilot/customization/language-models#_bring-your-own-language-model-key'
                        )
                    );
                } else if (selection === 'Open Extensions') {
                    void vscode.commands.executeCommand('workbench.extensions.search', 'GitHub Copilot Chat');
                } else if (selection === 'Open Manage Models') {
                    void vscode.commands.executeCommand('workbench.action.chat.openLanguageModelsSettings');
                } else if (selection === 'Copy Base URL') {
                    const url = baseUrlForUi ?? 'http://127.0.0.1:8317/v1';
                    await vscode.env.clipboard.writeText(url);
                    void vscode.window.showInformationMessage(`Copied endpoint URL: ${url}`);
                }
            }
            return;
        }

        if (!silent) {
            const selection = await vscode.window.showInformationMessage(
                'Antigravity models configured! After reload, go to Copilot Chat → Model Picker → Manage Models to enable them.',
                'Reload',
                'Open Manage Models'
            );
            if (selection === 'Reload') {
                void vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else if (selection === 'Open Manage Models') {
                void vscode.commands.executeCommand('workbench.action.chat.openLanguageModelsSettings');
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Log the raw error for debugging.
        outputChannel?.appendLine(`[ERROR] configureAntigravityModels failed: ${message}`);

        // If Copilot's BYOK setting is not registered, don't surface the raw settings error.
        if (/not a registered configuration/i.test(message) && /custom(oai)?models/i.test(message)) {
            if (!silent) {
                const url = baseUrlForUi ?? 'http://127.0.0.1:8317/v1';
                const selection = await vscode.window.showErrorMessage(
                    'Copilot BYOK settings are not available in this environment. Use the UI flow: Manage Models → Add Models → OpenAI Compatible, then paste the endpoint URL.',
                    'Open Manage Models',
                    'Copy Base URL',
                    'Open Docs'
                );
                if (selection === 'Open Manage Models') {
                    void vscode.commands.executeCommand('workbench.action.chat.openLanguageModelsSettings');
                } else if (selection === 'Copy Base URL') {
                    await vscode.env.clipboard.writeText(url);
                    void vscode.window.showInformationMessage(`Copied endpoint URL: ${url}`);
                } else if (selection === 'Open Docs') {
                    void vscode.env.openExternal(
                        vscode.Uri.parse(
                            'https://code.visualstudio.com/docs/copilot/customization/language-models#_bring-your-own-language-model-key'
                        )
                    );
                }
            }
            return;
        }

        vscode.window.showErrorMessage(`Failed to configure models: ${message}`);
    }
}

function rewriteModelUrls(models: Record<string, CopilotModelConfig>, baseUrl: string): Record<string, CopilotModelConfig> {
    const updated: Record<string, CopilotModelConfig> = {};
    for (const [key, value] of Object.entries(models)) {
        updated[key] = { ...value, url: baseUrl };
    }
    return updated;
}

/**
 * Get the path to VS Code's chatLanguageModels.json file.
 * This file stores BYOK model configurations.
 */
function getChatLanguageModelsPath(): string | undefined {
    // VS Code stores user data in different locations based on the product
    const appDataPath = process.env.APPDATA || process.env.HOME;
    if (!appDataPath) {
        return undefined;
    }

    // Detect if we're in VS Code Insiders or regular VS Code
    const isInsiders = vscode.env.appName.toLowerCase().includes('insider');
    const vscodeFolderName = isInsiders ? 'Code - Insiders' : 'Code';

    // On Windows: %APPDATA%\Code\User\chatLanguageModels.json
    // On macOS: ~/Library/Application Support/Code/User/chatLanguageModels.json
    // On Linux: ~/.config/Code/User/chatLanguageModels.json
    let userDataPath: string;
    if (process.platform === 'win32') {
        userDataPath = path.join(appDataPath, vscodeFolderName, 'User');
    } else if (process.platform === 'darwin') {
        userDataPath = path.join(appDataPath, 'Library', 'Application Support', vscodeFolderName, 'User');
    } else {
        // Linux
        const configPath = process.env.XDG_CONFIG_HOME || path.join(appDataPath, '.config');
        userDataPath = path.join(configPath, vscodeFolderName, 'User');
    }

    return path.join(userDataPath, 'chatLanguageModels.json');
}

/**
 * Update all Antigravity model endpoints in the stored chatLanguageModels.json.
 * This ensures models always point to the current proxy/server port.
 */
async function updateStoredEndpoints(newUrl: string): Promise<boolean> {
    const filePath = getChatLanguageModelsPath();
    if (!filePath) {
        outputChannel?.appendLine('[WARN] Could not determine chatLanguageModels.json path');
        return false;
    }

    try {
        if (!fs.existsSync(filePath)) {
            outputChannel?.appendLine('[DEBUG] chatLanguageModels.json does not exist yet');
            return false;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content) as {
            value?: Array<{
                name?: string;
                vendor?: string;
                models?: Array<{ url?: string; [key: string]: unknown }>;
            }>;
        };

        if (!data.value || !Array.isArray(data.value)) {
            return false;
        }

        const lmCfg = vscode.workspace.getConfiguration('antigravityCopilot.copilot');
        const providerGroupName = lmCfg.get<string>('providerGroupName', 'Antigravity');

        let updated = false;
        for (const group of data.value) {
            // Only update our Antigravity group
            if (group.name === providerGroupName && group.vendor === 'customoai' && Array.isArray(group.models)) {
                for (const model of group.models) {
                    if (model.url && model.url !== newUrl) {
                        model.url = newUrl;
                        updated = true;
                    }
                }
            }
        }

        if (updated) {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
            outputChannel?.appendLine(`[INFO] Updated ${providerGroupName} model endpoints in chatLanguageModels.json`);
        }

        return updated;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[WARN] Failed to update chatLanguageModels.json: ${msg}`);
        return false;
    }
}

/**
 * Update or create the Antigravity provider group in chatLanguageModels.json directly.
 * This bypasses the lm.migrateLanguageModelsProviderGroup command which fails on "already exists".
 */
async function updateOrCreateProviderGroup(
    models: Record<string, CopilotModelConfig>,
    providerGroupName: string
): Promise<boolean> {
    const filePath = getChatLanguageModelsPath();
    if (!filePath) {
        outputChannel?.appendLine('[WARN] Could not determine chatLanguageModels.json path');
        return false;
    }

    try {
        let data: {
            value: Array<{
                name: string;
                vendor: string;
                models: Array<{
                    id: string;
                    name: string;
                    url: string;
                    toolCalling?: boolean;
                    vision?: boolean;
                    thinking?: boolean;
                    maxInputTokens?: number;
                    maxOutputTokens?: number;
                }>;
            }>;
        };

        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            data = JSON.parse(content);
        } else {
            data = { value: [] };
        }

        if (!data.value || !Array.isArray(data.value)) {
            data.value = [];
        }

        // Convert models to the format used in chatLanguageModels.json
        const modelConfigs = Object.entries(models).map(([id, cfg]) => ({
            id,
            name: cfg.name,
            url: cfg.url,
            toolCalling: cfg.toolCalling,
            vision: cfg.vision,
            thinking: cfg.thinking,
            maxInputTokens: cfg.maxInputTokens,
            maxOutputTokens: cfg.maxOutputTokens,
        }));

        // Find existing group or create new one
        const existingGroupIndex = data.value.findIndex(
            g => g.name === providerGroupName && g.vendor === 'customoai'
        );

        if (existingGroupIndex >= 0) {
            // Update existing group
            data.value[existingGroupIndex].models = modelConfigs;
            outputChannel?.appendLine(`[INFO] Updated existing provider group '${providerGroupName}' with ${modelConfigs.length} models`);
        } else {
            // Create new group
            data.value.push({
                name: providerGroupName,
                vendor: 'customoai',
                models: modelConfigs,
            });
            outputChannel?.appendLine(`[INFO] Created new provider group '${providerGroupName}' with ${modelConfigs.length} models`);
        }

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
        return true;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[ERROR] Failed to update chatLanguageModels.json: ${msg}`);
        return false;
    }
}

async function tryConfigureViaLanguageModels(
    models: Record<string, CopilotModelConfig>,
    options: { silent: boolean; providerGroupName: string }
): Promise<boolean> {
    // This command is provided by VS Code’s Language Models infrastructure.
    // It is used by Copilot Chat’s BYOK providers to configure provider groups.
    const commandId = 'lm.migrateLanguageModelsProviderGroup';
    const providerVendor = 'customoai'; // "OpenAI Compatible" provider in Copilot Chat
    // Provider group name is user-visible and can be anything.
    // We default to 'Antigravity' to avoid overwriting other groups.
    const groupName = options.providerGroupName?.trim() || 'Antigravity';

    const modelConfigs = Object.entries(models).map(([id, cfg]) => ({
        id,
        name: cfg.name,
        url: cfg.url,
        toolCalling: cfg.toolCalling,
        vision: cfg.vision,
        thinking: cfg.thinking,
        maxInputTokens: cfg.maxInputTokens,
        maxOutputTokens: cfg.maxOutputTokens,
    }));

    try {
        await vscode.commands.executeCommand(commandId, {
            vendor: providerVendor,
            name: groupName,
            models: modelConfigs,
            // No apiKey required for local OpenAI-compatible endpoints (Copilot Chat accepts empty).
        });
        outputChannel?.appendLine(`[INFO] Configured models via Language Models provider group '${groupName}' (vendor: ${providerVendor}).`);
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel?.appendLine(`[WARN] Failed to configure via '${commandId}': ${msg}`);

        // If the command is missing, feature isn't enabled, or group already exists, try direct file update
        if (/command .* not found|unknown command|not a registered command|already exists|not registered|vendor.*not.*registered/i.test(msg)) {
            outputChannel?.appendLine('[INFO] API not available or group exists, trying direct file update...');
            return await updateOrCreateProviderGroup(models, groupName);
        }

        // In some environments BYOK is disabled; try direct update
        if (/byok|bring your own|not available|not enabled|forbidden|unauthorized/i.test(msg)) {
            outputChannel?.appendLine('[INFO] BYOK not available via API, trying direct file update...');
            return await updateOrCreateProviderGroup(models, groupName);
        }

        // Other errors - still try direct update as fallback
        outputChannel?.appendLine('[INFO] Falling back to direct file update...');
        return await updateOrCreateProviderGroup(models, groupName);
    }
}

export function deactivate() {
    // Cleanup handled by subscriptions
}
