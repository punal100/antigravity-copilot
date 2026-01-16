import { Transform, TransformCallback } from 'stream';

/**
 * Transforms OpenAI-compatible SSE streaming responses to inject thinking content
 * in a format that VS Code Copilot BYOK can recognize and display.
 * 
 * The upstream CLIProxyAPI returns reasoning tokens as `reasoning_content` in the delta:
 *   {"choices":[{"delta":{"reasoning_content":"thinking text..."}}]}
 * 
 * This transformer:
 * 1. Detects `reasoning_content` in streaming chunks
 * 2. Emits special SSE events that VS Code can render as collapsible thinking blocks
 * 3. Maintains proper SSE formatting throughout
 */
export class ThinkingStreamTransformer extends Transform {
    private buffer = '';
    private thinkingActive = false;
    private thinkingIndex = 0;
    private contentIndex = 1;
    private messageStarted = false;
    private chunkCounter = 0;

    constructor(
        private readonly modelName?: string,
        private readonly debug?: (msg: string) => void
    ) {
        super();
    }

    private log(msg: string): void {
        if (this.debug) {
            this.debug(`[ThinkingTransformer] ${msg}`);
        }
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            this.buffer += chunk.toString('utf8');
            const results: string[] = [];

            // Process complete SSE lines
            let lineEnd: number;
            while ((lineEnd = this.buffer.indexOf('\n\n')) !== -1) {
                const line = this.buffer.slice(0, lineEnd);
                this.buffer = this.buffer.slice(lineEnd + 2);

                const transformed = this.processSSELine(line);
                if (transformed) {
                    results.push(transformed);
                }
            }

            // Also handle single newline separators
            while ((lineEnd = this.buffer.indexOf('\n')) !== -1 && !this.buffer.startsWith('data:')) {
                const line = this.buffer.slice(0, lineEnd);
                this.buffer = this.buffer.slice(lineEnd + 1);
                
                if (line.trim()) {
                    const transformed = this.processSSELine(line);
                    if (transformed) {
                        results.push(transformed);
                    }
                }
            }

            if (results.length > 0) {
                this.push(results.join(''));
            }
            callback();
        } catch (error) {
            this.log(`Transform error: ${error}`);
            // On error, pass through the original chunk
            callback(null, chunk);
        }
    }

    _flush(callback: TransformCallback): void {
        // Process any remaining buffer content
        if (this.buffer.trim()) {
            try {
                const transformed = this.processSSELine(this.buffer);
                if (transformed) {
                    this.push(transformed);
                }
            } catch {
                this.push(this.buffer);
            }
        }
        callback();
    }

    private processSSELine(line: string): string | null {
        // Handle [DONE] marker
        if (line.includes('[DONE]')) {
            return line.endsWith('\n\n') ? line : line + '\n\n';
        }

        // Extract data from SSE line
        const dataMatch = line.match(/^data:\s*(.+)$/m);
        if (!dataMatch) {
            return line.endsWith('\n\n') ? line : line + '\n\n';
        }

        const dataStr = dataMatch[1].trim();
        if (!dataStr || dataStr === '[DONE]') {
            return line.endsWith('\n\n') ? line : line + '\n\n';
        }

        try {
            const data = JSON.parse(dataStr);
            this.chunkCounter++;

            // Check for reasoning_content in the delta
            const delta = data?.choices?.[0]?.delta;
            if (!delta) {
                return this.formatSSE(data);
            }

            const reasoningContent = delta.reasoning_content;
            const regularContent = delta.content;

            // Handle reasoning_content (thinking)
            if (reasoningContent !== undefined && reasoningContent !== null && reasoningContent !== '') {
                this.log(`Found reasoning_content in chunk ${this.chunkCounter}: ${reasoningContent.slice(0, 50)}...`);
                return this.emitThinkingContent(data, reasoningContent);
            }

            // Handle regular content - need to close thinking block first if active
            if (regularContent !== undefined && regularContent !== null && regularContent !== '') {
                if (this.thinkingActive) {
                    this.thinkingActive = false;
                    // Transition from thinking to content
                    return this.emitContentAfterThinking(data);
                }
            }

            return this.formatSSE(data);
        } catch (parseError) {
            this.log(`JSON parse error: ${parseError}`);
            return line.endsWith('\n\n') ? line : line + '\n\n';
        }
    }

    private emitThinkingContent(originalData: any, thinking: string): string {
        const results: string[] = [];

        // If this is the first thinking chunk, emit a thinking block start indicator
        if (!this.thinkingActive) {
            this.thinkingActive = true;
            this.log('Starting thinking block');
        }

        // Create a modified chunk that includes thinking as a special annotation
        // VS Code's LanguageModelThinkingPart expects 'thinking' in a specific format
        // We'll emit it both as reasoning_content (for compatible clients) and
        // in a way that can be detected by the client
        const modifiedData = JSON.parse(JSON.stringify(originalData));
        
        // Keep reasoning_content for clients that understand it
        modifiedData.choices[0].delta.reasoning_content = thinking;
        
        // Add a special marker that our extension or compatible clients can detect
        // Some clients look for 'thinking' in delta
        modifiedData.choices[0].delta._thinking = thinking;
        modifiedData.choices[0].delta._thinking_active = true;

        results.push(this.formatSSE(modifiedData));

        return results.join('');
    }

    private emitContentAfterThinking(originalData: any): string {
        const results: string[] = [];

        // Emit a marker that thinking has ended
        const thinkingEndMarker = JSON.parse(JSON.stringify(originalData));
        thinkingEndMarker.choices[0].delta = {
            _thinking_end: true
        };
        results.push(this.formatSSE(thinkingEndMarker));

        // Then emit the regular content
        results.push(this.formatSSE(originalData));

        return results.join('');
    }

    private formatSSE(data: any): string {
        return `data: ${JSON.stringify(data)}\n\n`;
    }
}

