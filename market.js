'use strict';

/* =========================================================
 * 插件市场模块（主进程）
 *
 * - 市场数据：market/plugins.json（内置）+ 多源在线更新
 * - 已装状态：读 web profile 的 package.json + node_modules
 * - 安装/卸载/更新：内置 dsh-service.exe 执行内置 pnpm.cjs
 *   （用户机器无需安装 node/pnpm）
 * - 启用/禁用：读写 dsh.profile.bundles（无 BOM UTF-8）
 * - 每次操作前备份 profile，失败自动回滚
 * ========================================================= */

const {
    app,
    BrowserWindow,
    ipcMain,
    shell
} = require('electron');

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    spawn
} = require('child_process');

const IPC = {
    GET_STATE: 'market:get-state',
    INSTALL: 'market:install',
    UNINSTALL: 'market:uninstall',
    UPDATE: 'market:update',
    SET_ENABLED: 'market:set-enabled',
    OPEN_HOMEPAGE: 'market:open-homepage',
    PROGRESS: 'market:progress'
};

/**
 * npm 包名白名单（杜绝命令注入）
 */
const PACKAGE_NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?$/;

/**
 * 在线市场数据源（按顺序尝试，全部失败用缓存/内置）
 */
const REMOTE_SOURCES = [
    'https://cdn.jsdelivr.net/gh/Misaki0427/deepseek-harness-desktop@main/market/plugins.json',
    'https://raw.githubusercontent.com/Misaki0427/deepseek-harness-desktop/main/market/plugins.json'
];

/**
 * dsh-img 兼容补丁（卸载重装后自动恢复）
 * 补丁内容与 2.1.4 手工修复保持一致。
 */
const DSH_IMG_EXPORTS = {
    '.': './index.js',
    './client': './client.js',
    './package.json': './package.json'
};
const DSH_IMG_CLIENT_SHIM = 'export default {};\n';

/**
 * 主进程注入的上下文
 */
let ctx = null;

/**
 * 市场窗口（单例）
 */
let marketWindow = null;

/**
 * 操作串行化队列（同一时刻只跑一个 pnpm）
 */
let operationQueue = Promise.resolve();

/**
 * 会话内市场数据缓存
 */
let cachedMarket = null;
let marketOnline = false;

/* =========================================================
 * 基础工具
 * ========================================================= */

function getProfileDir() {

    return path.join(
        os.homedir(),
        '.dsh',
        'profiles',
        'web'
    );
}

function getProfileJsonPath() {

    return path.join(
        getProfileDir(),
        'package.json'
    );
}

function getNodeExe() {

    return path.join(
        ctx.harnessDir,
        'dsh-service.exe'
    );
}

function getPnpmCjs() {

    return path.join(
        ctx.harnessDir,
        'node_modules',
        'pnpm',
        'bin',
        'pnpm.cjs'
    );
}

function readProfileManifest() {

    try {

        if (!fs.existsSync(getProfileJsonPath())) {
            return null;
        }

        return JSON.parse(
            fs.readFileSync(
                getProfileJsonPath(),
                'utf8'
            )
        );

    } catch {
        return null;
    }
}

/**
 * 无 BOM UTF-8 写入（dsh 对 BOM 敏感）
 */
function writeJsonNoBom(filePath, obj) {

    fs.writeFileSync(
        filePath,
        JSON.stringify(obj, null, 2),
        'utf8'
    );
}

/**
 * 解析依赖的真实安装目录（pnpm symlink）
 */
function resolveInstalledDir(packageName) {

    const parts = packageName.split('/');
    const p = path.join(
        getProfileDir(),
        'node_modules',
        ...parts
    );

    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}

/**
 * 依赖是否声明了 dsh.bundle.patch（即是否 profile 插件层）
 */
function isBundlePackage(packageName) {

    try {

        const manifest = JSON.parse(
            fs.readFileSync(
                path.join(
                    resolveInstalledDir(packageName),
                    'package.json'
                ),
                'utf8'
            )
        );

        return manifest.dsh?.bundle?.patch !== undefined;

    } catch {
        return false;
    }
}

/**
 * 对照官方 dsh plugin 的 reconcile 逻辑：
 * 声明 dsh.bundle 的依赖自动加入 bundles；
 * 卸载/失去声明的自动移出；内置（非依赖）bundle 永不触碰。
 */
