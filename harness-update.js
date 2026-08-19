'use strict';

/* =========================================================
 * Harness 更新模块（主进程）
 *
 * - 检查：registry 上 @deepseek-ai/dsh 最新版本 vs 内置版本
 * - 更新：内置 npm（runtime 本身是 npm 布局，原生兼容，
 *   不动皮肤等非依赖目录）安装新版本 → dump-config 校验
 *   → 重启 Harness；失败自动回滚到旧版本
 * ========================================================= */

const {
    dialog
} = require('electron');

const fs = require('fs');
const path = require('path');
const {
    spawn
} = require('child_process');

/**
 * registry 数据源（官方 → 国内镜像）
 */
const REGISTRY_URLS = [
    'https://registry.npmjs.org/@deepseek-ai%2fdsh/latest',
    'https://registry.npmmirror.com/@deepseek-ai%2fdsh/latest'
];

const PACKAGE_NAME = '@deepseek-ai/dsh';

let ctx = null;
let updateBusy = false;

/* =========================================================
 * 基础工具
 * ========================================================= */

function getHarnessDir() {

    return ctx.harnessDir;
}

function getHarnessPackageJson() {

    return path.join(
        getHarnessDir(),
        'package.json'
    );
}

function getNodeExe() {

    return path.join(
        getHarnessDir(),
        'dsh-service.exe'
    );
}

function getNpmCli() {

    return path.join(
        getHarnessDir(),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js'
    );
}

function getDshDir() {

    return path.join(
        getHarnessDir(),
        'node_modules',
        '@deepseek-ai',
        'dsh'
    );
}

/**
 * 读取内置 dsh 版本
 */
function getLocalVersion() {

    try {

        const m = JSON.parse(
            fs.readFileSync(
                path.join(
                    getDshDir(),
                    'package.json'
                ),
                'utf8'
            )
        );

        return typeof m.version === 'string'
            ? m.version
            : null;

    } catch {
        return null;
    }
}

/**
 * 版本解析（x.y.z[-rc.N] 形式，dsh 版本专用）
 */
function parseVersion(v) {

    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|beta|alpha)\.(\d+))?$/
        .exec(String(v).trim());

    if (!m) {
        return null;
    }

    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        pre: m[4] || 'zzz',
        preNum: m[4] ? Number(m[5]) : 0
    };
}

/**
 * 比较版本：a > b 返回 1；相等 0；a < b 返回 -1
 */
function compareVersions(a, b) {

    const pa = parseVersion(a);
    const pb = parseVersion(b);

    if (!pa || !pb) {
        return 0;
    }

    if (pa.major !== pb.major) {
        return pa.major > pb.major ? 1 : -1;
    }

    if (pa.minor !== pb.minor) {
        return pa.minor > pb.minor ? 1 : -1;
    }

    if (pa.patch !== pb.patch) {
        return pa.patch > pb.patch ? 1 : -1;
    }

    // 正式版（无 pre）大于预发布
    if (pa.pre === 'zzz' && pb.pre !== 'zzz') {
        return 1;
    }

    if (pb.pre === 'zzz' && pa.pre !== 'zzz') {
        return -1;
    }

    if (pa.pre !== pb.pre) {
        return pa.pre > pb.pre ? 1 : -1;
    }

    if (pa.preNum !== pb.preNum) {
        return pa.preNum > pb.preNum ? 1 : -1;
    }

    return 0;
}

/**
 * 查询 registry 最新版本
 */
async function getRemoteVersion() {

    for (const url of REGISTRY_URLS) {

        try {

            const res = await fetch(
                url,
                {
                    signal:
                        AbortSignal.timeout(8000),
                    headers: {
                        'User-Agent':
                            'DeepSeek-Harness-Desktop'
                    }
                }
            );

            if (!res.ok) {
                continue;
            }

            const data = await res.json();

            if (
                data &&
                typeof data.version === 'string'
            ) {

                console.log(
                    '[HARNESS-UPDATE] 远程最新版本：',
                    data.version,
                    '（', url, '）'
                );

                return data.version;
            }

        } catch {
            // 尝试下一个源
        }
    }

    return null;
}

/* =========================================================
 * npm 执行（内置 npm-cli.js）
 * ========================================================= */

