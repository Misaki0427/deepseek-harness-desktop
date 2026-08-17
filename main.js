const {
    app,
    BrowserWindow,
    dialog,
    shell,
    session,
    Tray,
    Menu,
    nativeImage
} = require('electron');

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');


/* =========================================================
 * 基本配置
 * ========================================================= */

const HARNESS_HOST = '127.0.0.1';
const HARNESS_PORT = 3080;
const HARNESS_URL = `http://${HARNESS_HOST}:${HARNESS_PORT}`;

/**
 * 开发环境：
 *   F:\DeepSeek Harness\harness
 *
 * 打包环境：
 *   安装目录\resources\harness
 */
const HARNESS_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'harness')
    : path.join(__dirname, 'harness-runtime');

const HARNESS_CWD = HARNESS_DIR;

/**
 * 内置 Node.js
 */
const NODE_EXE = path.join(
    HARNESS_DIR,
    'node.exe'
);

/**
 * DSH CLI 真实入口
 *
 * @deepseek-ai/dsh
 *   bin:
 *     dsh -> lib/bin.js
 */
const DSH_ENTRY = path.join(
    HARNESS_DIR,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
);

/**
 * Harness 看门狗入口
 */
const WATCHDOG_ENTRY = path.join(
    HARNESS_DIR,
    'watchdog.js'
);

/**
 * DSH Web UI 身份标记
 */
const DSH_MARKER = '__DSH_BOOT__';

/**
 * 崩溃自动恢复：最多重试次数
 */
const MAX_RESTART_ATTEMPTS = 3;

/**
 * 自动恢复基础退避间隔（毫秒）
 */
const RESTART_BASE_DELAY_MS = 2000;

/**
 * HTTP 检查超时时间
 */
const HTTP_TIMEOUT = 1500;

/**
 * 启动最长等待时间：60 秒
 */
const START_TIMEOUT_SECONDS = 60;

/**
 * 停止后最多等待 10 秒确认 3080 已释放
 */
const STOP_TIMEOUT = 10000;


/* =========================================================
 * 全局变量
 * ========================================================= */

let mainWindow = null;

let tray = null;

/**
 * Desktop Manager 启动的 Harness 进程。
 *
 * 实际结构：
 *
 * Electron
 *   ↓
 * 内置 node.exe
 *   ↓
 * @deepseek-ai/dsh
 *   ↓
 * 127.0.0.1:3080
 */
let harnessProcess = null;

/**
 * 是否是本程序启动的 Harness
 */
let startedByUs = false;

/**
 * 是否正在启动
 */
let isStarting = false;

/**
 * 是否正在停止
 */
let isStopping = false;

/**
 * Electron 是否正在退出
 */
let isQuitting = false;

/**
 * 防止重复启动
 */
let startPromise = null;

/**
 * 防止重复停止
 */
let stopPromise = null;

/**
 * 崩溃自动恢复状态
 */
let restartAttempts = 0;

let restartTimer = null;


/* =========================================================
 * 基础工具
 * ========================================================= */

/**
 * 延迟
 */
function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


/**
 * 检查 Harness HTTP 服务
 */
function checkHarness() {
    return new Promise((resolve) => {

        let finished = false;

        function finish(result) {
            if (finished) {
                return;
            }

            finished = true;
            resolve(result);
        }

        const request = http.get(
            HARNESS_URL,
            {
                timeout: HTTP_TIMEOUT
            },
            (response) => {

                response.resume();

                /**
                 * 200～499 都说明 HTTP 服务已经起来了。
                 */
                finish(
                    response.statusCode >= 200 &&
                    response.statusCode < 500
                );
            }
        );

        request.on(
            'error',
            () => {
                finish(false);
            }
        );

        request.on(
            'timeout',
            () => {
                request.destroy();
                finish(false);
            }
        );
    });
}


/**
 * 识别 3080 端口上的服务身份。
 *
 * @returns {'none' | 'dsh' | 'foreign'}
 */
function identifyService() {
    return new Promise((resolve) => {

        let finished = false;

        function finish(result) {
            if (finished) {
                return;
            }

            finished = true;
            resolve(result);
        }

        const request = http.get(
            HARNESS_URL,
            {
                timeout: HTTP_TIMEOUT,

                headers: {
                    'Accept-Encoding': 'identity'
                }
            },
            (response) => {

                const status =
                    response.statusCode;

                if (status < 200 || status >= 500) {

                    response.resume();
                    finish('none');

                    return;
                }

                let body = '';

                response.on(
                    'data',
                    (chunk) => {

                        body += chunk.toString('utf8');

                        if (body.includes(DSH_MARKER)) {

                            request.destroy();
                            finish('dsh');

                        } else if (
                            body.length > 64 * 1024
                        ) {

                            request.destroy();
                            finish('foreign');
                        }
                    }
                );

                response.on(
                    'end',
                    () => {
                        finish(
                            body.includes(DSH_MARKER)
                                ? 'dsh'
                                : 'foreign'
                        );
                    }
                );

                response.on(
                    'error',
                    () => {
                        finish('foreign');
                    }
                );
            }
        );

        request.on(
            'error',
            () => {
                finish('none');
            }
        );

        request.on(
            'timeout',
            () => {
                request.destroy();
                finish('none');
            }
        );
    });
}


