const { build } = require("electron-builder");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = __dirname;

const packageJsonPath = path.join(ROOT_DIR, "package.json");
const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8")
);

const version = packageJson.version;

const outputDir = path.join(
    ROOT_DIR,
    "dist",
    version
);

/*
 * 完整 Runtime 母版
 */
const sourceHarnessDir = path.join(
    ROOT_DIR,
    "harness-runtime"
);

/*
 * 每次打包临时生成的精简 Runtime
 */
const buildHarnessDir = path.join(
    ROOT_DIR,
    "harness-build"
);


/* =========================================================
 * 工具：统计目录
 * ========================================================= */

async function getDirectoryStats(dir) {

    let count = 0;
    let bytes = 0;

    async function walk(currentDir) {

        const entries = await fs.promises.readdir(
            currentDir,
            {
                withFileTypes: true
            }
        );

        for (const entry of entries) {

            const fullPath = path.join(
                currentDir,
                entry.name
            );

            if (entry.isDirectory()) {

                await walk(fullPath);

                continue;
            }

            try {

                const stat = await fs.promises.stat(
                    fullPath
                );

                count += 1;
                bytes += stat.size;

            } catch {
                // 忽略无法读取的文件
            }
        }
    }

    await walk(dir);

    return {
        count,
        bytes
    };
}


/* =========================================================
 * 工具：格式化大小
 * ========================================================= */

function formatSize(bytes) {

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}


/* =========================================================
 * 工具：删除指定扩展名
 * ========================================================= */

async function removeFilesByExtension(
    rootDir,
    extensions
) {

    let removedCount = 0;
    let removedBytes = 0;

    async function walk(currentDir) {

        const entries = await fs.promises.readdir(
            currentDir,
            {
                withFileTypes: true
            }
        );

        for (const entry of entries) {

            const fullPath = path.join(
                currentDir,
                entry.name
            );

            if (entry.isDirectory()) {

                await walk(fullPath);

                continue;
            }

            const ext = path.extname(
                entry.name
            ).toLowerCase();

            if (!extensions.includes(ext)) {
                continue;
            }

            try {

                const stat = await fs.promises.stat(
                    fullPath
                );

                await fs.promises.unlink(
                    fullPath
                );

                removedCount += 1;
                removedBytes += stat.size;

            } catch (error) {

                console.warn(
                    `无法删除文件：${fullPath}`,
                    error.message
                );
            }
        }
    }

    await walk(rootDir);

    return {
        removedCount,
        removedBytes
    };
}


/* =========================================================
 * 准备精简 Runtime
 * ========================================================= */

async function prepareHarnessRuntime() {

    console.log("");
    console.log("========================================");
    console.log(" 正在准备精简 Harness Runtime");
    console.log("========================================");
    console.log("");

    if (!fs.existsSync(sourceHarnessDir)) {

        throw new Error(
            `找不到源 Runtime：\n${sourceHarnessDir}`
        );
    }

    const sourceStats =
        await getDirectoryStats(
            sourceHarnessDir
        );

    console.log(
        `源 Runtime：${sourceStats.count} 文件，${formatSize(sourceStats.bytes)}`
    );

    /*
     * 删除旧的临时 Runtime
     */
    await fs.promises.rm(
        buildHarnessDir,
        {
            recursive: true,
            force: true
        }
    );

    /*
     * 复制完整 Runtime
     */
    await fs.promises.cp(
        sourceHarnessDir,
        buildHarnessDir,
        {
            recursive: true,
            force: true
        }
    );

    console.log(
        "✅ Runtime 复制完成"
    );

    /*
     * 删除已经验证安全的文件
     */
    const removableExtensions = [
        ".map",
        ".md",
        ".ts",
        ".mts"
    ];

    console.log(
        `正在清理：${removableExtensions.join(", ")}`
    );

    const cleanup =
        await removeFilesByExtension(
            buildHarnessDir,
            removableExtensions
        );

    console.log(
        `✅ 删除 ${cleanup.removedCount} 个文件，释放 ${formatSize(cleanup.removedBytes)}`
    );

    /*
     * 检查关键文件
     */
    const nodePath = path.join(
        buildHarnessDir,
        "dsh-service.exe"
    );

    const dshPath = path.join(
        buildHarnessDir,
        "node_modules",
        "@deepseek-ai",
        "dsh",
        "lib",
        "bin.js"
    );

    if (!fs.existsSync(nodePath)) {

        throw new Error(
            `精简 Runtime 缺少 dsh-service.exe：\n${nodePath}`
        );
    }

    if (!fs.existsSync(dshPath)) {

        throw new Error(
            `精简 Runtime 缺少 DSH：\n${dshPath}`
        );
    }

    const watchdogPath = path.join(
        buildHarnessDir,
        "watchdog.js"
    );

    if (!fs.existsSync(watchdogPath)) {

        throw new Error(
            `精简 Runtime 缺少看门狗：\n${watchdogPath}`
        );
    }

    const pnpmPath = path.join(
        buildHarnessDir,
        "node_modules",
        "pnpm",
        "bin",
        "pnpm.cjs"
    );

    if (!fs.existsSync(pnpmPath)) {

        throw new Error(
            `精简 Runtime 缺少内置 pnpm：${pnpmPath}`
        );
    }

    const finalStats =
        await getDirectoryStats(
            buildHarnessDir
        );

    console.log(
        `✅ 精简 Runtime：${finalStats.count} 文件，${formatSize(finalStats.bytes)}`
    );

    console.log(
        "✅ dsh-service.exe 检查通过"
    );

    console.log(
        "✅ DSH bin.js 检查通过"
    );

    console.log(
        "✅ watchdog.js 检查通过"
    );

    console.log(
        "✅ 内置 pnpm 检查通过"
    );

    const skinPath = path.join(
        buildHarnessDir,
        "node_modules",
        "@dsh-external",
        "dsh-client-ui-skin-maid-atelier"
    );

    console.log(
        `✅ 鲸鱼娘皮肤：${fs.existsSync(skinPath) ? "已包含（开盒即用）" : "未包含"}`
    );

    console.log("");

    return {
        nodePath,
        dshPath
    };
}