function runNpmInHarness(args) {

    return new Promise(
        (resolve, reject) => {

            const nodeExe = getNodeExe();
            const npmCli = getNpmCli();

            if (!fs.existsSync(nodeExe)) {

                reject(
                    new Error(
                        '内置运行时缺失（dsh-service.exe）'
                    )
                );

                return;
            }

            if (!fs.existsSync(npmCli)) {

                reject(
                    new Error(
                        '内置 npm 缺失'
                    )
                );

                return;
            }

            let stderrTail = '';

            const child = spawn(
                nodeExe,
                [
                    npmCli,
                    ...args
                ],
                {
                    cwd: getHarnessDir(),
                    windowsHide: true,
                    env: {
                        ...process.env,
                        FORCE_COLOR: '0',
                        NO_COLOR: '1'
                    },
                    stdio: [
                        'ignore',
                        'pipe',
                        'pipe'
                    ]
                }
            );

            child.stdout.on(
                'data',
                (chunk) => {

                    const text = String(chunk).trim();

                    if (text) {

                        console.log(
                            '[HARNESS-UPDATE][npm]',
                            text.slice(0, 400)
                        );
                    }
                }
            );

            child.stderr.on(
                'data',
                (chunk) => {
                    stderrTail =
                        (stderrTail + String(chunk))
                            .slice(-2000);
                }
            );

            child.on(
                'error',
                (error) => {
                    reject(
                        new Error(
                            'npm 启动失败：' +
                            error.message
                        )
                    );
                }
            );

            child.on(
                'close',
                (code) => {

                    if (code === 0) {
                        resolve();
                        return;
                    }

                    reject(
                        new Error(
                            'npm 执行失败' +
                            (
                                stderrTail
                                    ? '：' + stderrTail.slice(-600)
                                    : '（退出码 ' + code + '）'
                            )
                        )
                    );
                }
            );
        }
    );
}

/**
 * 校验：dsh 能否正常 dump-config
 */
function verifyHarness() {

    return new Promise(
        (resolve) => {

            const nodeExe = getNodeExe();
            const binPath = path.join(
                getDshDir(),
                'lib',
                'bin.js'
            );

            const child = spawn(
                nodeExe,
                [
                    binPath,
                    'web',
                    '--dump-config'
                ],
                {
                    cwd: getHarnessDir(),
                    windowsHide: true,
                    stdio: [
                        'ignore',
                        'pipe',
                        'pipe'
                    ]
                }
            );

            const timer = setTimeout(
                () => {

                    try {
                        child.kill();
                    } catch {
                        // 忽略
                    }

                    resolve(false);

                },
                60000
            );

            child.on(
                'error',
                () => {
                    clearTimeout(timer);
                    resolve(false);
                }
            );

            child.on(
                'close',
                (code) => {
                    clearTimeout(timer);
                    resolve(code === 0);
                }
            );
        }
    );
}

/**
 * 把 harness package.json 的 dsh 依赖锁成精确版本
 */
function lockDshVersion(version) {

    const p = getHarnessPackageJson();

    if (!fs.existsSync(p)) {
        return;
    }

    const m = JSON.parse(
        fs.readFileSync(p, 'utf8')
    );

    m.dependencies = m.dependencies ?? {};
    m.dependencies[PACKAGE_NAME] = version;

    fs.writeFileSync(
        p,
        JSON.stringify(m, null, 2),
        'utf8'
    );

    console.log(
        '[HARNESS-UPDATE] 已锁定版本：',
        PACKAGE_NAME + '@' + version
    );
}

/**
 * 用内置 npm 安装指定版本（--no-save：不改 package.json，
 * --ignore-scripts：不跑原生构建，与现有运行时行为一致）
 */
function installDshVersion(version) {

    return runNpmInHarness([
        'install',
        PACKAGE_NAME + '@' + version,
        '--no-save',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund'
    ]);
}

/* =========================================================
 * 更新流程
 * ========================================================= */

function sendProgress(text) {

    console.log('[HARNESS-UPDATE]', text);

    if (ctx.getTray) {

        try {

            const tray = ctx.getTray();

            if (tray) {

                tray.displayBalloon({
                    title: 'DeepSeek Harness',
                    content: text,
                    iconType: 'info'
                });
            }

        } catch {
            // 气泡失败忽略
        }
    }
}