/**
 * Alternative transformer that converts OpenAI streaming format to Claude/Anthropic
 * streaming format. This is more compatible with VS Code's internal handling.
 * 
 * Claude streaming format uses:
 * - event: message_start
 * - event: content_block_start (with type: "thinking" for reasoning)
 * - event: content_block_delta (with type: "thinking_delta")
 * - event: content_block_stop
 * - event: message_delta
 * - event: message_stop
 */
export class OpenAIToClaudeStreamTransformer extends Transform {
    private buffer = '';
    private messageStarted = false;
    private thinkingBlockStarted = false;
    private textBlockStarted = false;
    private thinkingBlockIndex = 0;
    private textBlockIndex = 1;
    private messageId = `msg_${Date.now()}`;
    private accumulatedThinking = '';
    private accumulatedContent = '';

    constructor(
        private readonly modelName?: string,
        private readonly debug?: (msg: string) => void
    ) {
        super();
    }

    private log(msg: string): void {
        if (this.debug) {
            this.debug(`[ClaudeTransformer] ${msg}`);
        }
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            this.buffer += chunk.toString('utf8');
            const results: string[] = [];

            // Process complete SSE lines
            let lineEnd: number;
            while ((lineEnd = this.buffer.indexOf('\n\n')) !== -1) {
                const line = this.buffer.slice(0, lineEnd);
                this.buffer = this.buffer.slice(lineEnd + 2);

                const transformed = this.processSSEChunk(line);
                if (transformed) {
                    results.push(transformed);
                }
            }

            if (results.length > 0) {
                this.push(results.join(''));
            }
            callback();
        } catch (error) {
            this.log(`Transform error: ${error}`);
            callback(null, chunk);
        }
    }

    _flush(callback: TransformCallback): void {
        const results: string[] = [];

        // Close any open blocks
        if (this.thinkingBlockStarted) {
            results.push(this.formatClaudeEvent('content_block_stop', { 
                type: 'content_block_stop', 
                index: this.thinkingBlockIndex 
            }));
        }
        if (this.textBlockStarted) {
            results.push(this.formatClaudeEvent('content_block_stop', { 
                type: 'content_block_stop', 
                index: this.textBlockIndex 
            }));
        }

        // Emit message stop if we started
        if (this.messageStarted) {
            results.push(this.formatClaudeEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 0 }
            }));
            results.push(this.formatClaudeEvent('message_stop', { type: 'message_stop' }));
        }

        if (results.length > 0) {
            this.push(results.join(''));
        }

        if (this.buffer.trim()) {
            this.push(this.buffer);
        }

        callback();
    }

    private processSSEChunk(line: string): string | null {
        // Handle [DONE] marker
        if (line.includes('[DONE]')) {
            return null; // We'll emit proper Claude stop events in _flush
        }

        const dataMatch = line.match(/^data:\s*(.+)$/m);
        if (!dataMatch) {
            return null;
        }

        const dataStr = dataMatch[1].trim();
        if (!dataStr || dataStr === '[DONE]') {
            return null;
        }

        try {
            const data = JSON.parse(dataStr);
            return this.transformOpenAIToClaudeSSE(data);
        } catch (parseError) {
            this.log(`JSON parse error: ${parseError}`);
            return null;
        }
    }

    private transformOpenAIToClaudeSSE(data: any): string {
        const results: string[] = [];

        // Emit message_start on first chunk
        if (!this.messageStarted) {
            this.messageStarted = true;
            results.push(this.formatClaudeEvent('message_start', {
                type: 'message_start',
                message: {
                    id: this.messageId,
                    type: 'message',
                    role: 'assistant',
                    model: this.modelName || data?.model || 'unknown',
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            }));
        }

        const delta = data?.choices?.[0]?.delta;
        if (!delta) {
            return results.join('');
        }

        const reasoningContent = delta.reasoning_content;
        const content = delta.content;

        // Handle reasoning_content -> thinking blocks
        if (reasoningContent !== undefined && reasoningContent !== null && reasoningContent !== '') {
            // Start thinking block if not started
            if (!this.thinkingBlockStarted) {
                this.thinkingBlockStarted = true;
                results.push(this.formatClaudeEvent('content_block_start', {
                    type: 'content_block_start',
                    index: this.thinkingBlockIndex,
                    content_block: { type: 'thinking', thinking: '' }
                }));
            }

            // Emit thinking delta
            this.accumulatedThinking += reasoningContent;
            results.push(this.formatClaudeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: this.thinkingBlockIndex,
                delta: { type: 'thinking_delta', thinking: reasoningContent }
            }));
        }

        // Handle content -> text blocks
        if (content !== undefined && content !== null && content !== '') {
            // Close thinking block first if open
            if (this.thinkingBlockStarted && !this.textBlockStarted) {
                results.push(this.formatClaudeEvent('content_block_stop', {
                    type: 'content_block_stop',
                    index: this.thinkingBlockIndex
                }));
                this.thinkingBlockStarted = false;
            }

            // Start text block if not started
            if (!this.textBlockStarted) {
                this.textBlockStarted = true;
                results.push(this.formatClaudeEvent('content_block_start', {
                    type: 'content_block_start',
                    index: this.textBlockIndex,
                    content_block: { type: 'text', text: '' }
                }));
            }

            // Emit text delta
            this.accumulatedContent += content;
            results.push(this.formatClaudeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: this.textBlockIndex,
                delta: { type: 'text_delta', text: content }
            }));
        }

        // Handle finish reason
        const finishReason = data?.choices?.[0]?.finish_reason;
        if (finishReason) {
            // Close any open blocks
            if (this.thinkingBlockStarted) {
                results.push(this.formatClaudeEvent('content_block_stop', {
                    type: 'content_block_stop',
                    index: this.thinkingBlockIndex
                }));
                this.thinkingBlockStarted = false;
            }
            if (this.textBlockStarted) {
                results.push(this.formatClaudeEvent('content_block_stop', {
                    type: 'content_block_stop',
                    index: this.textBlockIndex
                }));
                this.textBlockStarted = false;
            }

            // Emit message delta with stop reason
            results.push(this.formatClaudeEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: this.mapFinishReason(finishReason), stop_sequence: null },
                usage: data?.usage || { output_tokens: 0 }
            }));

            results.push(this.formatClaudeEvent('message_stop', { type: 'message_stop' }));
        }

        return results.join('');
    }

    private formatClaudeEvent(event: string, data: any): string {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    private mapFinishReason(openaiReason: string): string {
        switch (openaiReason) {
            case 'stop': return 'end_turn';
            case 'length': return 'max_tokens';
            case 'tool_calls': return 'tool_use';
            default: return 'end_turn';
        }
    }
}

