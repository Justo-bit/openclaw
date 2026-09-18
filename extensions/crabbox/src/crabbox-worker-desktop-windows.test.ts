import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrabboxWindowsDesktopNodeLauncher,
  createCrabboxWindowsDesktopSetup,
} from "./crabbox-worker-desktop-windows.js";

const require = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
const options = {
  nodePath,
  nodeArgs: [String.raw`C:\Users\crabbox\runtime\openclaw.mjs`, "connect", "--ephemeral"],
  cwd: String.raw`C:\Users\crabbox\runtime`,
  stateDir: String.raw`C:\Users\crabbox\.openclaw\cloud-workers\cbx_fixture`,
  logPath: String.raw`C:\Users\crabbox\.openclaw\cloud-workers\cbx_fixture\node.log`,
};
const identity = {
  pid: 412,
  sessionId: 2,
  userSid: "S-1-5-21-123-456-789-1001",
  startTime: "2026-09-18T12:34:56.1234567Z",
};

function launcher(result: { status: number; stdout?: string; stderr?: string }) {
  let source = "";
  const mockFs = {
    mkdtempSync: () => String.raw`C:\Users\crabbox\AppData\Local\Temp\openclaw-desktop-fixture`,
    writeFileSync: (_file: string, value: string) => {
      source = value;
    },
    rmSync: vi.fn(),
  };
  const run = vi.fn(() => result);
  const runtime = runInNewContext(
    `${createCrabboxWindowsDesktopNodeLauncher()}
({ launch: launchWindowsDesktopNode, inspect: readWindowsDesktopSessionIdentity })`,
    {
      Buffer,
      require: (name: string) => {
        if (name === "node:fs") {
          return mockFs;
        }
        if (name === "node:path") {
          return path.win32;
        }
        if (name === "node:os") {
          return { tmpdir: () => String.raw`C:\Users\crabbox\AppData\Local\Temp` };
        }
        if (name === "node:child_process") {
          return { spawnSync: run };
        }
        return require(name);
      },
    },
  ) as {
    launch: (input: typeof options) => Promise<typeof identity>;
    inspect: () => { sessionId: number; userSid: string };
  };
  return { ...runtime, fs: mockFs, source: () => source };
}

describe("Windows desktop node service handoff", () => {
  it("returns the interactive process identity and removes its temporary caller script", async () => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify(identity) });
    await expect(runtime.launch(options)).resolves.toEqual(identity);
    expect(runtime.fs.rmSync).toHaveBeenCalledOnce();
  });

  it("delivers literal replacement tokens and apostrophes to the generated node process", async () => {
    const literal = "$& $` $' worker's";
    const requested = {
      nodePath: path.win32.join("C:\\", literal, "node.exe"),
      nodeArgs: [...options.nodeArgs, "--display-name", literal],
      cwd: path.win32.join(options.cwd, literal),
      stateDir: path.win32.join(options.stateDir, literal),
      logPath: path.win32.join(options.stateDir, literal, "node.log"),
    };
    const runtime = launcher({ status: 0, stdout: JSON.stringify(identity) });
    await runtime.launch(requested);
    // Inspect the actual script bytes delivered through Crabbox's PowerShell request.
    const delivered = [...runtime.source().matchAll(/FromBase64String\(''([A-Za-z0-9+/=]+)''\)/gu)]
      .map((match) => Buffer.from(match[1]!, "base64").toString("utf8"))
      .filter((value) => !value.startsWith("{"));
    expect(delivered).toHaveLength(1);
    const openLog = vi.fn(() => 11);
    const spawnNode = vi.fn(() => ({ once: vi.fn() }));
    runInNewContext(delivered[0]!, {
      Buffer,
      process: {
        argv: [requested.nodePath, "launch.cjs", "cancel-marker", "2", identity.userSid],
        env: {},
      },
      require: (name: string) => {
        if (name === "node:fs") {
          return { existsSync: () => false, openSync: openLog };
        }
        if (name === "node:child_process") {
          return { spawn: spawnNode };
        }
        throw new Error(`Unexpected launcher dependency: ${name}`);
      },
    });
    expect(openLog).toHaveBeenCalledWith(requested.logPath, "a");
    expect(spawnNode).toHaveBeenCalledExactlyOnceWith(requested.nodePath, requested.nodeArgs, {
      cwd: requested.cwd,
      env: { OPENCLAW_STATE_DIR: requested.stateDir },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", 11, 11],
    });
  });

  it.each([
    { name: "Session 0", changed: { sessionId: 0 } },
    { name: "missing process creation time", changed: { startTime: "" } },
    { name: "missing account identity", changed: { userSid: "" } },
    { name: "invalid process identifier", changed: { pid: -1 } },
  ])("rejects $name rather than advertising a usable desktop", async ({ changed }) => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify({ ...identity, ...changed }) });
    await expect(runtime.launch(options)).rejects.toThrow("interactive node identity is invalid");
    expect(runtime.fs.rmSync).toHaveBeenCalledOnce();
  });

  it("rejects a missing interactive session during replay inspection", () => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify({ ...identity, sessionId: 0 }) });
    expect(() => runtime.inspect()).toThrow("interactive session identity is invalid");
  });

  it("preserves service failure diagnostics and cleans the temporary caller script", async () => {
    const runtime = launcher({
      status: 1,
      stderr:
        "Cloud desktop launch outcome could not be confirmed; release and reprovision the worker",
    });
    await expect(runtime.launch(options)).rejects.toThrow("outcome could not be confirmed");
    expect(runtime.fs.rmSync).toHaveBeenCalledOnce();
  });
});

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell =
  spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
    stdio: "ignore",
  }).status === 0;