/**
 * 只允许 http/https 交给系统浏览器打开。
 */
function openExternalSafe(rawUrl) {

    try {

        const url =
            new URL(rawUrl);

        if (
            url.protocol === 'http:' ||
            url.protocol === 'https:'
        ) {

            shell.openExternal(
                url.toString()
            );

            return true;
        }

    } catch {
        // 非法 URL，忽略
    }

    console.warn(
        '[WINDOW] 拒绝打开非 http/https 链接：',
        rawUrl
    );

    return false;
}


/**
 * 等待 Harness 启动
 */
async function waitForHarness(
    maxAttempts = START_TIMEOUT_SECONDS
) {
    console.log(
        `[HARNESS] 等待 Web UI，最多 ${maxAttempts} 秒...`
    );

    for (
        let i = 1;
        i <= maxAttempts;
        i++
    ) {

        const running =
            await checkHarness();

        if (running) {

            console.log(
                '[HARNESS] Web UI 已就绪'
            );

            return true;
        }

        console.log(
            `[HARNESS] 等待 Harness... ${i}/${maxAttempts}`
        );

        await sleep(1000);
    }

    console.error(
        '[HARNESS] 等待 Harness 超时'
    );

    return false;
}


/**
 * 等待 Harness 完全停止
 */
async function waitForHarnessStopped() {

    const startTime = Date.now();

    while (
        Date.now() - startTime < STOP_TIMEOUT
    ) {

        const running =
            await checkHarness();

        if (!running) {
            return true;
        }

        await sleep(300);
    }

    return false;
}


/**
 * 检查内置运行环境
 */
function validateHarnessRuntime() {

    console.log('[HARNESS] 工作目录：', HARNESS_DIR);
    console.log('[HARNESS] Node：', NODE_EXE);
    console.log('[HARNESS] DSH：', DSH_ENTRY);

    if (!fs.existsSync(HARNESS_DIR)) {
        throw new Error(
            `找不到 Harness 目录：\n${HARNESS_DIR}`
        );
    }

    if (!fs.existsSync(NODE_EXE)) {
        throw new Error(
            `找不到内置 Node.js：\n${NODE_EXE}`
        );
    }

    if (!fs.existsSync(DSH_ENTRY)) {
        throw new Error(
            `找不到 DSH 启动文件：\n${DSH_ENTRY}`
        );
    }

    if (!fs.existsSync(WATCHDOG_ENTRY)) {
        throw new Error(
            `找不到看门狗文件：\n${WATCHDOG_ENTRY}`
        );
    }

    console.log(
        '[HARNESS] 内置运行环境检查通过'
    );
}


/* =========================================================
 * Windows 进程树停止
 * ========================================================= */

function killProcessTree(pid) {

    return new Promise((resolve) => {

        if (!pid) {
            resolve();
            return;
        }

        console.log(
            `[HARNESS] 正在结束进程树 PID=${pid}`
        );

        if (process.platform !== 'win32') {

            try {
                process.kill(
                    pid,
                    'SIGTERM'
                );
            } catch (error) {
                // 进程已经退出
            }

            resolve();
            return;
        }

        const killer =
            spawn(
                'taskkill',
                [
                    '/PID',
                    String(pid),
                    '/T',
                    '/F'
                ],
                {
                    windowsHide: true,
                    stdio: 'ignore'
                }
            );

        killer.on(
            'error',
            (error) => {

                console.error(
                    '[HARNESS] taskkill 执行失败：',
                    error
                );

                resolve();
            }
        );

        killer.on(
            'close',
            (code) => {

                console.log(
                    `[HARNESS] taskkill 完成，code=${code}`
                );

                resolve();
            }
        );
    });
}


/* =========================================================
 * Harness 启动
 * ========================================================= */

