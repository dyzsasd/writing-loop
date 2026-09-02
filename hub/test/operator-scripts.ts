// 操作者脚本的可执行约束：macOS 自带的 bash 3.2 会把紧跟在 `$NAME` 后面的非 ASCII 字符（全角括号、
// 中文标点）当成变量名的一部分，在 `set -u` 下报「NAME�: unbound variable」。回归：2026-09-02
// `gcp-h3-vm.sh create` 在本机第一次运行即因此失败。规则：`$NAME` 后紧跟非 ASCII 字符时必须写成 `${NAME}`。
// 同时用 `bash -n` 做语法检查。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const repoRoot = join(import.meta.dirname, "..", "..");
const scriptDirs = [join(repoRoot, "writing-loop-operator", "scripts"), join(repoRoot, "scripts")];
const scripts: string[] = [];
for (const dir of scriptDirs) {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { continue; }
  for (const entry of entries) if (entry.endsWith(".sh")) scripts.push(join(dir, entry));
}
ok(scripts.length >= 2, `找到 ${scripts.length} 个 shell 脚本（writing-loop-operator/scripts、scripts）`);

// `$NAME` 紧跟非 ASCII 字符；`${NAME}` 不匹配，`$(`、`$?` 等非标识符不匹配。
const unbracedBeforeNonAscii = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u;
for (const script of scripts) {
  const rel = script.slice(repoRoot.length + 1);
  const offending: string[] = [];
  readFileSync(script, "utf8").split("\n").forEach((line, index) => {
    if (unbracedBeforeNonAscii.test(line)) offending.push(`${index + 1}: ${line.trim().slice(0, 80)}`);
  });
  ok(offending.length === 0,
    `${rel}：\`$NAME\` 后紧跟非 ASCII 字符时必须写成 \`\${NAME}\`（bash 3.2 会把它并进变量名）`
    + (offending.length > 0 ? `\n  ${offending.join("\n  ")}` : ""));
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  ok(syntax.status === 0, `${rel}：bash -n 语法检查通过${syntax.status === 0 ? "" : `\n  ${syntax.stderr.trim()}`}`);
}

// 2026-09-02 回归：G4 机型不接受 pd-* 启动盘（API：pd-balanced disk type cannot be used by g4-standard-48）。
{
  const vmScript = readFileSync(join(repoRoot, "writing-loop-operator", "scripts", "gcp-h3-vm.sh"), "utf8");
  const createBlock = /gc compute instances create[\s\S]*?--metadata-from-file/.exec(vmScript)?.[0] ?? "";
  ok(vmScript.includes('BOOT_DISK_TYPE="${WL_GPU_BOOT_DISK_TYPE:-hyperdisk-balanced}"')
    && createBlock.includes('--boot-disk-type "$BOOT_DISK_TYPE"')
    && !/--boot-disk-type\s+pd-/.test(createBlock),
    "gcp-h3-vm.sh：启动盘类型默认 hyperdisk-balanced 且可用 WL_GPU_BOOT_DISK_TYPE 覆盖（G4 机型不接受 pd-*）");
}

// 2026-09-02 回归：IAP TCP 转发（start-iap-tunnel）连不到只绑 127.0.0.1 的 gateway / ComfyUI
// （4003 failed to connect to backend）；回环端口必须经 IAP 的 ssh -L 转发。
{
  const vmScript = readFileSync(join(repoRoot, "writing-loop-operator", "scripts", "gcp-h3-vm.sh"), "utf8");
  const tunnelSource = /cmd_tunnel\(\) \{[\s\S]*?\n\}\n/.exec(vmScript)?.[0] ?? "";
  // 只看可执行行：注释里允许提到 start-iap-tunnel 来说明为什么不用它。
  const tunnelBlock = tunnelSource.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  ok(tunnelBlock.length > 0 && !tunnelBlock.includes("start-iap-tunnel")
    && tunnelBlock.includes("--tunnel-through-iap") && tunnelBlock.includes('-L "127.0.0.1:${port}:127.0.0.1:${port}"')
    && tunnelBlock.includes("ExitOnForwardFailure=yes"),
    "gcp-h3-vm.sh tunnel：回环端口经 IAP 的 ssh -L 转发（start-iap-tunnel 连不到只绑 127.0.0.1 的服务）");
}

console.log(fails === 0 ? "\nOPERATOR_SCRIPTS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
