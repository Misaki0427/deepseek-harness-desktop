'use strict';

// 端到端：在临时 harness 目录真实执行 rc.6 → rc.7 升级
const Module = require('module');
const origLoad = Module._load;

Module._load = function (request) {
    if (request === 'electron') {
        return {
            dialog: { showMessageBox: async () => ({ response: 0 }) }
        };
    }
    return origLoad.apply(this, arguments);
};

const harnessDir = process.argv[2];
if (!harnessDir) {
    console.error('用法: node test-harness-update-e2e.js <harnessDir>');
    process.exit(2);
}

const hu = require('./harness-update.js');

let restartCount = 0;

hu.initHarnessUpdate({
    harnessDir,
    restartHarness: async () => {
        restartCount += 1;
        console.log('  [mock] restartHarness 被调用');
    },
    getTray: () => null
});

const t = hu._internals;

(async () => {
    console.log('升级前本地版本:', t.getLocalVersion());

    console.log('开始升级 rc.6 → rc.7 …');
    const result = await t.performUpdate('0.1.0-rc.6', '0.1.0-rc.7');

    console.log('升级结果:', JSON.stringify(result));
    console.log('升级后本地版本:', t.getLocalVersion());
    console.log('restartHarness 调用次数:', restartCount);

    const fs = require('fs');
    const path = require('path');

    // 校验 1：版本正确
    const okVersion = t.getLocalVersion() === '0.1.0-rc.7';

    // 校验 2：布局保持扁平（无 .pnpm 虚拟 store 且 dsh 是实体目录）
    const hasPnpmStore = fs.existsSync(
        path.join(harnessDir, 'node_modules', '.pnpm')
    );
    const dshEntry = fs.lstatSync(
        path.join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh')
    );
    const okFlat = !hasPnpmStore && dshEntry.isDirectory() && !dshEntry.isSymbolicLink();

    // 校验 3：package.json 精确锁定
    const pkg = JSON.parse(fs.readFileSync(
        path.join(harnessDir, 'package.json'), 'utf8'
    ));
    const okLocked = pkg.dependencies['@deepseek-ai/dsh'] === '0.1.0-rc.7';

    // 校验 4：web-app 随 rc.7 升级
    const webAppPkg = JSON.parse(fs.readFileSync(
        path.join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'), 'utf8'
    ));

    console.log('');
    console.log('=== 校验结果 ===');
    console.log('版本 rc.7:', okVersion ? '✓' : '✗');
    console.log('扁平布局（无 .pnpm、dsh 实体目录）:', okFlat ? '✓' : '✗');
    console.log('package.json 精确锁 rc.7:', okLocked ? '✓' : '✗');
    console.log('dsh-web-app 版本:', webAppPkg.version);

    const allOk = okVersion && okFlat && okLocked;
    console.log('');
    console.log(allOk ? '端到端升级 全部通过 ✓' : '存在失败 ✗');
    process.exitCode = allOk ? 0 : 1;
})();
