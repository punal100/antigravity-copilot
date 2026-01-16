import * as vscode from 'vscode';

/**
 * Semaphore-based concurrency limiter with queue.
 * Ensures at most `maxConcurrency` tasks run at once; excess requests are queued.
 * 
 * For thinking models, use a low concurrency (1-2) to avoid overwhelming the server.
 * For standard models, higher concurrency (3-5) is typically safe.
 */
export class ConcurrencyQueue {
    private running = 0;
    private queue: Array<{ resolve: () => void; priority: number }> = [];
    private _totalQueued = 0;
    private _totalProcessed = 0;

    /**
     * @param maxConcurrency Maximum concurrent tasks (default: 2)
     * @param name Optional name for logging
     */
    constructor(
        private maxConcurrency: number = 2,
        private readonly name: string = 'default'
    ) {}

    /**
     * Get current queue statistics
     */
    public getStats(): ConcurrencyQueueStats {
        return {
            name: this.name,
            running: this.running,
            queued: this.queue.length,
            maxConcurrency: this.maxConcurrency,
            totalQueued: this._totalQueued,
            totalProcessed: this._totalProcessed,
        };
    }

    /**
     * Update the max concurrency limit
     */
    public setMaxConcurrency(max: number): void {
        this.maxConcurrency = Math.max(1, max);
        // Release any queued tasks that can now run
        this.releaseNext();
    }

    /**
     * Run a task through the queue.
     * If at capacity, waits until a slot is available.
     * 
     * @param fn The async function to execute
     * @param priority Higher priority tasks run first (default: 0)
     */
    public async run<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
        this._totalQueued++;

        if (this.running >= this.maxConcurrency) {
            await new Promise<void>((resolve) => {
                // Insert in priority order (higher priority first)
                const item = { resolve, priority };
                let inserted = false;
                for (let i = 0; i < this.queue.length; i++) {
                    if (priority > this.queue[i].priority) {
                        this.queue.splice(i, 0, item);
                        inserted = true;
                        break;
                    }
                }
                if (!inserted) {
                    this.queue.push(item);
                }
            });
        }

        this.running++;
        try {
            return await fn();
        } finally {
            this.running--;
            this._totalProcessed++;
            this.releaseNext();
        }
    }

    /**
     * Release the next queued task if capacity allows
     */
    private releaseNext(): void {
        while (this.running < this.maxConcurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) {
                next.resolve();
            }
        }
    }

    /**
     * Clear all queued tasks (does not affect running tasks)
     */
    public clearQueue(): void {
        // Resolve all waiting promises so they can be rejected/cancelled by caller
        for (const item of this.queue) {
            item.resolve();
        }
        this.queue = [];
    }
}

export interface ConcurrencyQueueStats {
    name: string;
    running: number;
    queued: number;
    maxConcurrency: number;
    totalQueued: number;
    totalProcessed: number;
}

/**
 * Retry a function with exponential backoff and jitter for 429 errors.
 * 
 * @param fn The async function to retry
 * @param options Retry options
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxRetries = 5,
        baseDelayMs = 500,
        maxDelayMs = 60000,
        jitterFactor = 0.5,
        shouldRetry = defaultShouldRetry,
        onRetry,
    } = options;

    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            if (!shouldRetry(err) || attempt >= maxRetries) {
                throw err;
            }

            attempt++;

            // Exponential backoff: base * 2^attempt
            const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
            
            // Add jitter: delay * (1 - jitter/2 + random * jitter)
            const jitter = (0.5 + Math.random() * jitterFactor);
            const delay = Math.min(Math.floor(exponentialDelay * jitter), maxDelayMs);

            if (onRetry) {
                onRetry(attempt, delay, err);
            }

            await sleep(delay);
        }
    }
}

/**
 * Default retry condition: retry on 429 or RESOURCE_EXHAUSTED errors
 */
