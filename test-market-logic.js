'use strict';

// ---- 准备隔离环境（不碰真实 ~/.dsh） ----
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'market-test-')
);
process.env.USERPROFILE = tmpRoot;

const profileDir = path.join(
    tmpRoot, '.dsh', 'profiles', 'web'
);
const nodeModules = path.join(profileDir, 'node_modules');

fs.mkdirSync(nodeModules, { recursive: true });

// 模拟两个插件包
function makePackage(pkgDir, manifest) {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
    );
}

// dsh-img：声明 dsh.bundle
makePackage(
    path.join(nodeModules, 'dsh-img'),
    {
        name: 'dsh-img',
        version: '0.4.0',
        description: '图片识别插件',
        dsh: { bundle: { patch: 'bundle.js' } }
    }
);

// some-lib：普通依赖，不声明 bundle
makePackage(
    path.join(nodeModules, 'some-lib'),
    {
        name: 'some-lib',
        version: '1.0.0',
        description: '普通库'
    }
);

// ---- mock electron ----
const Module = require('module');
const origLoad = Module._load;
const ipcHandlers = {};

Module._load = function (request) {
    if (request === 'electron') {
        return {
            app: { getVersion: () => 'test' },
            BrowserWindow: function BrowserWindow() {},
            ipcMain: {
                handle: (channel, fn) => {
                    ipcHandlers[channel] = fn;
                }
            },
            shell: { openExternal: async () => {} }
        };
    }
    return origLoad.apply(this, arguments);
};

const market = require(path.join(__dirname, 'market.js'));

market.initMarketModule({
    harnessDir: 'F:/DeepSeek Harness/harness-runtime',
    restartHarness: async () => {
        console.log('  [mock] restartHarness 被调用');
    },
    userDataDir: path.join(tmpRoot, 'userData')
});

const t = market._internals;
let failures = 0;

function check(label, actual, expected) {
    const ok =
        JSON.stringify(actual) === JSON.stringify(expected);
    console.log(
        (ok ? '  ✓ ' : '  ✗ ') + label +
        (ok ? '' : '  实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected))
    );
    if (!ok) failures += 1;
}

(async () => {
    console.log('== 1. 包名校验 ==');

    check('合法 scoped 名', t.validatePackageName('@dsh-external/x') === undefined, true);
    check('合法简单名', t.validatePackageName('dsh-img') === undefined, true);
    let threw = false;
    try { t.validatePackageName('rm -rf /'); } catch { threw = true; }
    check('注入攻击被拒', threw, true);
    threw = false;
    try { t.validatePackageName(''); } catch { threw = true; }
    check('空名被拒', threw, true);

    console.log('== 2. reconcile：依赖声明 bundle 自动入列 ==');

    fs.writeFileSync(
        path.join(profileDir, 'package.json'),
        JSON.stringify({
            name: 'web',
            dependencies: { 'dsh-img': '^0.4.0', 'some-lib': '^1.0.0' },
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
        }, null, 2),
        'utf8'
    );

    const after = t.reconcileBundles({ dependencies: {} });
    check(
        'dsh-img 入列 + 内置保留 + some-lib 不入列',
        after.dsh.profile.bundles,
        ['@deepseek-ai/dsh-base', 'dsh-img']
    );

    console.log('== 3. 已装状态读取 ==');

    const installed = t.getInstalledPlugins();
    check(
        '识别 dsh-img 为已启用 bundle',
        installed.map((i) => [i.name, i.isBundle, i.enabled]),
        [['dsh-img', true, true], ['some-lib', false, false]]
    );

    console.log('== 4. 启停：禁用 dsh-img ==');

    await t.setPluginEnabled('dsh-img', false);
    const manifest = JSON.parse(
        fs.readFileSync(
            path.join(profileDir, 'package.json'),
            'utf8'
        )
    );
    check(
        '禁用后出列',
        manifest.dsh.profile.bundles,
        ['@deepseek-ai/dsh-base']
    );

    // 文件无 BOM 检查
    const raw = fs.readFileSync(
        path.join(profileDir, 'package.json')
    );
    check(
        '无 BOM',
        raw[0] !== 0xEF,
        true
    );

    console.log('== 5. 启停：重新启用 dsh-img ==');

    await t.setPluginEnabled('dsh-img', true);
    const manifest2 = JSON.parse(
        fs.readFileSync(
            path.join(profileDir, 'package.json'),
            'utf8'
        )
    );
    check(
        '重新启用后入列',
        manifest2.dsh.profile.bundles,
        ['@deepseek-ai/dsh-base', 'dsh-img']
    );

    console.log('== 6. 内置 bundle 不可启停 ==');
    let rejected = false;
    try { await t.setPluginEnabled('@deepseek-ai/dsh-base', false); } catch { rejected = true; }
    check('内置 bundle 被拒', rejected, true);

    console.log('== 7. reconcile：卸载后出列 ==');

    fs.writeFileSync(
        path.join(profileDir, 'package.json'),
        JSON.stringify({
            name: 'web',
            dependencies: { 'some-lib': '^1.0.0' },
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-img'] } }
        }, null, 2),
        'utf8'
    );

    const after2 = t.reconcileBundles({
        dependencies: { 'dsh-img': '^0.4.0' }
    });
    check(
        'dsh-img 出列，内置保留',
        after2.dsh.profile.bundles,
        ['@deepseek-ai/dsh-base']
    );

    console.log('== 8. 市场数据：在线失败回退本地缓存 ==');

    // 写入有效缓存（沙箱内 jsdelivr/GitHub 不可达，在线必失败）
    const userDataDir = path.join(tmpRoot, 'userData');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
        path.join(userDataDir, 'market-cache.json'),
        JSON.stringify({
            version: 1,
            plugins: [
                { name: 'cached-plugin', description: '来自缓存' }
            ]
        }),
        'utf8'
    );

    t.resetMarketCacheForTest();
    const cachedState = await t.getMarketState();
    check(
        '有效缓存不报错且返回条目（在线时用在线数据，离线时用缓存）',
        (
            Array.isArray(cachedState.market.plugins) &&
            cachedState.market.plugins.length >= 1 &&
            cachedState.market.plugins.every(
                (p) => typeof p.name === 'string'
            )
        ),
        true
    );

    console.log('== 9. 市场数据：坏缓存回退内置 ==');

    fs.writeFileSync(
        path.join(userDataDir, 'market-cache.json'),
        '{ 这不是合法 JSON',
        'utf8'
    );

    t.resetMarketCacheForTest();
    const builtinState = await t.getMarketState();
    check(
        '坏缓存被跳过，返回有效市场数据（在线或内置，含 dsh-img）',
        (
            builtinState.market.plugins.length >= 1 &&
            builtinState.market.plugins.some(
                (p) => p.name === 'dsh-img'
            )
        ),
        true
    );

    console.log('');
    if (failures === 0) {
        console.log('全部通过 ✓');
    } else {
        console.log(failures + ' 项失败 ✗');
        process.exitCode = 1;
    }

    // 清理
    fs.rmSync(tmpRoot, { recursive: true, force: true });
})();