/**
 * Minimal passthrough transformer that annotates reasoning_content
 * without changing the overall response format. This preserves
 * OpenAI compatibility while adding metadata hints.
 */
export class ReasoningAnnotatorTransformer extends Transform {
    private buffer = '';
    private hasSeenReasoning = false;

    constructor(
        private readonly modelName?: string,
        private readonly debug?: (msg: string) => void
    ) {
        super();
    }

    private log(msg: string): void {
        if (this.debug) {
            this.debug(`[ReasoningAnnotator] ${msg}`);
        }
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            this.buffer += chunk.toString('utf8');
            const results: string[] = [];

            // Process complete SSE lines
            let lineEnd: number;
            while ((lineEnd = this.buffer.indexOf('\n\n')) !== -1) {
                const line = this.buffer.slice(0, lineEnd);
                this.buffer = this.buffer.slice(lineEnd + 2);

                const transformed = this.processLine(line);
                results.push(transformed);
            }

            if (results.length > 0) {
                this.push(results.join(''));
            }
            callback();
        } catch (error) {
            callback(null, chunk);
        }
    }

    _flush(callback: TransformCallback): void {
        if (this.buffer.trim()) {
            const transformed = this.processLine(this.buffer);
            this.push(transformed);
        }
        callback();
    }

    private processLine(line: string): string {
        const dataMatch = line.match(/^data:\s*(.+)$/m);
        if (!dataMatch) {
            return line + '\n\n';
        }

        const dataStr = dataMatch[1].trim();
        if (!dataStr || dataStr === '[DONE]') {
            return line + '\n\n';
        }

        try {
            const data = JSON.parse(dataStr);
            const delta = data?.choices?.[0]?.delta;

            if (delta?.reasoning_content) {
                if (!this.hasSeenReasoning) {
                    this.hasSeenReasoning = true;
                    this.log('First reasoning content detected');
                }
                // Annotate the delta with thinking markers
                delta._is_thinking = true;
            }

            return `data: ${JSON.stringify(data)}\n\n`;
        } catch {
            return line + '\n\n';
        }
    }
}
