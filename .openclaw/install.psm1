# ClawApp 一键部署脚本 (Windows PowerShell)
# 用法: irm https://raw.githubusercontent.com/qingchencloud/clawapp/main/install.ps1 | iex
# 或者: powershell -ExecutionPolicy Bypass -File install.ps1
# 非交互: powershell -ExecutionPolicy Bypass -File install.ps1 -Auto
#Requires -Version 5.1

param(
    [switch]$Auto
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Info  { param($Msg) Write-Host "[INFO] $Msg" -ForegroundColor Blue }
function Write-Ok    { param($Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "[!] $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "[X] $Msg" -ForegroundColor Red }
function Write-Ask   { param($Msg) Write-Host "[?] $Msg" -ForegroundColor Cyan -NoNewline }

function Show-Banner {
    Write-Host ""
    Write-Host "+======================================+" -ForegroundColor Cyan
    Write-Host "|     ClawApp 一键部署工具              |" -ForegroundColor Cyan
    Write-Host "|     OpenClaw AI 移动端客户端          |" -ForegroundColor Cyan
    Write-Host "+======================================+" -ForegroundColor Cyan
    Write-Host ""
}

function Test-CommandExists {
    param($Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

$InstallDir = if ($env:CLAWAPP_DIR) { $env:CLAWAPP_DIR } else { Join-Path $env:USERPROFILE "clawapp" }

function Test-NodeJS {
    if (Test-CommandExists "node") {
        $ver = (node -v) -replace "^v", ""
        $major = [int]($ver.Split(".")[0])
        if ($major -ge 18) {
            Write-Ok "Node.js v$ver"
            return $true
        }
        else {
            Write-Warn "Node.js v$ver 版本过低，需要 18+"
            return $false
        }
    }
    else {
        Write-Warn "未检测到 Node.js"
        return $false
    }
}

function Install-NodeJS {
    Write-Host ""
    Write-Warn "ClawApp 需要 Node.js 18+ 才能运行"
    Write-Host ""
    Write-Host "  1) 自动安装 (通过 winget)"
    Write-Host "  2) 自动安装 (通过 fnm)"
    Write-Host "  3) 我自己安装 (退出脚本)"
    Write-Host ""
    Write-Ask "请选择 [1/2/3]: "
    $choice = if ($Auto) { Write-Host "1 (自动)"; "1" } else { Read-Host }

    switch ($choice) {
        "1" {
            if (Test-CommandExists "winget") {
                Write-Info "正在通过 winget 安装 Node.js..."
                winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                Write-Ok "Node.js 安装完成，请关闭并重新打开 PowerShell 后重新运行此脚本"
                exit 0
            }
            else {
                Write-Err "winget 不可用，请使用方式 2 或手动安装"
                Install-NodeJS
            }
        }
        "2" {
            Write-Info "正在安装 fnm..."
            winget install Schniz.fnm --accept-package-agreements --accept-source-agreements 2>$null
            if (-not (Test-CommandExists "fnm")) {
                Invoke-WebRequest -Uri "https://fnm.vercel.app/install" -UseBasicParsing | Invoke-Expression
            }
            fnm install 22
            fnm use 22
            Write-Ok "Node.js $(node -v) 安装完成"
        }
        default {
            Write-Host ""
            Write-Info "请手动安装 Node.js 18+:"
            Write-Host "  https://nodejs.org/"
            Write-Host "  或: winget install OpenJS.NodeJS.LTS"
            Write-Host ""
            exit 0
        }
    }
}

function Test-Git {
    if (Test-CommandExists "git") {
        $ver = (git --version) -replace "git version ", ""
        Write-Ok "Git $ver"
        return $true
    }
    else {
        Write-Warn "未检测到 Git"
        return $false
    }
}

function Install-Git {
    if (Test-CommandExists "winget") {
        Write-Info "正在通过 winget 安装 Git..."
        winget install Git.Git --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (Test-CommandExists "git") {
            Write-Ok "Git 安装完成"
        }
        else {
            Write-Warn "Git 已安装，请关闭并重新打开 PowerShell 后重新运行此脚本"
            exit 0
        }
    }
    else {
        Write-Err "请手动安装 Git: https://git-scm.com/download/win"
        exit 1
    }
}

$script:GatewayToken = ""
$script:GatewayUrl = "ws://127.0.0.1:18789"
$script:GatewayRunning = $false

function Find-OpenClaw {
    $configPath = Join-Path (Join-Path $env:USERPROFILE ".openclaw") "openclaw.json"

    if (Test-Path $configPath) {
        Write-Ok "检测到本地 OpenClaw 安装"
        try {
            $configText = Get-Content $configPath -Raw -Encoding UTF8
            $config = $configText | ConvertFrom-Json

            if ($config.gateway.auth.token) {
                $script:GatewayToken = $config.gateway.auth.token
                Write-Ok "已自动读取 Gateway Token"
            }
            if ($config.gateway.port) {
                $script:GatewayUrl = "ws://127.0.0.1:$($config.gateway.port)"
            }
        }
        catch {
            Write-Warn "读取 OpenClaw 配置失败: $_"
        }
    }

    $gwPort = if ($config.gateway.port) { $config.gateway.port } else { 18789 }
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $gwPort)
        $tcp.Close()
        Write-Ok "OpenClaw Gateway 正在运行 (端口 $gwPort)"
        $script:GatewayRunning = $true
    }
    catch {
        Write-Warn "OpenClaw Gateway 未运行"
        $script:GatewayRunning = $false
    }
}

function Install-OpenClawOptional {
    if ($script:GatewayRunning) { return }

    $configPath = Join-Path (Join-Path $env:USERPROFILE ".openclaw") "openclaw.json"
    if (-not (Test-Path $configPath)) {
        Write-Host ""
        Write-Warn "未检测到 OpenClaw，ClawApp 需要 OpenClaw Gateway 才能工作"
        Write-Host ""
        Write-Host "  1) 自动安装 OpenClaw (npm install -g openclaw)"
        Write-Host "  2) 跳过，我稍后自己安装"
        Write-Host ""
        Write-Ask "请选择 [1/2]: "
        $choice = if ($Auto) { Write-Host "2 (自动跳过)"; "2" } else { Read-Host }

        if ($choice -eq "1") {
            Write-Info "正在安装 OpenClaw..."
            npm install -g openclaw
            Write-Ok "OpenClaw 安装完成，请运行 'openclaw' 启动后再使用 ClawApp"
        }
        else {
            Write-Warn "请确保 OpenClaw Gateway 运行后再使用 ClawApp"
            Write-Host "  安装: npm install -g openclaw"
            Write-Host "  启动: openclaw"
        }
    }
}

function Setup-Repo {
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Info "检测到已有安装，正在更新..."
        Set-Location $InstallDir
        git pull --ff-only origin main 2>$null
        if ($LASTEXITCODE -ne 0) { git pull origin main }
        Write-Ok "代码已更新"
    }
    else {
        Write-Info "正在克隆 ClawApp..."
        git clone https://github.com/qingchencloud/clawapp.git $InstallDir
        Set-Location $InstallDir
        Write-Ok "代码克隆完成"
    }
}

function Build-App {
    Write-Info "正在安装依赖..."
    npm install --silent 2>$null
    if ($LASTEXITCODE -ne 0) { npm install }

    Push-Location h5
    npm install --silent 2>$null
    if ($LASTEXITCODE -ne 0) { npm install }
    Pop-Location

    Write-Ok "依赖安装完成"

    Write-Info "正在构建 H5 前端..."
    npm run build:h5
    Write-Ok "H5 构建完成"

    Push-Location server
    npm install --silent 2>$null
    if ($LASTEXITCODE -ne 0) { npm install }
    Pop-Location

    Write-Ok "服务端依赖安装完成"
}

function Set-Config {
    $envFile = Join-Path (Join-Path $InstallDir "server") ".env"

    Write-Host ""
    Write-Info "配置 ClawApp"
    Write-Host ""

    Write-Ask "设置客户端连接密码 (PROXY_TOKEN，直接回车生成随机密码): "
    $inputProxyToken = if ($Auto) { Write-Host "(自动生成)"; "" } else { Read-Host }
    if ([string]::IsNullOrWhiteSpace($inputProxyToken)) {
        $bytes = New-Object byte[] 16
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $proxyToken = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
        Write-Info "已生成随机密码: $proxyToken"
    }
    else {
        $proxyToken = $inputProxyToken
    }

    if (-not [string]::IsNullOrWhiteSpace($script:GatewayToken)) {
        Write-Ask "Gateway Token (已自动检测，直接回车使用，或输入新的): "
        $inputGwToken = if ($Auto) { Write-Host "(使用自动检测)"; "" } else { Read-Host }
        if (-not [string]::IsNullOrWhiteSpace($inputGwToken)) {
            $script:GatewayToken = $inputGwToken
        }
    }
    else {
        Write-Ask "Gateway Token (在 ~/.openclaw/openclaw.json 中查找): "
        $script:GatewayToken = if ($Auto) { Write-Host "(未检测到，使用占位符)"; "REPLACE_ME" } else { Read-Host }
        if ([string]::IsNullOrWhiteSpace($script:GatewayToken)) {
            Write-Err "Gateway Token 不能为空"
            exit 1
        }
    }

    Write-Ask "Gateway 地址 (直接回车使用 $($script:GatewayUrl)): "
    $inputGwUrl = if ($Auto) { Write-Host "(使用默认)"; "" } else { Read-Host }
    if (-not [string]::IsNullOrWhiteSpace($inputGwUrl)) {
        $script:GatewayUrl = $inputGwUrl
    }

    Write-Ask "服务端口 (直接回车使用 3210): "
    $inputPort = if ($Auto) { Write-Host "3210 (自动)"; "" } else { Read-Host }
    $proxyPort = if ([string]::IsNullOrWhiteSpace($inputPort)) { "3210" } else { $inputPort }

    $envContent = @"
PROXY_PORT=$proxyPort
PROXY_TOKEN=$proxyToken
OPENCLAW_GATEWAY_URL=$($script:GatewayUrl)
OPENCLAW_GATEWAY_TOKEN=$($script:GatewayToken)
"@
    [System.IO.File]::WriteAllText($envFile, $envContent, [System.Text.UTF8Encoding]::new($false))

    Write-Ok "配置已保存到 $envFile"

    $script:ProxyToken = $proxyToken
    $script:ProxyPort = $proxyPort
}

function Start-ClawApp {
    Write-Host ""
    Write-Host "  启动方式:"
    Write-Host ""
    Write-Host "  1) 直接启动 (前台运行)"
    Write-Host "  2) PM2 常驻运行 (推荐)"
    Write-Host "  3) 不启动，稍后手动启动"
    Write-Host ""
    Write-Ask "请选择 [1/2/3]: "
    $choice = if ($Auto) { Write-Host "2 (自动PM2)"; "2" } else { Read-Host }
    Write-Host ""

    switch ($choice) {
        "1" {
            Write-Info "正在启动 ClawApp..."
            Write-Host ""
            Write-Host "  按 Ctrl+C 停止服务" -ForegroundColor Green
            Write-Host ""
            node server/index.js
        }
        "2" {
            if (-not (Test-CommandExists "pm2")) {
                Write-Info "正在安装 PM2..."
                npm install -g pm2
            }
            pm2 delete clawapp 2>$null
            pm2 start server/index.js --name clawapp
            pm2 save
            Write-Ok "ClawApp 已通过 PM2 启动"
            Write-Host ""
            Write-Host "  常用命令:"
            Write-Host "    pm2 logs clawapp    # 查看日志"
            Write-Host "    pm2 restart clawapp # 重启"
            Write-Host "    pm2 stop clawapp    # 停止"
        }
        default {
            Write-Info "稍后手动启动:"
            Write-Host "    cd $InstallDir; node server/index.js"
        }
    }
}

function Show-Finish {
    $localIp = "你的电脑IP"
    try {
        $adapter = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
            $_.InterfaceAlias -notmatch "Loopback" -and
            $_.IPAddress -notmatch "^127\." -and
            $_.IPAddress -notmatch "^169\.254\."
        } | Select-Object -First 1
        if ($adapter) { $localIp = $adapter.IPAddress }
    }
    catch {}

    Write-Host ""
    Write-Host "+======================================+" -ForegroundColor Green
    Write-Host "|     ClawApp 部署完成！                |" -ForegroundColor Green
    Write-Host "+======================================+" -ForegroundColor Green
    Write-Host ""
    Write-Host "  安装目录: $InstallDir"
    Write-Host "  连接密码: $($script:ProxyToken)"
    Write-Host ""
    Write-Host "  手机访问: http://${localIp}:$($script:ProxyPort)"
    Write-Host "  本机访问: http://localhost:$($script:ProxyPort)"
    Write-Host ""
    Write-Host "  文档: https://github.com/qingchencloud/clawapp"
    Write-Host "  社区: https://discord.com/invite/U9AttmsNHh"
    Write-Host ""
}

function Main {
    Show-Banner
    Write-Info "系统: Windows $([System.Environment]::OSVersion.Version)"

    Write-Host ""
    Write-Info "检测环境..."
    Write-Host ""

    if (-not (Test-Git)) { Install-Git }
    if (-not (Test-NodeJS)) { Install-NodeJS }

    Find-OpenClaw
    Install-OpenClawOptional

    Write-Host ""
    Write-Info "安装目录: $InstallDir"
    Write-Ask "确认开始安装？[Y/n]: "
    $confirm = if ($Auto) { Write-Host "Y (自动)"; "Y" } else { Read-Host }
    if ($confirm -eq "n" -or $confirm -eq "N") {
        Write-Info "已取消"
        exit 0
    }
    Write-Host ""

    Setup-Repo
    Build-App
    Set-Config
    Show-Finish
    Start-ClawApp
}

Main