function startHarness() {

    /**
     * 如果已经有启动任务，
     * 直接等待原来的任务。
     */
    if (startPromise) {

        console.log(
            '[HARNESS] 已经存在启动任务，等待当前任务...'
        );

        return startPromise;
    }

    startPromise =
        (async () => {

            try {

                /* -----------------------------------------
                 * Windows 检查
                 * ----------------------------------------- */

                if (process.platform !== 'win32') {

                    throw new Error(
                        '当前版本暂时只支持 Windows。'
                    );
                }


                /* -----------------------------------------
                 * 检查是否已经运行
                 * ----------------------------------------- */

                const identity =
                    await identifyService();

                if (identity === 'dsh') {

                    console.log(
                        '[HARNESS] 检测到 Harness 已经运行'
                    );

                    /**
                     * 不是本程序启动的。
                     *
                     * 如果当前仍有自己管理的进程
                     * （例如自动恢复刚成功），
                     * 不要覆盖 startedByUs。
                     */
                    if (!harnessProcess) {
                        startedByUs = false;
                    }

                    return true;
                }

                if (identity === 'foreign') {

                    throw new Error(
                        [
                            '检测到 127.0.0.1:3080 已被其他程序占用。',
                            '',
                            '请先关闭占用该端口的程序，',
                            '再重新启动 DeepSeek Harness。'
                        ].join('\n')
                    );
                }


                /* -----------------------------------------
                 * 防止重复启动
                 * ----------------------------------------- */

                if (isStarting) {

                    console.log(
                        '[HARNESS] 已经处于启动状态'
                    );

                    return false;
                }

                isStarting = true;


                console.log('');
                console.log(
                    '======================================'
                );
                console.log(
                    '正在启动 DeepSeek Harness...'
                );
                console.log(
                    '======================================'
                );


                /* -----------------------------------------
                 * 检查内置运行环境
                 * ----------------------------------------- */

                validateHarnessRuntime();


                /* -----------------------------------------
                 * 启动内置 Node.js
                 * ----------------------------------------- */

                console.log(
                    '[Manager] Node:',
                    NODE_EXE
                );

                console.log(
                    '[Manager] DSH:',
                    DSH_ENTRY
                );

                console.log(
                    '[Manager] CWD:',
                    HARNESS_CWD
                );


                const child =
                    spawn(
                        NODE_EXE,
                        [
                            WATCHDOG_ENTRY,
                            String(process.pid)
                        ],
                        {
                            cwd: HARNESS_CWD,

                            env: {
                                ...process.env,
                                FORCE_COLOR: '1',
                                NODE_ENV: 'production'
                            },

                            windowsHide: true,

                            stdio: [
                                'ignore',
                                'pipe',
                                'pipe'
                            ]
                        }
                    );


                harnessProcess =
                    child;

                startedByUs =
                    true;


                console.log(
                    `[HARNESS] Manager PID: ${child.pid}`
                );


                /* -----------------------------------------
                 * stdout
                 * ----------------------------------------- */

                if (child.stdout) {

                    child.stdout.on(
                        'data',
                        (data) => {

                            const text =
                                data.toString().trim();

                            if (text) {

                                console.log(
                                    `[Harness] ${text}`
                                );
                            }
                        }
                    );
                }


                /* -----------------------------------------
                 * stderr
                 * ----------------------------------------- */

                if (child.stderr) {

                    child.stderr.on(
                        'data',
                        (data) => {

                            const text =
                                data.toString().trim();

                            if (text) {

                                console.error(
                                    `[Harness] ${text}`
                                );
                            }
                        }
                    );
                }


                /* -----------------------------------------
                 * 进程错误
                 * ----------------------------------------- */

                child.on(
                    'error',
                    (error) => {

                        console.error(
                            '[HARNESS] 进程错误：',
                            error
                        );
                    }
                );


                /* -----------------------------------------
                 * 进程退出
                 * ----------------------------------------- */

                child.on(
                    'exit',
                    (code, signal) => {

                        console.log(
                            `[HARNESS] Manager 进程退出：code=${code}, signal=${signal}`
                        );

                        /**
                         * 记录退出时是否仍在启动流程中。
                         * 启动期间的崩溃交给 startHarness
                         * 的失败路径处理，不触发自动恢复。
                         */
                        const wasStarting =
                            isStarting;

                        if (
                            harnessProcess === child
                        ) {
                            harnessProcess = null;
                        }

                        isStarting = false;

                        if (
                            !wasStarting &&
                            !isStopping &&
                            !isQuitting
                        ) {

                            startedByUs = false;

                            console.warn(
                                '[HARNESS] Harness 非预期退出，准备自动恢复'
                            );

                            scheduleAutoRestart();

                        } else {

                            updateTray();
                        }
                    }
                );


                /* -----------------------------------------
                 * 等待 Web UI
                 *
                 * 同时监听进程退出：
                 * 启动期间崩溃则立刻判定失败，
                 * 不用等满 60 秒。
                 * ----------------------------------------- */

                const exitedEarly =
                    new Promise((resolve) => {
                        child.once(
                            'exit',
                            () => {
                                resolve(true);
                            }
                        );
                    });

                const success =
                    await Promise.race([
                        waitForHarness(),
                        exitedEarly.then(
                            () => false
                        )
                    ]);


                if (!success) {

                    console.error(
                        '[HARNESS] 启动失败，准备清理进程'
                    );

                    if (
                        harnessProcess &&
                        harnessProcess.pid
                    ) {

                        await killProcessTree(
                            harnessProcess.pid
                        );
                    }

                    harnessProcess = null;

                    startedByUs = false;

                    throw new Error(
                        `无法连接 Harness：${HARNESS_URL}`
                    );
                }


                /**
                 * 二次确认身份：
                 * 防止等待期间 3080 被其他程序抢占。
                 */
                const finalIdentity =
                    await identifyService();

                if (finalIdentity !== 'dsh') {

                    console.error(
                        '[HARNESS] 无法确认 Harness 身份，准备清理进程'
                    );

                    if (
                        harnessProcess &&
                        harnessProcess.pid
                    ) {

                        await killProcessTree(
                            harnessProcess.pid
                        );
                    }

                    harnessProcess = null;

                    startedByUs = false;

                    throw new Error(
                        `无法确认 Harness 身份：${HARNESS_URL}`
                    );
                }


                restartAttempts = 0;

                console.log(
                    '[HARNESS] 启动成功'
                );

                updateTray();

                return true;

            } finally {

                isStarting = false;
                startPromise = null;
            }
        })();

    return startPromise;
}