describe.skipIf(!hasPowerShell)("generated Windows PowerShell syntax", () => {
  it("parses setup, nested app launchers, and enrollment using the installed PowerShell parser", async () => {
    const runtime = launcher({ status: 0, stdout: JSON.stringify(identity) });
    await runtime.launch(options);
    const scripts = [
      createCrabboxWindowsDesktopSetup("cbx_fixture", "c3ludGhldGlj"),
      runtime.source(),
    ];
    const parser = String.raw`
$ErrorActionPreference = 'Stop'
function Check-Script([string]$text) {
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
  foreach ($literal in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains([char]10) -and ($node.Value.StartsWith('param(') -or $node.Value.StartsWith('$ErrorActionPreference')) }, $true)) { Check-Script $literal.Value }
}
foreach ($script in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) { Check-Script $script }
`;
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", parser], {
      input: JSON.stringify(scripts),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect({ code: result.status, errors: result.stderr }).toEqual({ code: 0, errors: "" });
  });
});

describe.skipIf(!hasPowerShell)("Windows browser launcher ownership", () => {
  it.each([
    { scenario: "reuse", passed: true, launches: 0 },
    { scenario: "launch", passed: true, launches: 1 },
    { scenario: "reduced-environment", passed: true, launches: 1 },
    { scenario: "different-profile", passed: false, launches: 0 },
    { scenario: "different-binary", passed: false, launches: 0 },
    { scenario: "different-account", passed: false, launches: 0 },
    { scenario: "different-session", passed: false, launches: 0 },
    { scenario: "public-listener", passed: false, launches: 0 },
    { scenario: "changed-after-response", passed: false, launches: 1 },
  ])("$scenario", ({ scenario, passed, launches }) => {
    const root = tempDirs.make("windows-browser-owner-");
    const browser = path.join(root, "browser's.exe");
    fs.writeFileSync(browser, "synthetic executable identity; never executed");
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Find-LauncherExpression([string]$text) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
  if($errors.Count){ throw ($errors | Out-String) }
  $writes=@($ast.FindAll({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'WriteAllText' -and $node.Arguments[0].Extent.Text.Contains("'browser.ps1'") },$true))
  if($writes.Count){ return $writes[0].Arguments[1].Extent.Text }
  foreach($literal in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.StartsWith('param(') },$true)){ $found=Find-LauncherExpression $literal.Value; if($found){ return $found } }
  return $null
}
$expression=Find-LauncherExpression $fixture.setup
if(-not $expression){throw 'Setup did not install a browser launcher'}
$browserExecutable=$fixture.browser
$source=& ([scriptblock]::Create('return '+$expression))
# Map only the lease-owned filesystem root; execute the installed script unchanged otherwise.
$source=$source.Replace('C:\ProgramData\OpenClaw\cloud-workers\cbx_fixture\desktop\browser-profile',(Join-Path $fixture.root 'profile data'))
$launcher=Join-Path $fixture.root 'browser.ps1'
[IO.File]::WriteAllText($launcher,$source)
$env:BROWSER=$fixture.browser
$env:CHROME_BIN=$fixture.browser
$env:ProgramFiles=$fixture.root
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', $fixture.root, 'Process')
$env:LOCALAPPDATA=Join-Path $fixture.root 'profile data'
if($fixture.scenario -eq 'reduced-environment') {
  foreach($name in @('LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','BROWSER','CHROME_BIN')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
}
$global:launches=0
$global:responded=$false
function Get-NetTCPConnection {
  if($fixture.scenario -in @('launch','reduced-environment','changed-after-response') -and $global:launches -eq 0){return}
  [pscustomobject]@{LocalAddress=$(if($fixture.scenario -eq 'public-listener'){'0.0.0.0'}else{'127.0.0.1'});OwningProcess=700}
}
function Get-CimInstance {
  param($ClassName,$Filter)
  if($Filter -eq ('ProcessId='+$PID)){return [pscustomobject]@{ProcessId=$PID;SessionId=2;Sid='S-1-5-21-1001'}}
  $profile=Join-Path $fixture.root 'profile data'
  if($fixture.scenario -eq 'different-profile' -or ($fixture.scenario -eq 'changed-after-response' -and $global:responded)){$profile+='-other'}
  [pscustomobject]@{
    ProcessId=700
    SessionId=$(if($fixture.scenario -eq 'different-session'){3}else{2})
    Sid=$(if($fixture.scenario -eq 'different-account'){'S-1-5-21-2001'}else{'S-1-5-21-1001'})
    ExecutablePath=$(if($fixture.scenario -eq 'different-binary'){Join-Path $fixture.root 'other.exe'}else{$fixture.browser})
    CommandLine=('"'+$fixture.browser+'" --user-data-dir="'+$profile+'" --remote-debugging-port=9222')
  }
}
function Invoke-CimMethod { param($InputObject,$MethodName) [pscustomobject]@{Sid=$InputObject.Sid} }
function Start-Process { $global:launches++ }
function Invoke-RestMethod { $global:responded=$true; [pscustomobject]@{Browser='Synthetic Chrome'} }
try { & $launcher; $passed=$true; $message=$null } catch { $passed=$false; $message=$_.Exception.Message }
@{passed=$passed;launches=$global:launches;message=$message} | ConvertTo-Json -Compress
`;
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", harness], {
      input: JSON.stringify({
        scenario,
        root,
        browser,
        setup: createCrabboxWindowsDesktopSetup("cbx_fixture", "c3ludGhldGlj"),
      }),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect({ code: result.status, errors: result.stderr }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ passed, launches });
  });
});
