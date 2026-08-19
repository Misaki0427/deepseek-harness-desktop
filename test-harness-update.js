'use strict';

const Module = require('module');
const origLoad = Module._load;

Module._load = function (request) {
    if (request === 'electron') {
        return {
            dialog: {
                showMessageBox: async (opts) => ({ response: 0 })
            }
        };
    }
    return origLoad.apply(this, arguments);
};

const hu = require('./harness-update.js');

const t = hu._internals;
let failures = 0;

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '  实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected)));
    if (!ok) failures += 1;
}

console.log('== 版本比较 ==');
check('rc.7 > rc.6', t.compareVersions('0.1.0-rc.7', '0.1.0-rc.6'), 1);
check('rc.6 < rc.7', t.compareVersions('0.1.0-rc.6', '0.1.0-rc.7'), -1);
check('相等', t.compareVersions('0.1.0-rc.7', '0.1.0-rc.7'), 0);
check('rc.10 > rc.9（数字比较非字符串）', t.compareVersions('0.1.0-rc.10', '0.1.0-rc.9'), 1);
check('patch 升级', t.compareVersions('0.1.1', '0.1.0'), 1);
check('minor 升级', t.compareVersions('0.2.0-rc.1', '0.1.9-rc.9'), 1);
check('正式版 > rc', t.compareVersions('0.1.0', '0.1.0-rc.99'), 1);
check('非法版本返回 0', t.compareVersions('abc', '0.1.0-rc.7'), 0);

console.log('');
console.log('== 真实 registry 查询 ==');
(async () => {
    const remote = await t.getRemoteVersion();
    console.log('远程最新 @deepseek-ai/dsh =', remote);
    check('能查到版本', typeof remote === 'string' && remote.length > 0, true);

    console.log('');
    if (failures === 0) console.log('全部通过 ✓');
    else { console.log(failures + ' 项失败 ✗'); process.exitCode = 1; }
})();
