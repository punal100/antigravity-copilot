import * as http from 'http';
import * as vscode from 'vscode';
import { RateLimiter } from './RateLimiter';
import { ThinkingStreamTransformer, OpenAIToClaudeStreamTransformer, ReasoningAnnotatorTransformer } from './ThinkingStreamTransformer';

export interface ThrottlingProxyConfig {
    enabled: boolean;
    host: string;
    port: number;
    upstreamHost: string;
    upstreamPort: number;
}

export class ThrottlingProxyServer implements vscode.Disposable {
    private server: http.Server | undefined;

    constructor(
        private readonly output: vscode.OutputChannel,
        private readonly rateLimiter: RateLimiter
    ) {}

    public getStatus(): { running: boolean; port?: number; host?: string } {
        const address = this.server?.address();
        if (!address || typeof address === 'string') {
            return { running: !!this.server };
        }
        return { running: !!this.server, port: address.port, host: address.address };
    }

    public async start(config: ThrottlingProxyConfig): Promise<void> {
        if (!config.enabled) {
            return;
        }

        if (this.server) {
            return;
        }

        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res, config);
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(config.port, config.host, () => {
                this.server!.off('error', reject);
                resolve();
            });
        });

        const status = this.getStatus();
        this.logInfo(`Throttling proxy started on http://${status.host}:${status.port} -> http://${config.upstreamHost}:${config.upstreamPort}`);
    }

    public async stop(): Promise<void> {
        if (!this.server) {
            return;
        }
        const srv = this.server;
        this.server = undefined;
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

            const modelName = this.tryExtractModelName(req, body);
            const isStreaming = this.isStreamingRequest(body);
            const isThinkingModel = (modelName ?? '').toLowerCase().includes('thinking');

            // Optionally clamp output token request sizes to reduce long generations that frequently
            // trigger upstream rate limits mid-stream.
            const rewriteResult = this.tryRewriteTokenLimits(req, body, modelName);

            const startedAt = Date.now();

            // Serialize + cooldown using the rate limiter.
            await this.rateLimiter.waitUntilCanProceed(modelName);
            this.rateLimiter.startRequest(modelName);

            const forwardResult = await this.forward(req, res, rewriteResult.body, config, {
                modelName,
                isStreaming,
                isThinkingModel,
            });

            this.rateLimiter.endRequest();

            this.logRequestMeta({
                method: req.method ?? 'GET',
                path: req.url ?? '',
                model: modelName,
                statusCode: forwardResult.statusCode,
                durationMs: Date.now() - startedAt,
                tokenRewrite: rewriteResult.meta,
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
                res.statusCode = 502;
                res.setHeader('content-type', 'application/json');
            }
            res.end(JSON.stringify({ error: { message: 'Upstream request failed', details: message } }));
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
        try {
            const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
            const rewrite = cfg.get<boolean>('rewriteMaxTokens', true);
            if (!rewrite) {
                return { body };
            }

            const url = req.url ?? '';
            if (!url.startsWith('/v1/chat/completions') && !url.startsWith('/v1/responses')) {
                return { body };
            }
            if (!body || body.length === 0) {
                return { body };
            }

            const isThinking = (modelName ?? '').toLowerCase().includes('thinking');
            const cap = isThinking
                ? cfg.get<number>('maxTokensThinking', 2048)
                : cfg.get<number>('maxTokensStandard', 4096);
            if (!Number.isFinite(cap) || cap <= 0) {
                return { body };
            }

            const jsonText = body.toString('utf8');
            const payload: any = JSON.parse(jsonText);

            const meta: TokenRewriteMeta = {
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

            return { body: Buffer.from(JSON.stringify(payload), 'utf8'), meta };
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
                    res.statusCode = upstreamRes.statusCode ?? 502;
                    for (const [key, value] of Object.entries(upstreamRes.headers)) {
                        if (value !== undefined) {
                            res.setHeader(key, value as any);
                        }
                    }

                    upstreamRes.on('error', reject);

                    const status = upstreamRes.statusCode;
                    const shouldCapture = typeof status === 'number' && status >= 400;
                    const captureLimit = 4096;
                    let captured = '';

                    if (shouldCapture) {
                        upstreamRes.on('data', (chunk: Buffer) => {
                            if (captured.length >= captureLimit) {
                                return;
                            }
                            const text = chunk.toString('utf8');
                            captured += text.slice(0, Math.max(0, captureLimit - captured.length));
                        });
                    }

                    // For streaming responses from thinking models, optionally transform the response
                    // to annotate reasoning_content so clients can display it as thinking.
                    const cfg = vscode.workspace.getConfiguration('antigravityCopilot.proxy');
                    const transformThinking = cfg.get<boolean>('transformThinking', true);
                    const transformMode = cfg.get<string>('thinkingTransformMode', 'annotate');
                    
                    const shouldTransform = transformThinking && 
                        streamOpts?.isStreaming && 
                        streamOpts?.isThinkingModel && 
                        status === 200;

                    if (shouldTransform) {
                        const debugLog = cfg.get<boolean>('logRequests', false) 
                            ? (msg: string) => this.logInfo(msg) 
                            : undefined;

                        let transformer: ThinkingStreamTransformer | OpenAIToClaudeStreamTransformer | ReasoningAnnotatorTransformer;
                        
                        switch (transformMode) {
                            case 'claude':
                                // Full conversion to Claude streaming format
                                transformer = new OpenAIToClaudeStreamTransformer(streamOpts.modelName, debugLog);
                                break;
                            case 'enhanced':
                                // Enhanced OpenAI format with thinking markers
                                transformer = new ThinkingStreamTransformer(streamOpts.modelName, debugLog);
                                break;
                            case 'annotate':
                            default:
                                // Minimal annotation of reasoning_content
                                transformer = new ReasoningAnnotatorTransformer(streamOpts.modelName, debugLog);
                                break;
                        }

                        this.logInfo(`Transforming thinking stream (mode=${transformMode}) for ${streamOpts.modelName}`);
                        
                        upstreamRes.pipe(transformer).pipe(res);
                        transformer.on('error', (err) => {
                            this.logInfo(`Stream transform error: ${err.message}`);
                            // On transformer error, try to end gracefully
                            if (!res.writableEnded) {
                                res.end();
                            }
                        });
                    } else {
                        // Direct passthrough
                        upstreamRes.pipe(res);
                    }

                    upstreamRes.on('end', () => {
                        resolve({ statusCode: status, errorSnippet: captured ? captured.trim() : undefined });
                    });
                }
            );

            upstreamReq.on('error', reject);

            // If Copilot cancels the request, stop upstream work too.
            const abortUpstream = () => {
                try {
                    upstreamReq.destroy();
                } catch {
                    // ignore
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

function sanitizeForLog(text: string): string {
    // Avoid multi-line log spam; never include request bodies/prompts here.
    return text.replace(/\s+/g, ' ').slice(0, 400);
}
