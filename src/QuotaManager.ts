import * as vscode from 'vscode';
import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ModelQuotaInfo {
    label: string;
    modelId: string;
    remainingFraction?: number;
    remainingPercentage?: number;
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: number;
    timeUntilResetFormatted: string;
}

export interface PromptCreditsInfo {
    available: number;
    monthly: number;
    usedPercentage: number;
    remainingPercentage: number;
}

export interface QuotaSnapshot {
    timestamp: Date;
    promptCredits?: PromptCreditsInfo;
    models: ModelQuotaInfo[];
}

interface ProcessInfo {
    port: number;
    csrfToken: string;
}

interface ServerUserStatusResponse {
    userStatus: {
        name: string;
        email: string;
        planStatus?: {
            planInfo: {
                teamsTier: string;
                planName: string;
                monthlyPromptCredits: number;
                monthlyFlowCredits: number;
            };
            availablePromptCredits: number;
            availableFlowCredits: number;
        };
        cascadeModelConfigData?: {
            clientModelConfigs: any[];
        };
    };
}

export class QuotaManager {
    private port: number = 0;
    private csrfToken: string = '';
    private lastSnapshot?: QuotaSnapshot;
    private lastFetchTime: number = 0;
    private isInitialized: boolean = false;

    // Rate limiting: minimum 30 seconds between API calls
    private readonly MIN_FETCH_INTERVAL_MS = 30000;

    private readonly _onDidUpdate = new vscode.EventEmitter<QuotaSnapshot>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    private readonly _onDidError = new vscode.EventEmitter<Error>();
    public readonly onDidError = this._onDidError.event;

    constructor(private readonly output: vscode.OutputChannel) {}

    private log(message: string): void {
        this.output.appendLine(`[QUOTA] ${message}`);
    }

