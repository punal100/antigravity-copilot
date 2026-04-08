import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import * as yauzl from 'yauzl';

const execFileAsync = promisify(execFileCallback);

interface GitHubAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GitHubRelease {
    tag_name: string;
    assets: GitHubAsset[];
}

function getPlatformAssetName(): 'windows' | 'linux' | 'darwin' | 'freebsd' {
    if (process.platform === 'win32') {
        return 'windows';
    }
    if (process.platform === 'darwin') {
        return 'darwin';
    }
    if (process.platform === 'freebsd') {
        return 'freebsd';
    }
    return 'linux';
}

function getExecutableName(): string {
    return process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
}

/**
 * Fetches the latest release info for CLIProxyAPI from GitHub
 */
async function fetchLatestRelease(): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/router-for-me/CLIProxyAPI/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'vscode-antigravity-copilot',
                'Accept': 'application/vnd.github+json'
            }
        };

        const req = https.get(options, (res) => {
            let body = '';

            if (res.statusCode === 403) {
                const remaining = res.headers['x-ratelimit-remaining'];
                const reset = res.headers['x-ratelimit-reset'];
                const resetTime = reset ? new Date(parseInt(reset, 10) * 1000).toLocaleTimeString() : 'unknown';
                reject(new Error(`GitHub API rate limit exceeded. Remaining: ${remaining}, Reset at: ${resetTime}`));
                return;
            }

            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`GitHub API returned status ${res.statusCode}: ${body}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error('Failed to parse GitHub API response'));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('GitHub API request timeout'));
        });
    });
}

/**
 * Finds the correct platform asset in the release
 */
function findPlatformAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
    const arch = process.arch;
    const archPattern = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : 'amd64';
    const platformPattern = getPlatformAssetName();
    return assets.find(asset =>
        asset.name.toLowerCase().includes(platformPattern) &&
        asset.name.toLowerCase().includes(archPattern) &&
        (process.platform === 'win32' ? asset.name.endsWith('.zip') : asset.name.endsWith('.tar.gz'))
    );
}

/**
 * Downloads a file with progress reporting
 */
async function downloadFile(url: string, dest: string, onProgress: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const timeout = 300000;

        const request = https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    response.destroy();
                    file.close();
                    fs.unlink(dest, () => {});
                    downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                response.resume();
                file.close();
                fs.unlink(dest, () => {});
                reject(new Error(`Server returned status ${response.statusCode}`));
                return;
            }

            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedSize = 0;
            let timeoutTimer: NodeJS.Timeout;

            const resetTimeout = () => {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                }
                timeoutTimer = setTimeout(() => {
                    request.destroy();
                    file.close();
                    fs.unlink(dest, () => {});
                    reject(new Error('Download timeout'));
                }, timeout);
            };

            resetTimeout();

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize > 0) {
                    onProgress(Math.round((downloadedSize / totalSize) * 100));
                }
                resetTimeout();
            });

            response.pipe(file);

            file.on('finish', () => {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                }
                file.close();
                resolve();
            });
        });

        request.on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });

        request.setTimeout(timeout, () => {
            request.destroy();
            file.close();
            fs.unlink(dest, () => {});
            reject(new Error('Download request timeout'));
        });
    });
}

/**
 * Extracts a ZIP file to a target directory
 */
async function extractZip(zipPath: string, targetDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            if (!zipfile) return reject(new Error('Could not open ZIP file'));

            const absoluteTargetDir = path.resolve(targetDir);
            let closed = false;

            const closeZipFile = () => {
                if (!closed) {
                    closed = true;
                    zipfile.close();
                }
            };

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                const entryPath = path.resolve(targetDir, entry.fileName);

                if (!entryPath.startsWith(absoluteTargetDir + path.sep)) {
                    closeZipFile();
                    reject(new Error(`Zip Slip detected: ${entry.fileName} escapes target directory`));
                    return;
                }

                if (/\/$/.test(entry.fileName)) {
                    fs.mkdirSync(entryPath, { recursive: true });
                    zipfile.readEntry();
                } else {
                    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            closeZipFile();
                            return reject(err);
                        }
                        if (!readStream) {
                            closeZipFile();
                            return reject(new Error('Could not read stream from ZIP'));
                        }

                        const writeStream = fs.createWriteStream(entryPath);
                        readStream.on('error', (err) => {
                            writeStream.destroy();
                            closeZipFile();
                            fs.unlink(entryPath, () => {});
                            reject(err);
                        });
                        readStream.pipe(writeStream);
                        writeStream.on('finish', () => {
                            zipfile.readEntry();
                        });
                        writeStream.on('error', (err) => {
                            closeZipFile();
                            fs.unlink(entryPath, () => {});
                            reject(err);
                        });
                    });
                }
            });

            zipfile.on('end', () => {
                closeZipFile();
                resolve();
            });

            zipfile.on('error', (err) => {
                closeZipFile();
                reject(err);
            });
        });
    });
}

/**
 * Extracts a tar.gz file to a target directory
 */
async function extractTarGz(tarPath: string, targetDir: string): Promise<void> {
    await execFileAsync('tar', ['-xzf', tarPath, '-C', targetDir]);
}

/**
 * Finds cli-proxy-api recursively in a directory
 */
function findExecutable(targetDir: string): string | null {
    const targetNames = process.platform === 'win32'
        ? ['cli-proxy-api.exe']
        : ['cli-proxy-api', 'cli-proxy-api.exe'];

    for (const targetName of targetNames) {
        const targetPath = path.join(targetDir, targetName);
        if (fs.existsSync(targetPath)) {
            return targetPath;
        }
    }

    const subdirs = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => path.join(targetDir, dirent.name));

    for (const subdir of subdirs) {
        const found = findExecutable(subdir);
        if (found) {
            return found;
        }
    }

    return null;
}

/**
 * Main orchestration for installing CLIProxyAPI
 */
export async function installCLIProxyAPI(
    onProgress: (percent: number) => void,
    outputChannel?: vscode.OutputChannel
): Promise<{ success: boolean; version: string; executablePath?: string; error?: string }> {
    const tempDir = os.tmpdir();
    const isWindows = process.platform === 'win32';
    const archiveExtension = isWindows ? 'zip' : 'tar.gz';
    const archivePath = path.join(tempDir, `CLIProxyAPI.${archiveExtension}`);
    const userProfile = os.homedir();
    const targetDir = path.join(userProfile, 'CLIProxyAPI');

    try {
        outputChannel?.appendLine('[INFO] Fetching latest CLIProxyAPI release information...');
        const release = await fetchLatestRelease();
        const asset = findPlatformAsset(release.assets);

        if (!asset) {
            return { success: false, version: '', error: `Could not find a ${process.platform} asset in the latest release` };
        }

        outputChannel?.appendLine(`[INFO] Downloading CLIProxyAPI ${release.tag_name} from: ${asset.browser_download_url}`);
        await downloadFile(asset.browser_download_url, archivePath, onProgress);

        outputChannel?.appendLine(`[INFO] Extracting to: ${targetDir}`);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        if (isWindows) {
            await extractZip(archivePath, targetDir);
        } else {
            await extractTarGz(archivePath, targetDir);
        }

        const foundExecutable = findExecutable(targetDir);
        if (foundExecutable) {
            outputChannel?.appendLine(`[INFO] Found executable at: ${foundExecutable}`);
            if (process.platform !== 'win32') {
                fs.chmodSync(foundExecutable, 0o755);
            }
        } else {
            outputChannel?.appendLine(`[WARN] Could not find ${getExecutableName()} in ${targetDir}`);
        }

        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }

        outputChannel?.appendLine('[INFO] CLIProxyAPI installed successfully');
        return { success: true, version: release.tag_name, executablePath: foundExecutable || undefined };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[ERROR] Installation failed: ${msg}`);

        if (fs.existsSync(archivePath)) {
            try {
                fs.unlinkSync(archivePath);
            } catch (cleanupError) {
                outputChannel?.appendLine(`[WARN] Failed to cleanup temp file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            }
        }

        return { success: false, version: '', error: msg };
    }
}