/* =========================================================
 * 停止 Harness
 * ========================================================= */

function stopHarness() {

    if (stopPromise) {

        console.log(
            '[HARNESS] 已经存在停止任务'
        );

        return stopPromise;
    }

    stopPromise =
        (async () => {

            try {

                clearRestartTimer();

                if (isStopping) {
                    return true;
                }


                /**
                 * 没有由 Desktop Manager 启动的 Harness。
                 *
                 * 不杀其他程序启动的 Harness。
                 */
                if (
                    !harnessProcess ||
                    !harnessProcess.pid
                ) {

                    console.log(
                        '[HARNESS] 当前没有由 Desktop Manager 管理的 Harness'
                    );

                    return false;
                }


                isStopping = true;


                console.log(
                    '正在停止 DeepSeek Harness...'
                );


                const child =
                    harnessProcess;

                const pid =
                    child.pid;


                /**
                 * 先清空引用。
                 */
                harnessProcess = null;


                await killProcessTree(pid);


                /**
                 * 等待 3080 真正释放。
                 */
                const stopped =
                    await waitForHarnessStopped();


                if (stopped) {

                    console.log(
                        '[HARNESS] 3080 已释放'
                    );

                } else {

                    console.warn(
                        '[HARNESS] 等待 3080 释放超时'
                    );
                }


                startedByUs = false;

                updateTray();

                return stopped;

            } finally {

                isStopping = false;
                stopPromise = null;
            }
        })();

    return stopPromise;
}


/* =========================================================
 * 重启 Harness
 * ========================================================= */

async function restartHarness() {

    console.log(
        '正在重启 DeepSeek Harness...'
    );

    await stopHarness();

    /**
     * 给 Windows 一点时间释放端口。
     */
    await sleep(500);

    return startHarness();
}


/* =========================================================
 * 崩溃自动恢复
 * ========================================================= */

function clearRestartTimer() {

    if (restartTimer) {

        clearTimeout(restartTimer);
        restartTimer = null;
    }
}


/**
 * 安排下一次自动恢复（退避重试）。
 */
function scheduleAutoRestart() {

    clearRestartTimer();

    if (isStopping || isQuitting) {

        updateTray();
        return;
    }

    restartAttempts += 1;

    if (restartAttempts > MAX_RESTART_ATTEMPTS) {

        restartAttempts =
            MAX_RESTART_ATTEMPTS;

        console.error(
            '[HARNESS] 自动恢复次数已达上限'
        );

        updateTray();

        notifyRestartFailed();

        return;
    }

    const delay =
        RESTART_BASE_DELAY_MS * restartAttempts;

    console.log(
        `[HARNESS] ${delay / 1000} 秒后进行第 ${restartAttempts} 次自动恢复`
    );

    restartTimer = setTimeout(
        async () => {

            restartTimer = null;

            if (isStopping || isQuitting) {
                return;
            }

            try {

                await startHarness();

                restartAttempts = 0;

                console.log(
                    '[HARNESS] 自动恢复成功'
                );

                if (
                    mainWindow &&
                    !mainWindow.isDestroyed()
                ) {

                    mainWindow.loadURL(
                        HARNESS_URL
                    );
                }

            } catch (error) {

                console.error(
                    '[HARNESS] 自动恢复失败：',
                    error.message
                );

                updateTray();

                scheduleAutoRestart();
            }
        },
        delay
    );
}


/**
 * 自动恢复失败后提示用户。
 */
