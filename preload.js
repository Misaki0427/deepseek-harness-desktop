const { contextBridge } = require('electron');

/**
 * 版本号由主进程通过 additionalArguments 注入，
 * 始终与 package.json 的 version 保持一致。
 */
const versionArg = process.argv.find(
    (arg) => arg.startsWith('--harness-desktop-version=')
);

const version = versionArg
    ? versionArg.split('=')[1]
    : 'unknown';

contextBridge.exposeInMainWorld('deepseekHarness', {
    version,
    name: 'DeepSeek Harness Desktop'
});
