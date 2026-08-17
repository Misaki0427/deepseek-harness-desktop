/**
 * Harness 看门狗
 *
 * 由 Electron 主进程用内置 node.exe 启动：
 *
 * Electron Main
 *   ↓ spawn
 * watchdog.js（本文件）
 *   ↓ spawn
 * @deepseek-ai/dsh web → 127.0.0.1:3080
 *
 * 作用：
 * 当 Electron 主进程被任务管理器强杀等异常方式结束时，
 * Windows 不会自动结束其子进程。本看门狗每隔数秒检查
 * 父进程（Electron）是否存活，一旦消失就主动结束整个
 * Harness 进程树，避免残留进程占用 3080 端口。
 */
const { spawn } = require('child_process');
const path = require('path');

const PARENT_PID = Number(process.argv[2]);
const POLL_INTERVAL_MS = 3000;

const DSH_ENTRY = path.join(
    __dirname,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
);

if (!Number.isFinite(PARENT_PID) || PARENT_PID <= 0) {

    console.error(
        '[WATCHDOG] 缺少有效的父进程 PID，拒绝启动'
    );

    process.exit(2);
}

console.log(
    `[WATCHDOG] 启动，父进程 PID=${PARENT_PID}`
);

const child = spawn(
    process.execPath,
    [
        DSH_ENTRY,
        'web'
    ],
    {
        cwd: __dirname,

        env: {
            ...process.env,
            FORCE_COLOR: '1',
            NODE_ENV: 'production'
        },

        windowsHide: true,

        stdio: [
            'ignore',
            'inherit',
            'inherit'
        ]
    }
);

child.on(
    'error',
    (error) => {

        console.error(
            '[WATCHDOG] Harness 启动失败：',
            error
        );

        process.exit(1);
    }
);

child.on(
    'exit',
    (code, signal) => {

        console.log(
            `[WATCHDOG] Harness 进程退出：code=${code}, signal=${signal}`
        );

        process.exit(code == null ? 0 : code);
    }
);

/**
 * 检查父进程是否还活着。
 */
function parentAlive() {

    try {

        process.kill(PARENT_PID, 0);

        return true;

    } catch {

        return false;
    }
}

const timer = setInterval(
    () => {

        if (parentAlive()) {
            return;
        }

        console.warn(
            '[WATCHDOG] 检测到父进程已退出，结束 Harness 进程树'
        );

        clearInterval(timer);

        const killer =
            spawn(
                'taskkill',
                [
                    '/PID',
                    String(child.pid),
                    '/T',
                    '/F'
                ],
                {
                    windowsHide: true,
                    stdio: 'ignore'
                }
            );

        killer.on(
            'close',
            () => {
                process.exit(0);
            }
        );

        killer.on(
            'error',
            () => {
                process.exit(0);
            }
        );
    },
    POLL_INTERVAL_MS
);
