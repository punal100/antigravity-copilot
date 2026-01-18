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
    /** Track the last model used to apply model-specific cooldowns */
    private _lastModelWasThinking = false;
    /** Abort controller to cancel pending waitUntilCanProceed calls */
    private _abortController: AbortController | undefined;

    private readonly _onDidChangeStatus = new vscode.EventEmitter<RateLimiterStatus>();
    public readonly onDidChangeStatus = this._onDidChangeStatus.event;

    private constructor(private readonly output: vscode.OutputChannel) { }

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
        // Create abort controller if not exists
        if (!this._abortController) {
            this._abortController = new AbortController();
        }
        const signal = this._abortController.signal;

        const start = Date.now();
        while (!this.canProceed(modelName, false)) {
            // Check if aborted
            if (signal.aborted) {
                throw new Error('Request cancelled: rate limiter aborted');
            }

            const status = this.getStatus();
            const remaining = Math.max(0, timeoutMs - (Date.now() - start));
            if (remaining <= 0) {
                throw new Error('Timed out waiting for rate limiter');
            }

            // Sleep for either the remaining cooldown, or a short polling interval.
            const sleepMs = status.isInCooldown
                ? Math.min(status.remainingCooldownMs, 1000)
                : 250;
            
            // Use AbortSignal-aware sleep
            await this.abortableSleep(Math.min(sleepMs, remaining), signal);
        }
    }

    /**
     * Sleep that can be interrupted by an AbortSignal
     */
    private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('Request cancelled: rate limiter aborted'));
                return;
            }

            const timeoutId = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);

            const onAbort = () => {
                clearTimeout(timeoutId);
                reject(new Error('Request cancelled: rate limiter aborted'));
            };

            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Mark that a request is starting
     */
    public startRequest(modelName?: string): void {
        const isThinkingModel = modelName?.toLowerCase().includes('thinking') ?? false;

        this._isBusy = true;
        this._pendingRequests++;
        this._lastRequestTime = Date.now();
        this._lastModelWasThinking = isThinkingModel;

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

        // Only apply cooldown after 429 errors, not after successful requests.
        // This allows Copilot to send follow-up requests (tool calls, streaming) without delay.
        // The ConcurrencyQueue handles burst protection via semaphore limits.
        if (was429) {
            // Exponential backoff when rate limited
            const backoffMultiplier = Math.pow(2, Math.min(this._consecutive429Count, 5));
            const cooldown = Math.min(config.cooldownMs * backoffMultiplier, 300000);
            this._effectiveCooldownMs = cooldown;
            this._lastRequestTime = Date.now();

            // Set up cooldown
            this._cooldownTimeoutId = setTimeout(() => {
                this._effectiveCooldownMs = 0;
                this.logInfo('Cooldown period ended');
                this._onDidChangeStatus.fire(this.getStatus());
            }, cooldown);

            this.logInfo(`Request ended with 429. Cooldown: ${cooldown}ms (backoff x${backoffMultiplier})`);
        } else {
            // Successful request - no cooldown, just update timestamp
            this._effectiveCooldownMs = 0;
            this._lastRequestTime = Date.now();
            this.logInfo('Request ended successfully');
        }

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
        this._lastModelWasThinking = false;

        if (this._cooldownTimeoutId) {
            clearTimeout(this._cooldownTimeoutId);
            this._cooldownTimeoutId = undefined;
        }

        this.logInfo('Rate limiter reset');
        this._onDidChangeStatus.fire(this.getStatus());
    }

    /**
     * Abort all pending waitUntilCanProceed calls.
     * This should be called when the server is stopped to cancel waiting requests.
     */
    public abortPendingRequests(): void {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = undefined;
            this.logInfo('Aborted all pending rate-limited requests');
        }
    }

    private logInfo(message: string): void {
        this.output.appendLine(`[${new Date().toISOString()}] RATE-LIMIT ${message}`);
    }

    public dispose(): void {
        // Abort any pending requests
        this.abortPendingRequests();
        
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
