import * as http from 'http';
import * as vscode from 'vscode';
import { PassThrough, Transform, TransformCallback } from 'stream';
import { RateLimiter } from './RateLimiter';
import { ModelConcurrencyManager } from './ConcurrencyQueue';
import { ThinkingStreamTransformer, OpenAIToClaudeStreamTransformer, ReasoningAnnotatorTransformer } from './ThinkingStreamTransformer';

/**
 * Custom error for rate limit (429) responses.
 * Thrown by proxy when upstream returns 429, enabling retry logic.
 */
class RateLimitError extends Error {
    public readonly status: number;
    public readonly body: string;

    constructor(message: string, status: number, body: string) {
        super(message);
        this.name = 'RateLimitError';
        this.status = status;
        this.body = body;
    }
}

export interface ThrottlingProxyConfig {
    enabled: boolean;
    host: string;
    port: number;
    upstreamHost: string;
    upstreamPort: number;
}

export class ThrottlingProxyServer implements vscode.Disposable {
    private server: http.Server | undefined;
    private currentConfig: ThrottlingProxyConfig | undefined;
    private concurrencyManager: ModelConcurrencyManager;
    private configChangeListener: vscode.Disposable | undefined;

    constructor(
        private readonly output: vscode.OutputChannel,
        private readonly rateLimiter: RateLimiter
    ) {
        this.concurrencyManager = new ModelConcurrencyManager(output);

        // Listen for config changes to update concurrency limits
        this.configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravityCopilot.proxy')) {
                this.concurrencyManager.updateFromConfig();
            }
        });
    }

    public getStatus(): { running: boolean; port?: number; host?: string; queueStats?: { thinking: import('./ConcurrencyQueue').ConcurrencyQueueStats; standard: import('./ConcurrencyQueue').ConcurrencyQueueStats } } {
        const address = this.server?.address();
        if (!address || typeof address === 'string') {
            return { running: !!this.server };
        }
        return {
            running: !!this.server,
            port: address.port,
            host: address.address,
            queueStats: this.concurrencyManager.getStats()
        };
    }

    public async start(config: ThrottlingProxyConfig): Promise<number> {
        if (!config.enabled) {
            return config.port;
        }

        if (this.server) {
            if (this.currentConfig && isSameConfig(this.currentConfig, config)) {
                return this.currentConfig.port;
            }
            await this.stop();
        }

        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res, config);
        });

        // Try the configured port first, then increment up to 10 times if in use
        const maxAttempts = 10;
        let lastError: Error | undefined;
        let boundPort = config.port;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const tryPort = config.port + attempt;
            try {
                await new Promise<void>((resolve, reject) => {
                    const onError = (err: NodeJS.ErrnoException) => {
                        this.server!.off('error', onError);
                        reject(err);
                    };
                    this.server!.once('error', onError);
                    this.server!.listen(tryPort, config.host, () => {
                        this.server!.off('error', onError);
                        resolve();
                    });
                });
                boundPort = tryPort;
                if (attempt > 0) {
                    this.logInfo(`Port ${config.port} was in use, bound to port ${boundPort} instead`);
                }
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                const isAddrInUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
                if (!isAddrInUse || attempt === maxAttempts - 1) {
                    throw lastError;
                }
                // Close and recreate server for next attempt
                try {
                    this.server.close();
                } catch {
                    // ignore
                }
                this.server = http.createServer((req, res) => {
                    void this.handleRequest(req, res, { ...config, port: tryPort + 1 });
                });
            }
        }

        this.currentConfig = { ...config, port: boundPort };

        const status = this.getStatus();
        this.logInfo(`Throttling proxy started on http://${status.host}:${status.port} -> http://${config.upstreamHost}:${config.upstreamPort}`);

        return boundPort;
    }

    public async stop(): Promise<void> {
        if (!this.server) {
            return;
        }
        const srv = this.server;
        this.server = undefined;
        this.currentConfig = undefined;
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        this.logInfo('Throttling proxy stopped');
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, config: ThrottlingProxyConfig): Promise<void> {
        try {
            if (!req.url) {
                res.statusCode = 400;
                res.end('Bad Request');
                return;
            }

            // Buffer request body (Copilot payloads are typically small JSON).
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks);

            // Guardrail against extremely large prompts (can happen with huge tool output like git diff).
            // We optionally truncate tool output (below), but still enforce an absolute maximum to avoid
            // memory issues and accidental runaway requests.
            const proxyCfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
            const maxRequestBodyBytes = proxyCfg.get<number>('maxRequestBodyBytes', 10 * 1024 * 1024);
            if (Number.isFinite(maxRequestBodyBytes) && maxRequestBodyBytes > 0 && body.length > maxRequestBodyBytes) {
                res.statusCode = 413;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({
                    error: {
                        message: 'Request too large',
                        details: `Request body (${body.length} bytes) exceeds proxy limit (${maxRequestBodyBytes} bytes). Consider reducing tool output/context or enabling tool output truncation.`,
                    },
                }));
                return;
            }

            const urlPath = req.url ?? '';
            const isChatCompletionEndpoint = urlPath.startsWith('/v1/chat/completions') ||
                urlPath.startsWith('/v1/completions') ||
                urlPath.startsWith('/v1/responses');

            const modelName = this.tryExtractModelName(req, body);
            const isStreaming = this.isStreamingRequest(body);
            const isThinkingModel = (modelName ?? '').toLowerCase().includes('thinking');

            // Optionally (1) truncate huge tool output in prompt history and (2) clamp output token requests
            // to reduce long generations that frequently trigger upstream rate limits mid-stream.
            const rewriteResult = this.tryRewritePayload(req, body, modelName);

            const startedAt = Date.now();

            // Only apply rate limiting and concurrency queue to chat completion endpoints.
            // Other endpoints (GET /v1/models, health checks, etc.) pass through directly.
            let forwardResult: { statusCode: number; errorSnippet?: string };

            if (isChatCompletionEndpoint) {
                // Use concurrency queue with retry for the forward request.
                // The queue ensures thinking models have limited concurrency (default: 1)
                // and retries with exponential backoff + jitter on 429 errors.
                forwardResult = await this.concurrencyManager.runRequest(
                    modelName,
                    async () => {
                        // Serialize + cooldown using the rate limiter.
                        await this.rateLimiter.waitUntilCanProceed(modelName);
                        this.rateLimiter.startRequest(modelName);

                        try {
                            const result = await this.forward(req, res, rewriteResult.body, config, {
                                modelName,
                                isStreaming,
                                isThinkingModel,
                            });

                            this.rateLimiter.endRequest({ status: result.statusCode });
                            return result;
                        } catch (err) {
                            this.rateLimiter.endRequest(err instanceof Error ? err : new Error(String(err)));
                            throw err;
                        }
                    },
                    true // enableRetry
                );
            } else {
                // Non-chat endpoints: forward directly without rate limiting
                forwardResult = await this.forward(req, res, rewriteResult.body, config, {
                    modelName,
                    isStreaming,
                    isThinkingModel,
                });
            }

            this.logRequestMeta({
                method: req.method ?? 'GET',
                path: urlPath,
                model: modelName,
                statusCode: forwardResult.statusCode,
                durationMs: Date.now() - startedAt,
                tokenRewrite: rewriteResult.meta,
                toolTruncation: rewriteResult.toolTruncation,
                upstreamErrorSnippet: forwardResult.errorSnippet,
            });
        } catch (error) {
            // Ensure limiter is not left in busy state.
            try {
                this.rateLimiter.endRequest(error instanceof Error ? error : new Error(String(error)));
            } catch {
                // ignore
            }

            const message = error instanceof Error ? error.message : String(error);
            this.logInfo(`Proxy request failed: ${message}`);

            if (!res.headersSent) {
                // Special handling for rate limit errors (after all retries exhausted)
                // Return 503 Service Unavailable with a friendly message instead of 429
                // This prevents Copilot from showing the raw rate limit error
                if (error instanceof RateLimitError) {
                    res.statusCode = 503;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({
                        error: {
                            message: 'Model temporarily unavailable',
                            details: 'The upstream model quota is exhausted. Please wait a moment and try again. The rate limiter will automatically back off.',
                            code: 'SERVICE_UNAVAILABLE',
                            retryable: true,
                        },
                    }));
                } else {
                    res.statusCode = 502;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: { message: 'Upstream request failed', details: message } }));
                }
            } else {
                // Headers already sent, just end the response
                res.end();
            }
        }
    }

    private tryExtractModelName(req: http.IncomingMessage, body: Buffer): string | undefined {
        try {
            const url = req.url ?? '';
            if (!url.startsWith('/v1/chat/completions') && !url.startsWith('/v1/responses')) {
                return undefined;
            }
            if (!body || body.length === 0) {
                return undefined;
            }
            const text = body.toString('utf8');
            const json = JSON.parse(text) as { model?: string };
            return typeof json.model === 'string' ? json.model : undefined;
        } catch {
            return undefined;
        }
    }

    private isStreamingRequest(body: Buffer): boolean {
        try {
            if (!body || body.length === 0) {
                return false;
            }
            const text = body.toString('utf8');
            const json = JSON.parse(text) as { stream?: boolean };
            return json.stream === true;
        } catch {
            return false;
        }
    }

    private tryRewriteTokenLimits(
        req: http.IncomingMessage,
        body: Buffer,
        modelName?: string
    ): { body: Buffer; meta?: TokenRewriteMeta } {
        // Kept for compatibility in case external code references it.
        // New logic lives in tryRewritePayload().
        return this.tryRewritePayload(req, body, modelName);
    }

    private tryRewritePayload(
        req: http.IncomingMessage,
        body: Buffer,
        modelName?: string
    ): { body: Buffer; meta?: TokenRewriteMeta; toolTruncation?: ToolTruncationMeta } {
        try {
            const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');

            const url = req.url ?? '';
            if (!url.startsWith('/v1/chat/completions') && !url.startsWith('/v1/responses')) {
                return { body };
            }
            if (!body || body.length === 0) {
                return { body };
            }

            const payload: any = JSON.parse(body.toString('utf8'));

            // 1) Tool output truncation (reduces prompt size without impacting user instructions much)
            const truncateTools = cfg.get<boolean>('truncateToolOutput', true);
            let toolTruncation: ToolTruncationMeta | undefined;
            if (truncateTools) {
                const maxChars = cfg.get<number>('maxToolOutputChars', 12000);
                const headChars = cfg.get<number>('toolOutputHeadChars', 6000);
                const tailChars = cfg.get<number>('toolOutputTailChars', 2000);
                toolTruncation = truncateToolMessagesInPayload(payload, {
                    maxChars,
                    headChars,
                    tailChars,
                });
            }

            // 2) Token limit clamping
            const rewriteMaxTokens = cfg.get<boolean>('rewriteMaxTokens', true);
            let meta: TokenRewriteMeta | undefined;
            if (rewriteMaxTokens) {
                const isThinking = (modelName ?? '').toLowerCase().includes('thinking');
                const cap = isThinking
                    ? cfg.get<number>('maxTokensThinking', 2048)
                    : cfg.get<number>('maxTokensStandard', 4096);
                if (Number.isFinite(cap) && cap > 0) {
                    meta = {
                        enabled: true,
                        cap,
                        isThinking,
                    };

                    // OpenAI-compatible endpoints typically use `max_tokens`.
                    if (typeof payload.max_tokens === 'number') {
                        meta.originalMaxTokens = payload.max_tokens;
                        payload.max_tokens = Math.min(payload.max_tokens, cap);
                        meta.finalMaxTokens = payload.max_tokens;
                    }
                    // Some APIs use `max_output_tokens`.
                    if (typeof payload.max_output_tokens === 'number') {
                        meta.originalMaxOutputTokens = payload.max_output_tokens;
                        payload.max_output_tokens = Math.min(payload.max_output_tokens, cap);
                        meta.finalMaxOutputTokens = payload.max_output_tokens;
                    }
                    // Some use `max_completion_tokens`.
                    if (typeof payload.max_completion_tokens === 'number') {
                        meta.originalMaxCompletionTokens = payload.max_completion_tokens;
                        payload.max_completion_tokens = Math.min(payload.max_completion_tokens, cap);
                        meta.finalMaxCompletionTokens = payload.max_completion_tokens;
                    }
                }
            }

            // Only return truncation meta if any truncation occurred.
            if (toolTruncation && toolTruncation.truncatedMessages === 0) {
                toolTruncation = undefined;
            }

            return {
                body: Buffer.from(JSON.stringify(payload), 'utf8'),
                meta,
                toolTruncation,
            };
        } catch {
            return { body };
        }
    }

    private async forward(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        body: Buffer,
        config: ThrottlingProxyConfig,
        streamOpts?: { modelName?: string; isStreaming?: boolean; isThinkingModel?: boolean }
    ): Promise<{ statusCode?: number; errorSnippet?: string }> {
        return await new Promise((resolve, reject) => {
            let settled = false;

            const settleResolve = (value: { statusCode?: number; errorSnippet?: string }) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(value);
            };

            const settleReject = (err: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(err);
            };

            // Get timeout configuration
            const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
            const timeoutMs = streamOpts?.isThinkingModel
                ? cfg.get<number>('thinkingTimeoutMs', 60000)
                : cfg.get<number>('requestTimeoutMs', 120000);

            let timeoutId: NodeJS.Timeout | undefined;
            let didTimeout = false;

            const upstreamReq = http.request(
                {
                    hostname: config.upstreamHost,
                    port: config.upstreamPort,
                    path: req.url,
                    method: req.method,
                    headers: {
                        ...req.headers,
                        host: `${config.upstreamHost}:${config.upstreamPort}`,
                        'content-length': body.length,
                    },
                },
                (upstreamRes) => {
                    const status = upstreamRes.statusCode ?? 502;

                    // CRITICAL FIX: For 429 errors, throw an error to trigger retry
                    // Do NOT pipe the response to the client yet, or retry won't work
                    if (status === 429) {
                        // Buffer the error response body first
                        const chunks: Buffer[] = [];
                        upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                        upstreamRes.on('end', () => {
                            if (timeoutId) {
                                clearTimeout(timeoutId);
                            }
                            const errorBody = Buffer.concat(chunks).toString('utf8');
                            const err = new RateLimitError(
                                `Rate limit exceeded (429): ${errorBody.slice(0, 200)}`,
                                status,
                                errorBody
                            );
                            settleReject(err);
                        });
                        upstreamRes.on('error', reject);
                        return;
                    }

                    upstreamRes.on('error', reject);

                    const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
                    const transformThinking = cfg.get<boolean>('transformThinking', true);
                    const transformMode = cfg.get<string>('thinkingTransformMode', 'none');

                    const wantStreamingPreflight =
                        status === 200 &&
                        streamOpts?.isStreaming === true &&
                        (req.url ?? '').startsWith('/v1/chat/completions');

                    // Capture a small snippet of the upstream response for diagnostics.
                    // Note: for SSE this will be partial and not valid JSON; it's still useful in logs.
                    const captureLimit = 4096;
                    let captured = '';
                    upstreamRes.on('data', (chunk: Buffer) => {
                        if (captured.length >= captureLimit) {
                            return;
                        }
                        const text = chunk.toString('utf8');
                        captured += text.slice(0, Math.max(0, captureLimit - captured.length));
                    });

                    const writeUpstreamHeaders = () => {
                        res.statusCode = status;
                        for (const [key, value] of Object.entries(upstreamRes.headers)) {
                            if (value !== undefined) {
                                res.setHeader(key, value as any);
                            }
                        }
                    };

                    // If upstream returns an empty/malformed SSE (e.g., immediate [DONE] or no choices),
                    // Copilot throws "Response contained no choices" on 200 OK. We preflight the first
                    // SSE event and convert it to a proper non-2xx JSON error instead.
                    const beginStreamingPipeline = async (initial?: Buffer) => {
                        const shouldTransform =
                            transformThinking &&
                            transformMode !== 'none' &&
                            streamOpts?.isStreaming &&
                            streamOpts?.isThinkingModel &&
                            status === 200;

                        const debugLog = cfg.get<boolean>('logRequests', false)
                            ? (msg: string) => this.logInfo(msg)
                            : undefined;

                        // Optionally log passthrough mode.
                        if (!shouldTransform && streamOpts?.isThinkingModel && cfg.get<boolean>('logRequests', false)) {
                            this.logInfo(`Passthrough mode for thinking model ${streamOpts.modelName} (transformMode=${transformMode})`);
                        }

                        writeUpstreamHeaders();

                        const replay = new PassThrough();
                        if (initial && initial.length > 0) {
                            replay.write(initial);
                        }
                        upstreamRes.pipe(replay);

                        // Attach a detector to warn if the stream never emits any choices.
                        const detectorEnabled = cfg.get<boolean>('logRequests', false);
                        const detector = detectorEnabled
                            ? new SSEChoicesDetector((warning: string) => this.logInfo(warning))
                            : undefined;

                        const source = detector ? replay.pipe(detector) : replay;

                        if (shouldTransform) {
                            let transformer: ThinkingStreamTransformer | OpenAIToClaudeStreamTransformer | ReasoningAnnotatorTransformer;
                            switch (transformMode) {
                                case 'claude':
                                    transformer = new OpenAIToClaudeStreamTransformer(streamOpts.modelName, debugLog);
                                    break;
                                case 'enhanced':
                                    transformer = new ThinkingStreamTransformer(streamOpts.modelName, debugLog);
                                    break;
                                case 'annotate':
                                default:
                                    transformer = new ReasoningAnnotatorTransformer(streamOpts.modelName, debugLog);
                                    break;
                            }

                            this.logInfo(`Transforming thinking stream (mode=${transformMode}) for ${streamOpts.modelName}`);
                            source.pipe(transformer).pipe(res);
                            transformer.on('error', (err) => {
                                this.logInfo(`Stream transform error: ${err.message}`);
                                if (!res.writableEnded) {
                                    res.end();
                                }
                            });
                        } else {
                            source.pipe(res);
                        }
                    };

                    const handleNonStreaming = () => {
                        writeUpstreamHeaders();
                        upstreamRes.pipe(res);
                    };

                    if (wantStreamingPreflight) {
                        void (async () => {
                            const preflight = await preflightFirstSseEvent(upstreamRes, 8192);

                            // If we can confidently say this is an "empty choices" stream, return a proper error.
                            if (!preflight.ok) {
                                if (timeoutId) {
                                    clearTimeout(timeoutId);
                                }
                                try {
                                    upstreamRes.destroy();
                                } catch {
                                    // ignore
                                }

                                if (!res.headersSent) {
                                    res.statusCode = 502;
                                    res.setHeader('content-type', 'application/json');
                                    res.end(
                                        JSON.stringify({
                                            error: {
                                                message: 'Upstream returned an empty or malformed streaming response',
                                                details: preflight.reason ?? 'No choices detected in initial SSE event',
                                                code: 'UPSTREAM_EMPTY_CHOICES',
                                            },
                                        })
                                    );
                                } else {
                                    res.end();
                                }
                                settleResolve({ statusCode: 502, errorSnippet: captured ? captured.trim() : undefined });
                                return;
                            }

                            await beginStreamingPipeline(preflight.buffer);
                        })().catch((err: unknown) => {
                            const e = err instanceof Error ? err : new Error(String(err));
                            settleReject(e);
                        });
                    } else {
                        // Non-streaming or non-chat endpoints.
                        handleNonStreaming();
                    }

                    upstreamRes.on('end', () => {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                        }
                        if (!didTimeout) {
                            settleResolve({ statusCode: status, errorSnippet: captured ? captured.trim() : undefined });
                        }
                    });
                }
            );

            upstreamReq.on('error', (err) => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                settleReject(err);
            });

            // Set timeout for thinking models to prevent quota exhaustion
            if (timeoutMs > 0) {
                timeoutId = setTimeout(() => {
                    didTimeout = true;
                    this.logInfo(`Request timeout (${timeoutMs}ms) for ${streamOpts?.modelName ?? 'unknown'}`);
                    try {
                        upstreamReq.destroy();
                    } catch {
                        // ignore
                    }

                    if (!res.headersSent) {
                        res.statusCode = 504;
                        res.setHeader('content-type', 'application/json');
                        res.end(JSON.stringify({
                            error: {
                                message: 'Request timeout',
                                details: `Request exceeded ${Math.round(timeoutMs / 1000)}s limit to prevent quota exhaustion. Try a simpler prompt or shorter context.`,
                            },
                        }));
                    } else {
                        // If headers are already sent (streaming), we cannot change status.
                        // Best effort: terminate the response so Copilot stops waiting.
                        try {
                            res.end();
                        } catch {
                            // ignore
                        }
                    }
                    settleResolve({ statusCode: 504, errorSnippet: 'Timeout exceeded' });
                }, timeoutMs);
            }

            // If Copilot cancels the request, stop upstream work too.
            const abortUpstream = () => {
                try {
                    upstreamReq.destroy();
                } catch {
                    // ignore
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };
            req.on('aborted', abortUpstream);
            res.on('close', abortUpstream);

            upstreamReq.write(body);
            upstreamReq.end();
        });
    }

    private logRequestMeta(entry: {
        method: string;
        path: string;
        model?: string;
        statusCode?: number;
        durationMs: number;
        tokenRewrite?: TokenRewriteMeta;
        toolTruncation?: ToolTruncationMeta;
        upstreamErrorSnippet?: string;
    }): void {
        const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
        const enabled = cfg.get<boolean>('logRequests', false);
        if (!enabled) {
            return;
        }

        const parts: string[] = [];
        parts.push(`${entry.method} ${entry.path}`);
        if (entry.model) {
            parts.push(`model=${entry.model}`);
        }
        if (typeof entry.statusCode === 'number') {
            parts.push(`status=${entry.statusCode}`);
        }
        parts.push(`durationMs=${entry.durationMs}`);

        const tr = entry.tokenRewrite;
        if (tr?.enabled) {
            parts.push(`cap=${tr.cap}`);
            if (typeof tr.originalMaxTokens === 'number') {
                parts.push(`max_tokens=${tr.originalMaxTokens}->${tr.finalMaxTokens}`);
            }
            if (typeof tr.originalMaxOutputTokens === 'number') {
                parts.push(`max_output_tokens=${tr.originalMaxOutputTokens}->${tr.finalMaxOutputTokens}`);
            }
            if (typeof tr.originalMaxCompletionTokens === 'number') {
                parts.push(`max_completion_tokens=${tr.originalMaxCompletionTokens}->${tr.finalMaxCompletionTokens}`);
            }
        }

        const tt = entry.toolTruncation;
        if (tt && tt.truncatedMessages > 0) {
            parts.push(`tool_trunc=${tt.truncatedMessages}`);
            parts.push(`tool_chars=${tt.originalTotalChars}->${tt.finalTotalChars}`);
        }

        this.logInfo(parts.join(' | '));

        // Log a small snippet for non-2xx responses; helps pinpoint upstream error type.
        if (entry.upstreamErrorSnippet) {
            this.logInfo(`upstream_error_snippet=${sanitizeForLog(entry.upstreamErrorSnippet)}`);
        }
    }

    private logInfo(message: string): void {
        this.output.appendLine(`[${new Date().toISOString()}] PROXY ${message}`);
    }

    public dispose(): void {
        this.configChangeListener?.dispose();
        this.concurrencyManager.dispose();
        void this.stop();
    }

}