/* =========================================================
 * 清理旧版本 win-unpacked
 * ========================================================= */

/**
 * 打包成功后，删除其他版本目录里的 win-unpacked 中间产物，
 * 只保留当前版本的解包目录（Setup.exe 始终保留，供版本归档）。
 */
async function cleanupOldUnpacked(currentVersion) {

    const distDir = path.join(
        ROOT_DIR,
        "dist"
    );

    if (!fs.existsSync(distDir)) {
        return;
    }

    const entries = await fs.promises.readdir(
        distDir,
        {
            withFileTypes: true
        }
    );

    let freedBytes = 0;
    let removedCount = 0;

    for (const entry of entries) {

        if (
            !entry.isDirectory() ||
            entry.name === currentVersion
        ) {
            continue;
        }

        const unpackedDir = path.join(
            distDir,
            entry.name,
            "win-unpacked"
        );

        if (!fs.existsSync(unpackedDir)) {
            continue;
        }

        const stats = await getDirectoryStats(
            unpackedDir
        );

        await fs.promises.rm(
            unpackedDir,
            {
                recursive: true,
                force: true
            }
        );

        freedBytes += stats.bytes;
        removedCount += 1;

        console.log(
            `🧹 已清理旧版中间产物：dist\\${entry.name}\\win-unpacked（${formatSize(stats.bytes)}）`
        );
    }

    if (removedCount > 0) {

        console.log(
            `✅ 共清理 ${removedCount} 个旧版 win-unpacked，释放 ${formatSize(freedBytes)}，仅保留 dist\\${currentVersion}\\win-unpacked`
        );
    }

    console.log("");
}


/* =========================================================
 * electron-builder
 * ========================================================= */

/**
 * 给 electron-builder 的 NSIS 模板打补丁：
 * 安装目录页结束、开始装文件之前，自动创建不存在的安装目录，
 * 用户无需手动预建文件夹。
 *
 * 幂等：模板已包含补丁标记时跳过；
 * node_modules 重装后补丁丢失，但每次构建都会重新打上。
 */
async function patchNsisTemplate() {

    const templatePath = require.resolve(
        "app-builder-lib/templates/nsis/assistedInstaller.nsh"
    );

    let content = fs.readFileSync(templatePath, "utf8");

    const marker =
        "dshAutoCreateInstallDir";

    if (content.includes(marker)) {
        return;
    }

    if (!content.includes("Function instFilesPre")) {

        console.warn(
            "⚠️ NSIS 模板结构变化，跳过安装目录自动创建补丁"
        );

        return;
    }

    content = content.replace(
        /\$\{endIf\}[\r\n]+\s*FunctionEnd[\r\n]+/,
        () => {

            return [
                "${endIf}",
                "",
                "      # " + marker + ": 自动创建不存在的安装目录",
                "      CreateDirectory \"$INSTDIR\"",
                "",
                "FunctionEnd",
                ""
            ].join("\r\n");
        }
    );

    if (!content.includes(marker)) {

        console.warn(
            "⚠️ NSIS 模板补丁未生效（模式不匹配），跳过"
        );

        return;
    }

    fs.writeFileSync(templatePath, content);

    console.log(
        "✅ NSIS 模板已打补丁：安装目录自动创建"
    );
}