async function performUpdate(oldVersion, newVersion) {

    if (updateBusy) {

        throw new Error(
            '已有更新任务在进行中'
        );
    }

    updateBusy = true;

    try {

        sendProgress(
            '开始更新 Harness：' + oldVersion +
            ' → ' + newVersion + '（需要网络，请稍候）'
        );

        await installDshVersion(newVersion);

        // 校验
        const actual = getLocalVersion();
        const verified =
            actual === newVersion &&
            await verifyHarness();

        if (!verified) {

            throw new Error(
                '更新校验失败（实际版本：' + actual + '）'
            );
        }

        lockDshVersion(newVersion);

        sendProgress(
            'Harness 已更新到 ' + newVersion +
            '，正在重启…'
        );

        await ctx.restartHarness();

        sendProgress(
            'Harness 更新完成 ✓（' + newVersion + '）'
        );

        return {
            ok: true,
            version: newVersion
        };

    } catch (error) {

        console.error(
            '[HARNESS-UPDATE] 更新失败：',
            error.message
        );

        sendProgress(
            '更新失败，正在回滚到 ' + oldVersion + '…'
        );

        try {

            await installDshVersion(oldVersion);
            lockDshVersion(oldVersion);

            sendProgress(
                '已回滚到 ' + oldVersion
            );

        } catch (rollbackError) {

            console.error(
                '[HARNESS-UPDATE] 回滚失败：',
                rollbackError.message
            );
        }

        throw error;

    } finally {
        updateBusy = false;
    }
}

/**
 * 检查更新。manual=true 表示用户从托盘触发。
 */
async function checkForHarnessUpdate(manual) {

    const local = getLocalVersion();
    const remote = await getRemoteVersion();

    console.log(
        '[HARNESS-UPDATE] 本地 ' + local +
        ' / 远程 ' + remote
    );

    if (!local || !remote) {

        if (manual) {

            await dialog.showMessageBox({
                type: 'warning',
                title: 'Harness 更新',
                message: '无法检查 Harness 更新',
                detail:
                    '无法访问 npm registry。请确认网络可用（如开启代理）后重试。',
                buttons: ['确定'],
                noLink: true
            });
        }

        return {
            hasUpdate: false
        };
    }

    if (compareVersions(local, remote) >= 0) {

        if (manual) {

            await dialog.showMessageBox({
                type: 'info',
                title: 'Harness 更新',
                message:
                    'Harness 已是最新版本（' + local + '）',
                buttons: ['确定'],
                noLink: true
            });
        }

        return {
            hasUpdate: false,
            local,
            remote
        };
    }

    // 有更新
    if (!manual) {

        sendProgress(
            '发现 Harness 新版本 ' + remote +
            '（当前 ' + local + '），托盘菜单可更新'
        );

        return {
            hasUpdate: true,
            local,
            remote
        };
    }

    const result = await dialog.showMessageBox({
        type: 'question',
        title: 'Harness 更新',
        message:
            '发现 Harness 新版本：' + remote +
            '（当前 ' + local + '）',
        detail:
            '更新会下载新版本并自动重启 Harness。' +
            '如更新后出现异常，可等待修复版本后再次更新。',
        buttons: [
            '更新',
            '取消'
        ],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });

    if (result.response !== 0) {

        return {
            hasUpdate: true,
            local,
            remote,
            declined: true
        };
    }

    try {

        const outcome =
            await performUpdate(local, remote);

        return {
            hasUpdate: false,
            local: outcome.version,
            remote,
            updated: true
        };

    } catch (error) {

        await dialog.showMessageBox({
            type: 'error',
            title: 'Harness 更新失败',
            message: '更新失败：' + error.message,
            detail:
                '已尝试自动回滚到 ' + local +
                '。请确认网络后重试，或重启应用。',
            buttons: ['确定'],
            noLink: true
        });

        return {
            hasUpdate: true,
            local,
            remote,
            failed: true
        };
    }
}

/* =========================================================
 * 初始化
 * ========================================================= */

function initHarnessUpdate(options) {

    ctx = options;

    console.log(
        '[HARNESS-UPDATE] Harness 更新模块已初始化（本地 ' +
        getLocalVersion() + '）'
    );
}

module.exports = {
    initHarnessUpdate,
    checkForHarnessUpdate,
    /**
     * 仅供自动化测试使用
     */
    _internals: {
        compareVersions,
        getLocalVersion,
        getRemoteVersion,
        performUpdate
    }
};