function defaultShouldRetry(err: any): boolean {
    // Check HTTP status
    const status = err?.response?.status ?? err?.status ?? err?.statusCode;
    if (status === 429) {
        return true;
    }

    // Check error message for common quota/rate limit patterns
    if (err instanceof Error) {
        const message = err.message.toLowerCase();
        return (
            message.includes('429') ||
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('quota exceeded') ||
            message.includes('resource_exhausted') ||
            message.includes('resourceexhausted')
        );
    }

    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RetryOptions {
    /** Maximum number of retry attempts (default: 5) */
    maxRetries?: number;
    /** Base delay in milliseconds before first retry (default: 500) */
    baseDelayMs?: number;
    /** Maximum delay cap in milliseconds (default: 60000) */
    maxDelayMs?: number;
    /** Jitter factor 0-1 (default: 0.5) */
    jitterFactor?: number;
    /** Custom function to determine if error is retryable */
    shouldRetry?: (err: any) => boolean;
    /** Callback invoked before each retry */
    onRetry?: (attempt: number, delayMs: number, err: any) => void;
}

/**
 * Manages separate queues for thinking vs standard model requests.
 * Thinking models get lower concurrency to avoid overwhelming upstream servers.
 */
export class ModelConcurrencyManager implements vscode.Disposable {
    private thinkingQueue: ConcurrencyQueue;
    private standardQueue: ConcurrencyQueue;
    private readonly output: vscode.OutputChannel;

    constructor(output: vscode.OutputChannel) {
        this.output = output;
        
        // Load initial config
        const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
        const thinkingConcurrency = cfg.get<number>('thinkingConcurrency', 1);
        const standardConcurrency = cfg.get<number>('standardConcurrency', 3);
        
        this.thinkingQueue = new ConcurrencyQueue(thinkingConcurrency, 'thinking');
        this.standardQueue = new ConcurrencyQueue(standardConcurrency, 'standard');
    }

    /**
     * Run a request through the appropriate queue based on model type
     */
    public async runRequest<T>(
        modelName: string | undefined,
        fn: () => Promise<T>,
        enableRetry: boolean = true
    ): Promise<T> {
        const isThinking = this.isThinkingModel(modelName);
        const queue = isThinking ? this.thinkingQueue : this.standardQueue;
        
        const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
        const maxRetries = cfg.get<number>('maxRetries', 3);
        const retryBaseDelayMs = cfg.get<number>('retryBaseDelayMs', 1000);

        const executeWithRetry = async (): Promise<T> => {
            if (!enableRetry || maxRetries <= 0) {
                return fn();
            }

            return retryWithBackoff(fn, {
                maxRetries,
                baseDelayMs: retryBaseDelayMs,
                onRetry: (attempt, delayMs, err) => {
                    this.log(`Retry ${attempt}/${maxRetries} for ${modelName ?? 'unknown'} after ${delayMs}ms (${err?.message ?? 'unknown error'})`);
                },
            });
        };

        // Higher priority for standard requests (they're usually faster)
        const priority = isThinking ? 0 : 1;
        
        return queue.run(executeWithRetry, priority);
    }

    /**
     * Check if a model is a thinking model
     */
    private isThinkingModel(modelName?: string): boolean {
        if (!modelName) return false;
        return modelName.toLowerCase().includes('thinking');
    }

    /**
     * Get combined stats from both queues
     */
    public getStats(): { thinking: ConcurrencyQueueStats; standard: ConcurrencyQueueStats } {
        return {
            thinking: this.thinkingQueue.getStats(),
            standard: this.standardQueue.getStats(),
        };
    }

    /**
     * Update concurrency limits from configuration
     */
    public updateFromConfig(): void {
        const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
        const thinkingConcurrency = cfg.get<number>('thinkingConcurrency', 1);
        const standardConcurrency = cfg.get<number>('standardConcurrency', 3);
        
        this.thinkingQueue.setMaxConcurrency(thinkingConcurrency);
        this.standardQueue.setMaxConcurrency(standardConcurrency);
        
        this.log(`Updated concurrency: thinking=${thinkingConcurrency}, standard=${standardConcurrency}`);
    }

    private log(message: string): void {
        this.output.appendLine(`[${new Date().toISOString()}] QUEUE ${message}`);
    }

    public dispose(): void {
        this.thinkingQueue.clearQueue();
        this.standardQueue.clearQueue();
    }
}