async function runBuild() {

    await prepareHarnessRuntime();

    await patchNsisTemplate();

    /*
     * 清理旧版本输出
     */
    await fs.promises.rm(
        outputDir,
        {
            recursive: true,
            force: true
        }
    );

    console.log("");
    console.log("========================================");
    console.log(" 开始 electron-builder");
    console.log("========================================");
    console.log("");

    /*
     * 除“输出目录”和“afterPack 钩子”外，
     * 打包配置全部来自 package.json 的 build 字段。
     *
     * 注意：不要在 config 里重复写 win/files/nsis 等字段，
     * electron-builder 会把数组合并，导致 NSIS 目标被构建两次。
     */
    await build({
        config: {
            directories: {
                output: outputDir
            },

            /*
             * electron-builder 完成 win-unpacked 后，
             * 再把精简 Runtime 复制到 resources\harness
             */
            afterPack: async (context) => {

                const targetHarnessDir = path.join(
                    context.appOutDir,
                    "resources",
                    "harness"
                );

                console.log("");
                console.log("========================================");
                console.log(" 正在复制精简 Harness Runtime");
                console.log("========================================");
                console.log(
                    `目标目录：${targetHarnessDir}`
                );
                console.log("");

                await fs.promises.rm(
                    targetHarnessDir,
                    {
                        recursive: true,
                        force: true
                    }
                );

                await fs.promises.cp(
                    buildHarnessDir,
                    targetHarnessDir,
                    {
                        recursive: true,
                        force: true
                    }
                );

                const copiedNode = path.join(
                    targetHarnessDir,
                    "dsh-service.exe"
                );

                const copiedDsh = path.join(
                    targetHarnessDir,
                    "node_modules",
                    "@deepseek-ai",
                    "dsh",
                    "lib",
                    "bin.js"
                );

                const copiedWatchdog = path.join(
                    targetHarnessDir,
                    "watchdog.js"
                );

                console.log(
                    `dsh-service.exe：${fs.existsSync(copiedNode) ? "✅" : "❌"}`
                );

                console.log(
                    `DSH bin.js：${fs.existsSync(copiedDsh) ? "✅" : "❌"}`
                );

                if (!fs.existsSync(copiedNode)) {

                    throw new Error(
                        `复制后找不到 dsh-service.exe：\n${copiedNode}`
                    );
                }

                if (!fs.existsSync(copiedDsh)) {

                    throw new Error(
                        `复制后找不到 DSH：\n${copiedDsh}`
                    );
                }

                if (!fs.existsSync(copiedWatchdog)) {

                    throw new Error(
                        `复制后找不到看门狗：\n${copiedWatchdog}`
                    );
                }

                console.log(
                    `watchdog.js：${fs.existsSync(copiedWatchdog) ? "✅" : "❌"}`
                );

                console.log(
                    "✅ 精简 Harness Runtime 复制完成"
                );

                console.log("");
            }
        }
    });

    /*
     * 构建成功后：自动清理其他版本的 win-unpacked，
     * 只保留当前版本的解包目录。
     */
    await cleanupOldUnpacked(version);
}


/* =========================================================
 * 主程序
 * ========================================================= */

async function main() {

    console.log("");
    console.log("========================================");
    console.log(" DeepSeek Harness Desktop");
    console.log("========================================");
    console.log(`当前版本：${version}`);
    console.log(`输出目录：${outputDir}`);
    console.log(`源 Runtime：${sourceHarnessDir}`);
    console.log(`临时 Runtime：${buildHarnessDir}`);
    console.log("========================================");
    console.log("");

    try {

        await runBuild();

        console.log("");
        console.log("========================================");
        console.log(`✅ 打包完成：${version}`);
        console.log(`输出目录：dist\\${version}`);
        console.log("========================================");
        console.log("");

    } catch (error) {

        console.error("");
        console.error("❌ 打包失败：");
        console.error(error);

        process.exitCode = 1;

    } finally {

        /*
         * 无论成功还是失败，都删除临时 Runtime
         */
        try {

            await fs.promises.rm(
                buildHarnessDir,
                {
                    recursive: true,
                    force: true
                }
            );

            console.log(
                "临时 harness-build 已清理"
            );

        } catch (cleanupError) {

            console.warn(
                "⚠️ 清理临时 Runtime 失败：",
                cleanupError.message
            );
        }
    }
}


main();