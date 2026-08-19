const { contextBridge, ipcRenderer } = require('electron');

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

/**
 * 插件市场桥（market.html 使用）
 */
contextBridge.exposeInMainWorld('marketBridge', {
    getState: () => ipcRenderer.invoke('market:get-state'),
    install: (name) => ipcRenderer.invoke('market:install', name),
    uninstall: (name) => ipcRenderer.invoke('market:uninstall', name),
    update: (name) => ipcRenderer.invoke('market:update', name),
    setEnabled: (name, enabled) => ipcRenderer.invoke('market:set-enabled', name, enabled),
    openHomepage: (url) => ipcRenderer.invoke('market:open-homepage', url),
    onProgress: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('market:progress', listener);
        return () => ipcRenderer.removeListener('market:progress', listener);
    }
});