    /**
     * Detect the Antigravity process and extract port + CSRF token
     */
    public async detectProcess(): Promise<boolean> {
        try {
            this.log('Detecting Antigravity process...');

            // Use PowerShell to get process info with command line
            const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='language_server_windows_x64.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
            
            const { stdout, stderr } = await execAsync(cmd);
            
            if (stderr) {
                this.log(`Process detection stderr: ${stderr}`);
            }

            if (!stdout.trim()) {
                this.log('No Antigravity process found');
                return false;
            }

            const data = JSON.parse(stdout.trim());
            const processes = Array.isArray(data) ? data : [data];

            // Find Antigravity process (has --app_data_dir antigravity)
            const antigravityProcess = processes.find((p: any) => 
                p.CommandLine && (
                    p.CommandLine.includes('--app_data_dir antigravity') ||
                    p.CommandLine.toLowerCase().includes('\\antigravity\\')
                )
            );

            if (!antigravityProcess || !antigravityProcess.CommandLine) {
                this.log('No Antigravity-specific process found');
                return false;
            }

            const commandLine = antigravityProcess.CommandLine;
            
            // Extract CSRF token
            const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
            if (!tokenMatch || !tokenMatch[1]) {
                this.log('CSRF token not found in command line');
                return false;
            }
            this.csrfToken = tokenMatch[1];

            // Extract extension server port (optional, we'll discover it)
            const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
            const extensionPort = portMatch ? parseInt(portMatch[1], 10) : 0;

            // Get listening ports for this PID
            const pid = antigravityProcess.ProcessId;
            const portsCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
            
            const { stdout: portsStdout } = await execAsync(portsCmd);
            
            let ports: number[] = [];
            if (portsStdout.trim()) {
                try {
                    const portsData = JSON.parse(portsStdout.trim());
                    ports = Array.isArray(portsData) ? portsData : [portsData];
                } catch {
                    this.log('Failed to parse ports');
                }
            }

            // Try to find the working port by testing each one
            let workingPort = 0;
            for (const port of ports) {
                const isWorking = await this.testPort(port);
                if (isWorking) {
                    workingPort = port;
                    break;
                }
            }

            if (!workingPort) {
                this.log('No working port found');
                return false;
            }

            this.port = workingPort;
            this.isInitialized = true;
            this.log(`Detected Antigravity on port ${this.port} with CSRF token ${this.csrfToken.substring(0, 8)}...`);
            
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Process detection failed: ${message}`);
            return false;
        }
    }

    /**
     * Test if a port responds to the API
     */
    private testPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': this.csrfToken,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: 3000,
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            JSON.parse(body);
                            resolve(true);
                        } catch {
                            resolve(false);
                        }
                    } else {
                        resolve(false);
                    }
                });
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }

    /**
     * Fetch quota data from the API
     * Respects rate limiting to avoid API abuse
     */
    public async fetchQuota(forceRefresh: boolean = false): Promise<QuotaSnapshot | null> {
        const now = Date.now();
        const timeSinceLastFetch = now - this.lastFetchTime;

        // Rate limiting check
        if (!forceRefresh && timeSinceLastFetch < this.MIN_FETCH_INTERVAL_MS && this.lastSnapshot) {
            this.log(`Rate limited. Using cached data (${Math.round(timeSinceLastFetch / 1000)}s since last fetch)`);
            return this.lastSnapshot;
        }

        // Initialize if needed
        if (!this.isInitialized) {
            const detected = await this.detectProcess();
            if (!detected) {
                this._onDidError.fire(new Error('Antigravity process not detected'));
                return null;
            }
        }

        try {
            this.log('Fetching quota from API...');
            
            const data = await this.request<ServerUserStatusResponse>(
                '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                {
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        locale: 'en',
                    },
                }
            );

            const snapshot = this.parseResponse(data);
            this.lastSnapshot = snapshot;
            this.lastFetchTime = Date.now();

            this.log(`Quota fetched: ${snapshot.models.length} models`);
            this._onDidUpdate.fire(snapshot);

            return snapshot;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.log(`Quota fetch failed: ${err.message}`);
            
            // Try to re-detect process on failure
            this.isInitialized = false;
            
            this._onDidError.fire(err);
            return this.lastSnapshot || null;
        }
    }

    /**
     * Get cached snapshot without making an API call
     */
    public getCachedSnapshot(): QuotaSnapshot | null {
        return this.lastSnapshot || null;
    }

    /**
     * Get time until next refresh is allowed (in seconds)
     */
    public getTimeUntilNextRefresh(): number {
        const timeSinceLastFetch = Date.now() - this.lastFetchTime;
        const remaining = this.MIN_FETCH_INTERVAL_MS - timeSinceLastFetch;
        return Math.max(0, Math.ceil(remaining / 1000));
    }

    /**
     * Check if refresh is currently allowed
     */
    public canRefresh(): boolean {
        return Date.now() - this.lastFetchTime >= this.MIN_FETCH_INTERVAL_MS;
    }

    private request<T>(path: string, body: object): Promise<T> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: this.port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': this.csrfToken,
                },
                rejectUnauthorized: false,
                timeout: 5000,
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body) as T);
                    } catch {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    private parseResponse(data: ServerUserStatusResponse): QuotaSnapshot {
        const userStatus = data.userStatus;
        const planInfo = userStatus.planStatus?.planInfo;
        const availableCredits = userStatus.planStatus?.availablePromptCredits;

        let promptCredits: PromptCreditsInfo | undefined;

        if (planInfo && availableCredits !== undefined) {
            const monthly = Number(planInfo.monthlyPromptCredits);
            const available = Number(availableCredits);
            if (monthly > 0) {
                promptCredits = {
                    available,
                    monthly,
                    usedPercentage: ((monthly - available) / monthly) * 100,
                    remainingPercentage: (available / monthly) * 100,
                };
            }
        }

        const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
        const models: ModelQuotaInfo[] = rawModels
            .filter((m: any) => m.quotaInfo)
            .map((m: any) => {
                const resetTime = new Date(m.quotaInfo.resetTime);
                const now = new Date();
                const diff = resetTime.getTime() - now.getTime();

                return {
                    label: m.label,
                    modelId: m.modelOrAlias?.model || 'unknown',
                    remainingFraction: m.quotaInfo.remainingFraction,
                    remainingPercentage: m.quotaInfo.remainingFraction !== undefined 
                        ? m.quotaInfo.remainingFraction * 100 
                        : undefined,
                    isExhausted: m.quotaInfo.remainingFraction === 0,
                    resetTime: resetTime,
                    timeUntilReset: diff,
                    timeUntilResetFormatted: this.formatTime(diff, resetTime),
                };
            });

        return {
            timestamp: new Date(),
            promptCredits,
            models,
        };
    }

    private formatTime(ms: number, resetTime: Date): string {
        if (ms <= 0) return 'Ready';
        
        const mins = Math.ceil(ms / 60000);
        let duration = '';
        
        if (mins < 60) {
            duration = `${mins}m`;
        } else {
            const hours = Math.floor(mins / 60);
            duration = `${hours}h ${mins % 60}m`;
        }

        const dateStr = resetTime.toLocaleDateString(undefined, {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        });
        const timeStr = resetTime.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        return `${duration} (${dateStr} ${timeStr})`;
    }

    public dispose(): void {
        this._onDidUpdate.dispose();
        this._onDidError.dispose();
    }
}
