import * as vscode from 'vscode';
import { AntigravityServer } from './AntigravityServer';
import { SidebarProvider } from './SidebarProvider';
import { ANTIGRAVITY_MODELS, fetchModelsFromServer } from './models';

let server: AntigravityServer | undefined;

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Antigravity');
    context.subscriptions.push(output);

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

    // Register Sidebar Provider
    const sidebarProvider = new SidebarProvider(context.extensionUri, getServer);
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
        }
    });

    context.subscriptions.push(
        startServerCommand,
        stopServerCommand,
        restartServerCommand,
        loginCommand,
        configureModelsCommand,
        showServerControlsCommand
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

    // Auto-configure models if enabled
    const autoConfigureCopilot = vscode.workspace.getConfiguration('antigravityCopilot').get<boolean>('autoConfigureCopilot', true);
    if (autoConfigureCopilot) {
        void configureAntigravityModels(true);
    }
}

async function configureAntigravityModels(silent: boolean = false): Promise<void> {
    try {
        const serverConfig = vscode.workspace.getConfiguration('antigravityCopilot.server');
        const host = serverConfig.get<string>('host', '127.0.0.1');
        const port = serverConfig.get<number>('port', 8317);

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

export function deactivate() {
    // Cleanup handled by subscriptions
}