interface TokenRewriteMeta {
    enabled: boolean;
    cap: number;
    isThinking: boolean;
    originalMaxTokens?: number;
    finalMaxTokens?: number;
    originalMaxOutputTokens?: number;
    finalMaxOutputTokens?: number;
    originalMaxCompletionTokens?: number;
    finalMaxCompletionTokens?: number;
}

interface ToolTruncationMeta {
    truncatedMessages: number;
    originalTotalChars: number;
    finalTotalChars: number;
}

function truncateToolMessagesInPayload(
    payload: any,
    opts: { maxChars: number; headChars: number; tailChars: number }
): ToolTruncationMeta {
    const maxChars = Number.isFinite(opts.maxChars) ? Math.max(0, Math.floor(opts.maxChars)) : 0;
    let headChars = Number.isFinite(opts.headChars) ? Math.max(0, Math.floor(opts.headChars)) : 0;
    let tailChars = Number.isFinite(opts.tailChars) ? Math.max(0, Math.floor(opts.tailChars)) : 0;

    // Ensure we can actually fit head+tail within max.
    if (maxChars > 0 && headChars + tailChars > maxChars) {
        // Prefer preserving the start of tool output.
        headChars = Math.min(headChars, maxChars);
        tailChars = Math.max(0, maxChars - headChars);
    }

    const meta: ToolTruncationMeta = {
        truncatedMessages: 0,
        originalTotalChars: 0,
        finalTotalChars: 0,
    };

    const messages = payload?.messages;
    if (!Array.isArray(messages) || maxChars <= 0) {
        return meta;
    }

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
            continue;
        }
        if (msg.role !== 'tool') {
            continue;
        }
        if (typeof msg.content !== 'string') {
            continue;
        }

        const original = msg.content;
        meta.originalTotalChars += original.length;

        if (original.length <= maxChars) {
            meta.finalTotalChars += original.length;
            continue;
        }

        const head = original.slice(0, headChars);
        const tail = tailChars > 0 ? original.slice(-tailChars) : '';
        const omitted = original.length - head.length - tail.length;
        const marker = `\n\n...[Antigravity proxy truncated tool output: ${omitted} chars omitted]...\n\n`;
        const truncated = head + marker + tail;

        msg.content = truncated;
        meta.truncatedMessages += 1;
        meta.finalTotalChars += truncated.length;
    }

    return meta;
}

