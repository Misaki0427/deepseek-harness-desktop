'use strict';

// 回滚测试：升级到不存在的版本 → 失败 → 自动回滚
const Module = require('module');
const origLoad = Module._load;

Module._load = function (request) {
    if (request === 'electron') {
        return { dialog: { showMessageBox: async () => ({ response: 0 }) } };
    }
    return origLoad.apply(this, arguments);
};

const harnessDir = process.argv[2];
const hu = require('./harness-update.js');

hu.initHarnessUpdate({
    harnessDir,
    restartHarness: async () => {},
    getTray: () => null
});

const t = hu._internals;

(async () => {
    const before = t.getLocalVersion();
    console.log('回滚测试前版本:', before);

    let failed = false;
    try {
        await t.performUpdate(before, '0.1.0-rc.999');
    } catch (error) {
        failed = true;
        console.log('升级按预期失败:', error.message.slice(0, 120));
    }

    const after = t.getLocalVersion();
    console.log('回滚测试后版本:', after);

    const ok = failed && after === before;
    console.log(ok ? '回滚测试 通过 ✓' : '回滚测试 失败 ✗');
    process.exitCode = ok ? 0 : 1;
})();