function reconcileBundles(beforeManifest) {

    const after = readProfileManifest();

    if (!after) {
        return after;
    }

    const beforeDeps = new Set(
        Object.keys(
            beforeManifest?.dependencies ?? {}
        )
    );

    const dependencies = Object.keys(
        after.dependencies ?? {}
    );

    const plugins = (
        after.dsh?.profile?.bundles ?? []
    ).slice();

    let changed = false;

    for (const name of dependencies) {

        if (
            isBundlePackage(name) &&
            !plugins.includes(name)
        ) {

            plugins.push(name);
            changed = true;
        }
    }

    const dependencySet = new Set(dependencies);

    for (let i = plugins.length - 1; i >= 0; i--) {

        const name = plugins[i];

        const wasDependency =
            beforeDeps.has(name) ||
            dependencySet.has(name);

        const stillBundle =
            dependencySet.has(name) &&
            isBundlePackage(name);

        if (wasDependency && !stillBundle) {

            plugins.splice(i, 1);
            changed = true;
        }
    }

    if (changed) {

        after.dsh = {
            ...after.dsh,
            profile: {
                ...after.dsh?.profile,
                bundles: plugins
            }
        };

        writeJsonNoBom(
            getProfileJsonPath(),
            after
        );

        console.log(
            '[MARKET] bundles 已同步：',
            plugins.join(', ') || '(空)'
        );
    }

    return after;
}

/**
 * dsh-img 兼容补丁：exports 字段 + client.js shim
 */
function patchDshImgIfNeeded() {

    try {

        const dir = resolveInstalledDir('dsh-img');

        if (!fs.existsSync(
            path.join(dir, 'index.js')
        )) {
            // 未安装
            return false;
        }

        const manifestPath = path.join(
            dir,
            'package.json'
        );

        const manifest = JSON.parse(
            fs.readFileSync(manifestPath, 'utf8')
        );

        let changed = false;

        if (
            !manifest.exports ||
            manifest.exports['./client'] !== './client.js'
        ) {

            manifest.exports = DSH_IMG_EXPORTS;
            changed = true;
        }

        const clientPath = path.join(
            dir,
            'client.js'
        );

        if (!fs.existsSync(clientPath)) {

            fs.writeFileSync(
                clientPath,
                DSH_IMG_CLIENT_SHIM,
                'utf8'
            );

            changed = true;
        }

        if (changed) {

            writeJsonNoBom(
                manifestPath,
                manifest
            );

            console.log(
                '[MARKET] 已为 dsh-img 应用兼容补丁'
            );
        }

        return changed;

    } catch (error) {

        console.error(
            '[MARKET] dsh-img 补丁失败：',
            error.message
        );

        return false;
    }
}

/* =========================================================
 * 备份与回滚
 * ========================================================= */

function backupProfileManifest() {

    const p = getProfileJsonPath();

    if (!fs.existsSync(p)) {
        return null;
    }

    const backupDir = path.join(
        os.homedir(),
        '.dsh',
        '.dsh-profile-backup'
    );

    fs.mkdirSync(
        backupDir,
        {
            recursive: true
        }
    );

    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-');

    const dest = path.join(
        backupDir,
        'package-' + stamp + '.json'
    );

    fs.copyFileSync(p, dest);

    return dest;
}

function restoreBackup(backupPath) {

    if (
        backupPath &&
        fs.existsSync(backupPath)
    ) {

        fs.copyFileSync(
            backupPath,
            getProfileJsonPath()
        );

        console.log(
            '[MARKET] 已回滚 profile 备份：',
            backupPath
        );
    }
}

/* =========================================================
 * pnpm 执行
 * ========================================================= */