function sanitizeForLog(text: string): string {
    // Avoid multi-line log spam; never include request bodies/prompts here.
    return text.replace(/\s+/g, ' ').slice(0, 400);
}

function isSameConfig(a: ThrottlingProxyConfig, b: ThrottlingProxyConfig): boolean {
    return (
        a.enabled === b.enabled &&
        a.host === b.host &&
        a.port === b.port &&
        a.upstreamHost === b.upstreamHost &&
        a.upstreamPort === b.upstreamPort
    );
}

async function preflightFirstSseEvent(
    upstreamRes: http.IncomingMessage,
    maxBytes: number
): Promise<{ ok: boolean; buffer: Buffer; reason?: string }> {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const take = (): Promise<Buffer> =>
        new Promise((resolve, reject) => {
            const onData = (chunk: Buffer) => {
                if (done) {
                    return;
                }
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                chunks.push(buf);
                total += buf.length;

                const merged = Buffer.concat(chunks);
                const text = merged.toString('utf8');
                const hasDelimiter = text.includes('\n\n');
                if (hasDelimiter || total >= maxBytes) {
                    cleanup();
                    done = true;
                    // Pause immediately so we don't race and consume too much before we pipe.
                    try {
                        upstreamRes.pause();
                    } catch {
                        // ignore
                    }
                    resolve(merged);
                }
            };

            const onEnd = () => {
                if (done) {
                    return;
                }
                cleanup();
                done = true;
                resolve(Buffer.concat(chunks));
            };

            const onError = (err: Error) => {
                if (done) {
                    return;
                }
                cleanup();
                done = true;
                reject(err);
            };

            const cleanup = () => {
                upstreamRes.off('data', onData);
                upstreamRes.off('end', onEnd);
                upstreamRes.off('error', onError);
            };

            upstreamRes.on('data', onData);
            upstreamRes.once('end', onEnd);
            upstreamRes.once('error', onError);
        });

    const buffer = await take();

    // Resume now that we have buffered the initial chunk(s). Piping will also resume.
    try {
        upstreamRes.resume();
    } catch {
        // ignore
    }

    const text = buffer.toString('utf8');
    const firstEvent = text.split('\n\n')[0] ?? '';
    const match = firstEvent.match(/^data:\s*(.+)$/m);
    if (!match) {
        return { ok: true, buffer };
    }

    const payload = match[1].trim();
    if (!payload) {
        return { ok: false, buffer, reason: 'First SSE event had empty data payload' };
    }
    if (payload === '[DONE]') {
        return { ok: false, buffer, reason: 'Upstream returned [DONE] without any choices' };
    }

    try {
        const parsed = JSON.parse(payload);
        const choices = parsed?.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
            return { ok: false, buffer, reason: 'Upstream returned JSON with empty/missing choices in first SSE event' };
        }
    } catch {
        // If it's not JSON, let it through (some upstreams may send comments/keepalives first).
        return { ok: true, buffer };
    }

    return { ok: true, buffer };
}

class SSEChoicesDetector extends Transform {
    private buffer = '';
    private sawChoices = false;

    constructor(private readonly warn: (msg: string) => void) {
        super();
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            const text = chunk.toString('utf8');
            this.buffer += text;

            // Parse complete SSE events without modifying the stream.
            let idx: number;
            while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
                const event = this.buffer.slice(0, idx);
                this.buffer = this.buffer.slice(idx + 2);
                const match = event.match(/^data:\s*(.+)$/m);
                if (!match) {
                    continue;
                }
                const payload = match[1].trim();
                if (!payload || payload === '[DONE]') {
                    continue;
                }
                try {
                    const parsed = JSON.parse(payload);
                    const choices = parsed?.choices;
                    if (Array.isArray(choices) && choices.length > 0) {
                        this.sawChoices = true;
                    }
                } catch {
                    // ignore
                }
            }

            this.push(chunk);
            callback();
        } catch {
            // Best-effort: still passthrough.
            this.push(chunk);
            callback();
        }
    }

    _flush(callback: TransformCallback): void {
        if (!this.sawChoices) {
            this.warn('WARNING: Streaming response ended without any choices detected (Copilot may report "Response contained no choices")');
        }
        callback();
    }
}