function notifyRestartFailed() {

    if (isStopping || isQuitting) {
        return;
    }

    dialog.showMessageBox(
        {
            type: 'error',
            title: 'DeepSeek Harness',
            message: 'Harness 服务多次启动失败',
            detail:
                '本地服务在自动恢复 3 次后仍无法连接。\n\n' +
                '点击"重试"可再试一次，点击"退出"将关闭程序。',
            buttons: [
                '重试',
                '退出'
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true
        }
    ).then(
        ({ response }) => {

            if (response === 0) {

                restartAttempts = 0;
                scheduleAutoRestart();

            } else {

                app.quit();
            }
        }
    ).catch(
        () => {
            // 弹窗失败（例如正在退出），忽略
        }
    );
}


/* =========================================================
 * 内置鲸鱼娘皮肤：首次启动自动部署
 * ========================================================= */

const SKIN_BUNDLE_NAME =
    '@dsh-external/dsh-client-ui-skin-maid-atelier';

const SKIN_BUNDLE_DIR = path.join(
    HARNESS_DIR,
    'node_modules',
    SKIN_BUNDLE_NAME
);

/**
 * 安装包内置了鲸鱼娘皮肤（resources\harness\node_modules 下）。
 * 首次启动（或用户从未改过默认配置）时，自动把它注册进
 * 用户的 dsh 配置（~/.dsh/profiles/web），无需安装 pnpm。
 */
function ensureSkinProfile() {

    if (!fs.existsSync(SKIN_BUNDLE_DIR)) {

        console.log(
            '[SKIN] 运行时未包含皮肤包，跳过'
        );

        return;
    }

    const profileDir = path.join(
        os.homedir(),
        '.dsh',
        'profiles',
        'web'
    );

    const manifestPath = path.join(
        profileDir,
        'package.json'
    );

    const DEFAULT_BUNDLES = [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app'
    ];

    let manifest;

    if (fs.existsSync(manifestPath)) {

        try {

            manifest = JSON.parse(
                fs.readFileSync(manifestPath, 'utf8')
            );

        } catch {

            console.warn(
                '[SKIN] 无法读取 profile 配置，跳过皮肤部署'
            );

            return;
        }

        const bundles =
            manifest.dsh?.profile?.bundles;

        if (!Array.isArray(bundles)) {
            return;
        }

        if (bundles.includes(SKIN_BUNDLE_NAME)) {

            // 已经启用，无需处理
            return;
        }

        /**
         * 仅当用户从未改动默认配置时才自动补上皮肤，
         * 尊重用户的自定义配置。
         */
        const isDefault =
            bundles.length === DEFAULT_BUNDLES.length &&
            DEFAULT_BUNDLES.every(
                (name) => bundles.includes(name)
            );

        if (!isDefault) {

            console.log(
                '[SKIN] 用户自定义了配置，不自动修改'
            );

            return;
        }

        bundles.push(SKIN_BUNDLE_NAME);

    } else {

        fs.mkdirSync(
            profileDir,
            {
                recursive: true
            }
        );

        manifest = {
            name: 'dsh-profile-web',
            private: true,
            dependencies: {},
            dsh: {
                profile: {
                    bundles: [
                        ...DEFAULT_BUNDLES,
                        SKIN_BUNDLE_NAME
                    ]
                }
            }
        };

        /**
         * 补全 profile 模板文件，与 dsh 默认初始化一致。
         */
        fs.writeFileSync(
            path.join(profileDir, 'cordis.patch.yml'),
            [
                '# Your patch layer for this dsh profile, applied after every bundle layer:',
                '# a top-level YAML array of loader patch entries.',
                '[]',
                ''
            ].join('\n')
        );

        fs.writeFileSync(
            path.join(profileDir, 'cordis.yml'),
            [
                '# dsh profile root — an empty entry list.',
                '[]',
                ''
            ].join('\n')
        );

        fs.writeFileSync(
            path.join(profileDir, 'pnpm-workspace.yaml'),
            [
                'packages:',
                '  - .',
                '',
                'nodeLinker: hoisted',
                'autoInstallPeers: false',
                ''
            ].join('\n')
        );
    }

    fs.writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2)
    );

    console.log(
        '[SKIN] 已启用内置鲸鱼娘皮肤（深海女仆工坊）'
    );
}


/* =========================================================
 * 打开 Harness
 * ========================================================= */

async function openHarness() {

    const running =
        await checkHarness();

    if (!running) {

        console.log(
            '[HARNESS] 当前没有运行'
        );

        return false;
    }


    if (mainWindow) {

        console.log(
            '[WINDOW] 已存在窗口，显示窗口'
        );

        if (
            mainWindow.isMinimized()
        ) {
            mainWindow.restore();
        }

        mainWindow.show();
        mainWindow.focus();

        return true;
    }


    console.log(
        '[WINDOW] 创建新的 Harness 窗口'
    );

    createWindow();

    mainWindow.loadURL(
        HARNESS_URL
    );

    return true;
}


