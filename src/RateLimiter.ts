import * as vscode from 'vscode';

/**
 * RateLimiter for Antigravity models
 * Implements a session mutex + cooldown mechanism to prevent rate-limit (429) errors
 * from the provider when using thinking models.
 */
export class RateLimiter implements vscode.Disposable {
    private static instance: RateLimiter | undefined;
    
    private _isBusy = false;
    private _lastRequestTime = 0;
    private _cooldownTimeoutId: NodeJS.Timeout | undefined;
    private _pendingRequests = 0;
    /** Tracks consecutive 429 errors for exponential backoff */
    private _consecutive429Count = 0;
    /** The actual cooldown being enforced (may be extended after 429s) */
    private _effectiveCooldownMs = 0;
    
    private readonly _onDidChangeStatus = new vscode.EventEmitter<RateLimiterStatus>();
    public readonly onDidChangeStatus = this._onDidChangeStatus.event;

    private constructor(private readonly output: vscode.OutputChannel) {}

    /**
     * Get or create the singleton instance
     */
    public static getInstance(output?: vscode.OutputChannel): RateLimiter {
        if (!RateLimiter.instance) {
            if (!output) {
                throw new Error('RateLimiter requires an output channel on first initialization');
            }
            RateLimiter.instance = new RateLimiter(output);
        }
        return RateLimiter.instance;
    }

    /**
     * Get the current rate limiter status
     */
    public getStatus(): RateLimiterStatus {
        const config = this.getConfig();
        const now = Date.now();
        const timeSinceLastRequest = now - this._lastRequestTime;
        // Use effective cooldown (which may be extended after 429s)
        const activeCooldown = this._effectiveCooldownMs || config.cooldownMs;
        const remainingCooldown = Math.max(0, activeCooldown - timeSinceLastRequest);
        
        return {
            isBusy: this._isBusy,
            isInCooldown: remainingCooldown > 0,
            remainingCooldownMs: remainingCooldown,
            pendingRequests: this._pendingRequests,
            lastRequestTime: this._lastRequestTime,
            cooldownMs: activeCooldown,
            consecutive429Count: this._consecutive429Count
        };
    }

    /**
     * Get the current configuration
     */
    private getConfig(): RateLimiterConfig {
        const config = vscode.workspace.getConfiguration('antigravityCopilot.rateLimit');
        const cooldownMs = config.get<number>('cooldownMs', 15000);
        
        return {
            enabled: config.get<boolean>('enabled', true),
            cooldownMs,
            showNotifications: config.get<boolean>('showNotifications', true)
        };
    }

    /**
     * Check if a request can proceed. Returns true if allowed, false if blocked.
     * Shows a notification to the user if blocked.
     */
    public canProceed(modelName?: string, notify: boolean = true): boolean {
        const config = this.getConfig();
        
        if (!config.enabled) {
            return true;
        }

        const status = this.getStatus();
        const isThinkingModel = modelName?.toLowerCase().includes('thinking') ?? false;

        // Check if busy with another request
        if (status.isBusy) {
            this.logInfo(`Request blocked: Antigravity is busy with another request`);
            if (notify && config.showNotifications) {
                this.showBusyNotification();
            }
            return false;
        }

        // Check cooldown (more strict for thinking models)
        if (status.isInCooldown) {
            const secondsRemaining = Math.ceil(status.remainingCooldownMs / 1000);
            this.logInfo(`Request blocked: Cooldown active (${secondsRemaining}s remaining)`);
            if (notify && config.showNotifications) {
                this.showCooldownNotification(secondsRemaining, isThinkingModel);
            }
            return false;
        }

        return true;
    }

    /**
     * Wait until a request can proceed, honoring busy + cooldown.
     * This is intended for internal automation (e.g. a local throttling proxy),
     * so it does not spam UI notifications.
     */
    public async waitUntilCanProceed(modelName?: string, timeoutMs: number = 120000): Promise<void> {
        const start = Date.now();
        while (!this.canProceed(modelName, false)) {
            const status = this.getStatus();
            const remaining = Math.max(0, timeoutMs - (Date.now() - start));
            if (remaining <= 0) {
                throw new Error('Timed out waiting for rate limiter');
            }

            // Sleep for either the remaining cooldown, or a short polling interval.
            const sleepMs = status.isInCooldown
                ? Math.min(status.remainingCooldownMs, 1000)
                : 250;
            await new Promise(resolve => setTimeout(resolve, Math.min(sleepMs, remaining)));
        }
    }

    /**
     * Mark that a request is starting
     */
    public startRequest(modelName?: string): void {
        const isThinkingModel = modelName?.toLowerCase().includes('thinking') ?? false;
        
        this._isBusy = true;
        this._pendingRequests++;
        this._lastRequestTime = Date.now();
        
        this.logInfo(`Request started${isThinkingModel ? ' (thinking model)' : ''}`);
        this._onDidChangeStatus.fire(this.getStatus());
    }