function runPnpm(args) {

    return new Promise(
        (resolve, reject) => {

            const nodeExe = getNodeExe();
            const pnpmCjs = getPnpmCjs();
            const profileDir = getProfileDir();

            if (!fs.existsSync(nodeExe)) {

                reject(
                    new Error(
                        '内置运行时缺失（dsh-service.exe），请重新安装本应用'
                    )
                );

                return;
            }

            if (!fs.existsSync(pnpmCjs)) {

                reject(
                    new Error(
                        '内置 pnpm 缺失，请重新安装本应用'
                    )
                );

                return;
            }

            if (!fs.existsSync(getProfileJsonPath())) {

                reject(
                    new Error(
                        'web profile 尚未初始化，请先启动一次 Harness'
                    )
                );

                return;
            }

            let stderrTail = '';

            const child = spawn(
                nodeExe,
                [
                    pnpmCjs,
                    ...args
                ],
                {
                    cwd: profileDir,
                    windowsHide: true,
                    env: {
                        ...process.env,
                        FORCE_COLOR: '0',
                        NO_COLOR: '1',
                        npm_config_loglevel: 'error'
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
                            '[MARKET][pnpm]',
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
                            'pnpm 启动失败：' +
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
                            'pnpm 执行失败' +
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

/* =========================================================
 * 操作串行化
 * ========================================================= */

function enqueue(task) {

    const run = operationQueue.then(
        task,
        task
    );

    operationQueue = run.catch(() => {});

    return run;
}

/* =========================================================
 * 插件操作
 * ========================================================= */

function validatePackageName(packageName) {

    if (
        typeof packageName !== 'string' ||
        !PACKAGE_NAME_RE.test(packageName)
    ) {

        throw new Error(
            '非法包名：' +
            JSON.stringify(packageName)
        );
    }
}

function sendProgress(text) {

    console.log('[MARKET]', text);

    if (
        marketWindow &&
        !marketWindow.isDestroyed()
    ) {

        try {

            marketWindow.webContents.send(
                IPC.PROGRESS,
                {
                    text,
                    at: Date.now()
                }
            );

        } catch {
            // 忽略渲染进程发送失败
        }
    }
}

async function installPlugin(packageName) {

    validatePackageName(packageName);

    const before = readProfileManifest();
    const backup = backupProfileManifest();

    try {

        sendProgress(
            '开始安装 ' + packageName +
            ' …（需要网络，请稍候）'
        );

        await runPnpm([
            'add',
            packageName
        ]);

        reconcileBundles(before);
        patchDshImgIfNeeded();

        sendProgress(
            packageName +
            ' 安装完成，正在重启 Harness…'
        );

        await ctx.restartHarness();

        sendProgress(
            packageName +
            ' 安装完成，Harness 已重启 ✓'
        );

        return {
            ok: true
        };

    } catch (error) {

        restoreBackup(backup);

        console.error(
            '[MARKET] 安装失败：',
            error.message
        );

        throw error;
    }
}

async function uninstallPlugin(packageName) {

    validatePackageName(packageName);

    const before = readProfileManifest();

    if (!before?.dependencies?.[packageName]) {

        throw new Error(
            packageName + ' 不是可卸载的插件'
        );
    }

    const backup = backupProfileManifest();

    try {

        sendProgress(
            '开始卸载 ' + packageName + ' …'
        );

        await runPnpm([
            'remove',
            packageName
        ]);

        reconcileBundles(before);

        sendProgress(
            packageName +
            ' 已卸载，正在重启 Harness…'
        );

        await ctx.restartHarness();

        sendProgress(
            packageName +
            ' 已卸载，Harness 已重启 ✓'
        );

        return {
            ok: true
        };

    } catch (error) {

        restoreBackup(backup);

        console.error(
            '[MARKET] 卸载失败：',
            error.message
        );

        throw error;
    }
}

async function updatePlugin(packageName) {

    validatePackageName(packageName);

    const before = readProfileManifest();

    if (!before?.dependencies?.[packageName]) {

        throw new Error(
            packageName + ' 尚未安装，无法更新'
        );
    }

    const backup = backupProfileManifest();

    try {

        sendProgress(
            '开始更新 ' + packageName +
            ' …（需要网络，请稍候）'
        );

        await runPnpm([
            'update',
            packageName
        ]);

        reconcileBundles(before);
        patchDshImgIfNeeded();

        sendProgress(
            packageName +
            ' 更新完成，正在重启 Harness…'
        );

        await ctx.restartHarness();

        sendProgress(
            packageName +
            ' 更新完成，Harness 已重启 ✓'
        );

        return {
            ok: true
        };

    } catch (error) {

        restoreBackup(backup);

        console.error(
            '[MARKET] 更新失败：',
            error.message
        );

        throw error;
    }
}

async function setPluginEnabled(
    packageName,
    enabled
) {

    validatePackageName(packageName);

    const manifest = readProfileManifest();

    if (!manifest?.dependencies?.[packageName]) {

        throw new Error(
            '该插件不是可管理插件（内置插件不支持启停）'
        );
    }

    if (!isBundlePackage(packageName)) {

        throw new Error(
            '该插件没有声明 dsh.bundle，无法启停'
        );
    }

    const bundles = (
        manifest.dsh?.profile?.bundles ?? []
    ).slice();

    const index = bundles.indexOf(packageName);

    if (enabled && index === -1) {

        bundles.push(packageName);

    } else if (!enabled && index !== -1) {

        bundles.splice(index, 1);

    } else {
        // 状态未变化
        return {
            ok: true,
            unchanged: true
        };
    }

    manifest.dsh = {
        ...manifest.dsh,
        profile: {
            ...manifest.dsh?.profile,
            bundles
        }
    };

    writeJsonNoBom(
        getProfileJsonPath(),
        manifest
    );

    const actionText = enabled ? '启用' : '禁用';

    sendProgress(
        packageName + ' 已' + actionText +
        '，正在重启 Harness…'
    );

    await ctx.restartHarness();

    sendProgress(
        packageName + ' 已' + actionText +
        '，Harness 已重启 ✓'
    );

    return {
        ok: true
    };
}

/* =========================================================
 * 市场数据
 * ========================================================= */

function validateMarketSchema(data) {

    if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray(data.plugins)
    ) {

        throw new Error(
            '市场数据格式错误'
        );
    }

    for (const entry of data.plugins) {

        if (
            !entry ||
            typeof entry.name !== 'string' ||
            !PACKAGE_NAME_RE.test(entry.name)
        ) {

            throw new Error(
                '市场数据包含非法包名'
            );
        }
    }

    return data;
}

function readBuiltinMarket() {

    const p = path.join(
        __dirname,
        'market',
        'plugins.json'
    );

    return validateMarketSchema(
        JSON.parse(
            fs.readFileSync(p, 'utf8')
        )
    );
}

async function fetchRemoteMarket() {

    // 多源并行请求，取最快成功的一个（离线时最多等 5 秒）
    const attempts = REMOTE_SOURCES.map(
        (url) => fetch(
            url,
            {
                signal:
                    AbortSignal.timeout(5000),
                headers: {
                    'User-Agent':
                        'DeepSeek-Harness-Desktop'
                }
            }
        ).then(
            async (res) => {

                if (!res.ok) {

                    throw new Error(
                        'HTTP ' + res.status
                    );
                }

                const text = await res.text();
                const data = validateMarketSchema(
                    JSON.parse(text)
                );

                console.log(
                    '[MARKET] 在线市场数据已更新：',
                    url
                );

                // 写入本地缓存（下次离线可用）
                const cachePath = path.join(
                    ctx.userDataDir,
                    'market-cache.json'
                );

                try {

                    fs.writeFileSync(
                        cachePath,
                        text,
                        'utf8'
                    );

                } catch (error) {

                    console.warn(
                        '[MARKET] 市场缓存写入失败：',
                        error.message
                    );
                }

                return data;
            }
        )
    );

    try {
        return await Promise.any(attempts);
    } catch {
        return null;
    }
}

async function getMarketData() {

    if (cachedMarket) {
        return cachedMarket;
    }

    // 1) 在线（CDN → GitHub raw）
    const remote = await fetchRemoteMarket();

    if (remote) {

        cachedMarket = remote;
        marketOnline = true;

        return remote;
    }

    // 2) 本地缓存（上次在线拉取的）
    const cachePath = path.join(
        ctx.userDataDir,
        'market-cache.json'
    );

    if (fs.existsSync(cachePath)) {

        try {

            cachedMarket = validateMarketSchema(
                JSON.parse(
                    fs.readFileSync(
                        cachePath,
                        'utf8'
                    )
                )
            );

            console.log(
                '[MARKET] 使用本地缓存的市场数据'
            );

            return cachedMarket;

        } catch {
            // 继续回退内置
        }
    }

    // 3) 内置兜底
    try {

        cachedMarket = readBuiltinMarket();

        console.log(
            '[MARKET] 使用内置市场数据（离线兜底）'
        );

    } catch (error) {

        console.error(
            '[MARKET] 内置市场数据不可用：',
            error.message
        );

        cachedMarket = {
            version: 1,
            plugins: []
        };
    }

    return cachedMarket;
}

/* =========================================================
 * 状态汇总
 * ========================================================= */

function getInstalledPlugins() {

    const manifest = readProfileManifest();

    if (!manifest) {
        return [];
    }

    const bundles = new Set(
        manifest.dsh?.profile?.bundles ?? []
    );

    const deps = manifest.dependencies ?? {};

    return Object.keys(deps).map(
        (name) => {

            let version = '?';
            let description = '';
            let isBundle = false;

            try {

                const m = JSON.parse(
                    fs.readFileSync(
                        path.join(
                            resolveInstalledDir(name),
                            'package.json'
                        ),
                        'utf8'
                    )
                );

                version = m.version ?? '?';
                description = m.description ?? '';
                isBundle =
                    m.dsh?.bundle?.patch !== undefined;

            } catch {
                // 保持默认值
            }

            return {
                name,
                version,
                description,
                isBundle,
                enabled: bundles.has(name)
            };
        }
    );
}

async function getMarketState() {

    const market = await getMarketData();
    const installed = getInstalledPlugins();

    return {
        market: {
            version: market.version ?? 1,
            plugins: market.plugins
        },
        installed,
        meta: {
            online: marketOnline,
            busy:
                operationQueue !==
                Promise.resolve(operationQueue)
        }
    };
}

/* =========================================================
 * 市场窗口
 * ========================================================= */

function openMarketWindow() {

    if (
        marketWindow &&
        !marketWindow.isDestroyed()
    ) {

        marketWindow.show();
        marketWindow.focus();

        return;
    }

    marketWindow =
        new BrowserWindow({

            width: 980,
            height: 700,

            minWidth: 800,
            minHeight: 560,

            title:
                '插件市场 · DeepSeek Harness Desktop v' +
                app.getVersion(),

            backgroundColor: '#22306e',

            webPreferences: {

                preload:
                    path.join(
                        __dirname,
                        'preload.js'
                    ),

                contextIsolation: true,

                nodeIntegration: false,

                additionalArguments: [
                    '--harness-desktop-version=' +
                    app.getVersion()
                ]
            },

            autoHideMenuBar: true,

            show: false
        });

    marketWindow.on(
        'page-title-updated',
        (event) => {
            event.preventDefault();
        }
    );

    marketWindow.on(
        'closed',
        () => {
            marketWindow = null;
        }
    );

    marketWindow.loadFile('market.html');

    marketWindow.once(
        'ready-to-show',
        () => {
            marketWindow.show();
        }
    );

    console.log(
        '[MARKET] 插件市场窗口已打开'
    );
}

/* =========================================================
 * 初始化（由 main.js 调用）
 * ========================================================= */

function initMarketModule(options) {

    ctx = options;

    ipcMain.handle(
        IPC.GET_STATE,
        () => getMarketState()
    );

    ipcMain.handle(
        IPC.INSTALL,
        (_event, packageName) =>
            enqueue(
                () => installPlugin(packageName)
            )
    );

    ipcMain.handle(
        IPC.UNINSTALL,
        (_event, packageName) =>
            enqueue(
                () => uninstallPlugin(packageName)
            )
    );

    ipcMain.handle(
        IPC.UPDATE,
        (_event, packageName) =>
            enqueue(
                () => updatePlugin(packageName)
            )
    );

    ipcMain.handle(
        IPC.SET_ENABLED,
        (_event, packageName, enabled) =>
            enqueue(
                () => setPluginEnabled(
                    packageName,
                    !!enabled
                )
            )
    );

    ipcMain.handle(
        IPC.OPEN_HOMEPAGE,
        async (_event, url) => {

            if (
                typeof url !== 'string' ||
                !/^https?:\/\//i.test(url)
            ) {
                return;
            }

            await shell.openExternal(url);
        }
    );

    console.log(
        '[MARKET] 插件市场模块已初始化'
    );
}

module.exports = {
    initMarketModule,
    openMarketWindow,
    IPC,
    /**
     * 仅供自动化测试使用
     */
    _internals: {
        reconcileBundles,
        validatePackageName,
        getInstalledPlugins,
        getMarketState,
        readProfileManifest,
        setPluginEnabled
    }
};