/* =========================================================
 * 托盘菜单
 * ========================================================= */

async function updateTray() {

    if (!tray) {
        return;
    }

    const running =
        await checkHarness();

    const statusText =
        running
            ? '当前状态：🟢 运行中'
            : '当前状态：⚪ 已停止';


    const contextMenu =
        Menu.buildFromTemplate([
            {
                label: '打开 Harness',
                enabled: running,
                click: () => {
                    openHarness();
                }
            },

            {
                label: '显示管理窗口',
                click: () => {

                    if (mainWindow) {

                        if (
                            mainWindow.isMinimized()
                        ) {
                            mainWindow.restore();
                        }

                        mainWindow.show();
                        mainWindow.focus();

                    } else {

                        if (running) {
                            createWindow();
                        }
                    }
                }
            },

            {
                type: 'separator'
            },

            {
                label: '启动 Harness',

                enabled:
                    !running &&
                    !isStarting &&
                    !isStopping,

                click: async () => {

                    try {

                        await startHarness();
                        await openHarness();

                    } catch (error) {

                        console.error(
                            '[TRAY] 启动失败：',
                            error
                        );

                        dialog.showErrorBox(
                            'DeepSeek Harness',
                            error.message
                        );
                    }
                }
            },

            {
                label: '停止 Harness',

                enabled:
                    running &&
                    !!harnessProcess &&
                    !isStopping,

                click: async () => {
                    await stopHarness();
                }
            },

            {
                label: '重启 Harness',

                enabled:
                    !isStarting &&
                    !isStopping,

                click: async () => {

                    try {

                        await restartHarness();
                        await openHarness();

                    } catch (error) {

                        console.error(
                            '[TRAY] 重启失败：',
                            error
                        );

                        dialog.showErrorBox(
                            'DeepSeek Harness',
                            error.message
                        );
                    }
                }
            },

            {
                type: 'separator'
            },

            {
                label: statusText,
                enabled: false
            },

            {
                type: 'separator'
            },

            {
                label: '退出 DeepSeek Harness',

                click: () => {

                    console.log(
                        '[TRAY] 用户点击退出'
                    );

                    app.quit();
                }
            }
        ]);


    tray.setContextMenu(
        contextMenu
    );
}


/* =========================================================
 * 创建托盘
 * ========================================================= */

function createTray() {

    if (tray) {
        return;
    }


    const trayIconPath =
        path.join(
            __dirname,
            'tray.png'
        );


    let icon =
        nativeImage.createFromPath(
            trayIconPath
        );


    if (icon.isEmpty()) {

        console.warn(
            '[TRAY] 找不到 tray.png，托盘功能不可用'
        );

        return;
    }


    tray =
        new Tray(icon);


    tray.setToolTip(
        'DeepSeek Harness'
    );


    tray.on(
        'double-click',
        () => {
            openHarness();
        }
    );


    updateTray();
}


/* =========================================================
 * 创建 BrowserWindow
 * ========================================================= */