    /**
     * Mark that a request has completed (success or failure)
     */
    public endRequest(error?: Error | { status?: number }): void {
        this._isBusy = false;
        this._pendingRequests = Math.max(0, this._pendingRequests - 1);
        
        const config = this.getConfig();
        const was429 = error && this.isRateLimitError(error);
        
        // Handle rate limit errors with exponential backoff
        if (was429) {
            this._consecutive429Count++;
            this.handleRateLimitError();
        } else {
            // Successful request resets the 429 counter
            this._consecutive429Count = 0;
        }

        // Clear any existing cooldown timeout
        if (this._cooldownTimeoutId) {
            clearTimeout(this._cooldownTimeoutId);
        }

        // Calculate effective cooldown:
        // - Base cooldown from config
        // - After 429: double the cooldown for each consecutive 429 (capped at 5 minutes)
        let cooldown = config.cooldownMs;
        if (was429) {
            // Exponential backoff: base * 2^(consecutive-1), capped at 300s
            const backoffMultiplier = Math.pow(2, Math.min(this._consecutive429Count, 5));
            cooldown = Math.min(cooldown * backoffMultiplier, 300000);
        }
        this._effectiveCooldownMs = cooldown;
        this._lastRequestTime = Date.now();

        // Set up cooldown
        this._cooldownTimeoutId = setTimeout(() => {
            this._effectiveCooldownMs = 0; // Reset to base cooldown
            this.logInfo('Cooldown period ended');
            this._onDidChangeStatus.fire(this.getStatus());
        }, cooldown);

        this.logInfo(`Request ended. Cooldown: ${cooldown}ms${was429 ? ` (backoff x${Math.pow(2, Math.min(this._consecutive429Count, 5))})` : ''}`);
        this._onDidChangeStatus.fire(this.getStatus());
    }

    /**
     * Check if an error is a rate limit error (HTTP 429)
     */
    private isRateLimitError(error: Error | { status?: number }): boolean {
        if ('status' in error && error.status === 429) {
            return true;
        }
        if (error instanceof Error) {
            const message = error.message.toLowerCase();
            return message.includes('429') || 
                   message.includes('rate limit') || 
                   message.includes('too many requests') ||
                   message.includes('quota exceeded');
        }
        return false;
    }

    /**
     * Handle rate limit error - show clear notification to user
     */
    private handleRateLimitError(): void {
        const config = this.getConfig();
        const backoffMultiplier = Math.pow(2, Math.min(this._consecutive429Count, 5));
        const extendedCooldown = Math.min(config.cooldownMs * backoffMultiplier, 300000);
        
        this.logInfo(`Rate limit error detected (429). Consecutive: ${this._consecutive429Count}. Next cooldown: ${extendedCooldown}ms`);
        
        if (config.showNotifications) {
            const waitSeconds = Math.ceil(extendedCooldown / 1000);
            void vscode.window.showWarningMessage(
                `Antigravity rate limit reached (429). Waiting ${waitSeconds}s before next request.`,
                'Open Settings'
            ).then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityCopilot.rateLimit');
                }
            });
        }
    }

    /**
     * Show notification when busy
     */
    private showBusyNotification(): void {
        void vscode.window.showWarningMessage(
            'Antigravity model is busy — please wait before sending another request.',
            'View Status'
        ).then(selection => {
            if (selection === 'View Status') {
                vscode.commands.executeCommand('antigravity-copilot.sidebarView.focus');
            }
        });
    }

    /**
     * Show notification when in cooldown
     */
    private showCooldownNotification(secondsRemaining: number, isThinkingModel: boolean): void {
        const modelType = isThinkingModel ? 'Thinking models require' : 'Rate limiting active:';
        void vscode.window.showWarningMessage(
            `${modelType} a cooldown period. Please wait ${secondsRemaining} seconds.`,
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityCopilot.rateLimit');
            }
        });
    }

    /**
     * Reset the rate limiter state
     */
    public reset(): void {
        this._isBusy = false;
        this._lastRequestTime = 0;
        this._pendingRequests = 0;
        this._consecutive429Count = 0;
        this._effectiveCooldownMs = 0;
        
        if (this._cooldownTimeoutId) {
            clearTimeout(this._cooldownTimeoutId);
            this._cooldownTimeoutId = undefined;
        }
        
        this.logInfo('Rate limiter reset');
        this._onDidChangeStatus.fire(this.getStatus());
    }

    private logInfo(message: string): void {
        this.output.appendLine(`[${new Date().toISOString()}] RATE-LIMIT ${message}`);
    }

    public dispose(): void {
        if (this._cooldownTimeoutId) {
            clearTimeout(this._cooldownTimeoutId);
        }
        this._onDidChangeStatus.dispose();
        RateLimiter.instance = undefined;
    }
}

export interface RateLimiterStatus {
    /** Whether a request is currently in progress */
    isBusy: boolean;
    /** Whether we're in a cooldown period */
    isInCooldown: boolean;
    /** Milliseconds remaining in cooldown */
    remainingCooldownMs: number;
    /** Number of pending requests */
    pendingRequests: number;
    /** Timestamp of last request */
    lastRequestTime: number;
    /** Current cooldown duration in ms (may be extended after 429s) */
    cooldownMs: number;
    /** Number of consecutive 429 errors (for exponential backoff) */
    consecutive429Count: number;
}

export interface RateLimiterConfig {
    /** Whether rate limiting is enabled */
    enabled: boolean;
    /** Cooldown period in milliseconds */
    cooldownMs: number;
    /** Whether to show notifications */
    showNotifications: boolean;
}