function createWindow() {

    if (mainWindow) {

        console.log(
            '[WINDOW] 已经存在 BrowserWindow'
        );

        mainWindow.show();
        mainWindow.focus();

        return;
    }


    console.log(
        '[WINDOW] 开始创建 BrowserWindow'
    );


    mainWindow =
        new BrowserWindow({

            width: 1440,

            height: 900,

            minWidth: 1000,

            minHeight: 700,

            title:
                `DeepSeek Harness Desktop v${app.getVersion()}`,

            backgroundColor: '#f5f7fa',

            webPreferences: {

                preload:
                    path.join(
                        __dirname,
                        'preload.js'
                    ),

                contextIsolation: true,

                nodeIntegration: false,

                additionalArguments: [
                    `--harness-desktop-version=${app.getVersion()}`
                ]
            },

            autoHideMenuBar: true,

            /**
             * 先不显示。
             * ready-to-show 后显示。
             */
            show: false
        });


    console.log(
        '[WINDOW] BrowserWindow 创建完成'
    );


    /**
     * 固定窗口标题：
     * 阻止 Harness 页面改写窗口标题，
     * 始终显示 DeepSeek Harness Desktop v<版本号>。
     */
    mainWindow.on(
        'page-title-updated',
        (event) => {
            event.preventDefault();
        }
    );


    /* =====================================================
     * ready-to-show
     * ===================================================== */

    mainWindow.once(
        'ready-to-show',
        () => {

            console.log(
                '[WINDOW] ready-to-show'
            );


            if (!mainWindow) {
                return;
            }


            mainWindow.show();
            mainWindow.focus();


            console.log(
                '[WINDOW] show() 已执行'
            );
        }
    );


    /* =====================================================
     * 页面加载
     * ===================================================== */

    mainWindow.webContents.on(
        'did-start-loading',
        () => {
            console.log(
                '[WINDOW] did-start-loading'
            );
        }
    );


    mainWindow.webContents.on(
        'did-finish-load',
        () => {
            console.log(
                '[WINDOW] did-finish-load'
            );
        }
    );


    mainWindow.webContents.on(
        'did-stop-loading',
        () => {
            console.log(
                '[WINDOW] did-stop-loading'
            );
        }
    );


    /* =====================================================
     * 页面加载失败
     * ===================================================== */

    mainWindow.webContents.on(
        'did-fail-load',
        (
            event,
            errorCode,
            errorDescription,
            validatedURL
        ) => {

            console.error(
                '[WINDOW] did-fail-load',
                {
                    errorCode,
                    errorDescription,
                    validatedURL
                }
            );
        }
    );


    /* =====================================================
     * Renderer 崩溃
     * ===================================================== */

    mainWindow.webContents.on(
        'render-process-gone',
        (
            event,
            details
        ) => {

            console.error(
                '[WINDOW] Renderer 进程异常结束：',
                details
            );
        }
    );


    /* =====================================================
     * 页面导航
     * ===================================================== */

    mainWindow.webContents.on(
        'will-navigate',
        (
            event,
            url
        ) => {

            console.log(
                '[WINDOW] will-navigate:',
                url
            );

            if (
                !url.startsWith(HARNESS_URL)
            ) {

                event.preventDefault();

                openExternalSafe(url);
            }
        }
    );


    /* =====================================================
     * 页面重定向
     * ===================================================== */

    mainWindow.webContents.on(
        'will-redirect',
        (
            event,
            url
        ) => {

            if (
                !url.startsWith(HARNESS_URL)
            ) {

                event.preventDefault();

                openExternalSafe(url);
            }
        }
    );


    /* =====================================================
     * 新窗口处理
     * ===================================================== */

    mainWindow.webContents.setWindowOpenHandler(
        ({ url }) => {

            console.log(
                '[WINDOW] 请求打开新窗口：',
                url
            );


            /**
             * Harness 自己的地址允许。
             */
            if (
                url.startsWith(HARNESS_URL)
            ) {

                return {
                    action: 'allow'
                };
            }


            /**
             * 其他地址交给系统浏览器。
             */
            openExternalSafe(url);

            return {
                action: 'deny'
            };
        }
    );


    /* =====================================================
     * 先加载本地启动页（主题背景）
     * ===================================================== */

    mainWindow.loadFile(
        path.join(
            __dirname,
            'index.html'
        )
    );


    /* =====================================================
     * close
     *
     * 点击 X：
     * 隐藏到托盘，不退出。
     * ===================================================== */

    mainWindow.on(
        'close',
        (event) => {

            console.log('');
            console.log(
                '========== WINDOW CLOSE =========='
            );


            console.log(
                '[WINDOW] close 事件触发'
            );


            console.log(
                '[WINDOW] isQuitting =',
                isQuitting
            );


            if (!isQuitting) {

                if (!tray) {

                    console.warn(
                        '[WINDOW] 托盘不可用，关闭窗口将退出程序'
                    );

                    app.quit();

                    return;
                }

                console.log(
                    '[WINDOW] 阻止关闭，改为隐藏窗口'
                );


                event.preventDefault();

                mainWindow.hide();


                console.log(
                    '[WINDOW] 窗口已隐藏到系统托盘'
                );


                console.log(
                    '================================='
                );


                return;
            }


            console.log(
                '[WINDOW] Electron 正在真正退出'
            );


            console.log(
                '================================='
            );
        }
    );


    /* =====================================================
     * closed
     * ===================================================== */

    mainWindow.on(
        'closed',
        () => {

            console.log(
                '[WINDOW] BrowserWindow closed'
            );

            mainWindow = null;
        }
    );
}


/* =========================================================
 * Electron 完整退出
 * ========================================================= */

async function shutdown() {

    console.log('');
    console.log(
        '======================================'
    );
    console.log(
        '[APP] 开始退出流程'
    );
    console.log(
        '======================================'
    );


    try {

        clearRestartTimer();

        /**
         * 只有我们自己启动的 Harness 才停止。
         */
        if (
            startedByUs &&
            harnessProcess &&
            harnessProcess.pid
        ) {

            await stopHarness();

        } else {

            console.log(
                '[APP] Harness 不是由本程序启动，不停止它'
            );
        }

    } catch (error) {

        console.error(
            '[APP] 停止 Harness 时发生错误：',
            error
        );

    } finally {

        if (tray) {

            tray.destroy();
            tray = null;
        }


        console.log(
            '[APP] Electron 退出'
        );


        app.exit(0);
    }
}


/* =========================================================
 * Bootstrap
 * ========================================================= */

async function bootstrap() {

    console.log('');
    console.log(
        '======================================'
    );
    console.log(
        '   DeepSeek Harness Desktop Manager'
    );
    console.log(
        '======================================'
    );
    console.log('');


    /* -----------------------------------------
     * 创建托盘
     * ----------------------------------------- */

    createTray();


    /* -----------------------------------------
     * 检查 Harness
     * ----------------------------------------- */

    console.log(
        '[APP] 检查 DeepSeek Harness...'
    );


    /**
     * 先打开窗口显示本地启动页（主题背景），
     * 服务就绪后再切换到 Harness UI。
     */
    createWindow();


    /**
     * 首次启动自动部署内置鲸鱼娘皮肤。
     */
    ensureSkinProfile();


    const running =
        await startHarness();


    /* -----------------------------------------
     * 启动失败
     * ----------------------------------------- */

    if (!running) {

        dialog.showErrorBox(
            'DeepSeek Harness 启动失败',
            [
                '无法连接到：',
                '',
                HARNESS_URL,
                '',
                '请检查内置 Node.js、DSH 文件或 Harness 是否可以正常启动。'
            ].join('\n')
        );


        app.quit();

        return;
    }


    /* -----------------------------------------
     * 打开 Harness
     * ----------------------------------------- */

    console.log(
        '地址：' + HARNESS_URL
    );


    console.log(
        '正在打开 DeepSeek Harness...'
    );


    if (
        mainWindow &&
        !mainWindow.isDestroyed()
    ) {

        mainWindow.loadURL(
            HARNESS_URL
        );
    }
}


/* =========================================================
 * 单实例锁
 * ========================================================= */

const gotSingleInstanceLock =
    app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {

    console.log(
        '[APP] 已有实例在运行，本实例退出'
    );

    app.whenReady().then(
        async () => {

            try {

                await dialog.showMessageBox({
                    type: 'info',
                    title: 'DeepSeek Harness',
                    message: 'DeepSeek Harness 已经在运行',
                    detail:
                        '已为您打开正在运行的应用窗口。\n\n' +
                        '如需退出程序，请使用系统托盘图标中的"退出"。',
                    buttons: [
                        '确定'
                    ],
                    defaultId: 0,
                    noLink: true
                });

            } catch {
                // 弹窗失败也继续退出
            }

            app.quit();
        }
    );

} else {

    app.on(
        'second-instance',
        () => {

            console.log(
                '[APP] 收到第二次启动请求，聚焦已有窗口'
            );

            openHarness();
        }
    );


    /* =========================================================
     * Electron 初始化
     * ========================================================= */

    app.whenReady().then(
    async () => {

        try {

            /**
             * 权限请求白名单。
             *
             * 只放行 Harness UI 明确需要的低风险权限，
             * 其余（麦克风、摄像头、定位等）一律拒绝。
             */
            const allowedPermissions =
                new Set([
                    'clipboard-read',
                    'clipboard-sanitized-write',
                    'fullscreen',
                    'notifications'
                ]);

            session.defaultSession.setPermissionRequestHandler(
                (webContents, permission, callback) => {

                    callback(
                        allowedPermissions.has(permission)
                    );
                }
            );

            session.defaultSession.setPermissionCheckHandler(
                (webContents, permission) => {

                    return allowedPermissions.has(permission);
                }
            );


            await bootstrap();


            /**
             * macOS / Electron activate。
             */
            app.on(
                'activate',
                () => {

                    if (
                        BrowserWindow.getAllWindows().length === 0
                    ) {

                        openHarness();
                    }
                }
            );

        } catch (error) {

            console.error(
                '[APP] Bootstrap 失败：',
                error
            );


            dialog.showErrorBox(
                'DeepSeek Harness',
                error.message
            );


            app.quit();
        }
    }
);


/* =========================================================
 * before-quit
 * ========================================================= */

app.on(
    'before-quit',
    (event) => {

        console.log('');
        console.log(
            '[APP] before-quit'
        );

        console.log(
            '[APP] isQuitting =',
            isQuitting
        );

        console.log(
            '[APP] startedByUs =',
            startedByUs
        );

        console.log(
            '[APP] harness PID =',
            harnessProcess?.pid || null
        );


        /**
         * 如果已经进入退出流程，
         * 继续阻止 Electron 自行退出，
         * 直到 shutdown() 完成并调用 app.exit()。
         */
        if (isQuitting) {

            event.preventDefault();

            return;
        }


        /**
         * 第一次退出：
         * 阻止 Electron 立即退出。
         */
        event.preventDefault();


        isQuitting = true;


        shutdown();
    }
);


/* =========================================================
 * window-all-closed
 * ========================================================= */

app.on(
    'window-all-closed',
    () => {

        /**
         * Windows 托盘模式。
         *
         * 窗口全部关闭并不退出程序。
         */
        console.log(
            '[APP] window-all-closed → 保持托盘运行'
        );
    }
);
}