# ===================================================================
#  Cameras do Mercadinho - instalador para Windows
#  Instala em C:\MercadinhoCameras: go2rtc (ao vivo), painel React
#  (ao vivo + Revisao), gravador com deteccao de movimento, tudo subindo
#  sozinho no boot (mesmo sem ninguem logar). Notebook sem dormir,
#  firewall so para o Tailscale, e Tailscale para acesso de fora.
# ===================================================================
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$APP  = 'C:\MercadinhoCameras'
$TN   = 'Mercadinho Cameras'
$PY   = "$APP\python\python.exe"
$Self = $env:MC_SELF

function Etapa([string]$t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok([string]$t)    { Write-Host "  OK  $t" -ForegroundColor Green }
function Aviso([string]$t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function Falha([string]$t) {
  Write-Host ""; Write-Host "ERRO: $t" -ForegroundColor Red
  Write-Host "O registro completo esta em $APP\logs\instalacao.log - mande ele pro Claude." -ForegroundColor Red
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

function Baixar([string[]]$urls, [string]$dest, [long]$minimo = 100000) {
  foreach ($u in $urls) {
    for ($i = 1; $i -le 2; $i++) {
      try {
        Write-Host "  baixando $u"
        Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $dest -TimeoutSec 900 -ErrorAction Stop
        if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt $minimo)) { return $true }
      } catch { Aviso "falhou: $($_.Exception.Message)"; Start-Sleep 3 }
    }
  }
  return $false
}

function Extrair([string]$zip, [string]$dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $tar = "$env:SystemRoot\System32\tar.exe"
  if (Test-Path $tar) {
    & $tar -xf $zip -C $dest 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
  }
  Expand-Archive -Path $zip -DestinationPath $dest -Force -ErrorAction Stop
}

function SoAdmins([string]$f) {
  # deixa o arquivo legivel so por SYSTEM e Administradores (SIDs, funciona em qualquer idioma)
  if (Test-Path $f) { & icacls $f /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1 | Out-Null }
}

function Main {
  # ---------- administrador ----------
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Write-Host "Pedindo permissao de administrador (clique em Sim)..."
    if (-not $Self) { Write-Host "Execute o arquivo .bat com dois cliques."; exit 1 }
    Start-Process -FilePath $Self -Verb RunAs
    exit 99
  }

  New-Item -ItemType Directory -Force -Path $APP, "$APP\logs", "$APP\bin", "$APP\ui\rec" | Out-Null
  try { Start-Transcript -Path "$APP\logs\instalacao.log" -Append | Out-Null } catch {}

  Write-Host ""
  Write-Host "  CAMERAS DO MERCADINHO - instalacao" -ForegroundColor Cyan
  Write-Host "  Leva uns 5 a 15 minutos (baixa ~150 MB). Nao feche esta janela."

  if (-not [Environment]::Is64BitOperatingSystem) { Falha "Este Windows e 32 bits; o sistema precisa de Windows 64 bits." }

  # ---------- 1) parar versao anterior ----------
  Etapa "1/9 Preparando"
  & schtasks /End /TN $TN 2>&1 | Out-Null
  Start-Sleep 2
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($APP, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
  Ok "pasta $APP"

  # ---------- 2) arquivos do sistema ----------
  Etapa "2/9 Copiando o sistema"
  $zip = Join-Path $env:TEMP 'mercadinho-app.zip'
  try {
    [IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($PAYLOAD))
    Extrair $zip $APP
  } catch { Falha "nao consegui extrair o pacote: $($_.Exception.Message)" }
  if (-not (Test-Path "$APP\supervisor.py")) { Falha "pacote incompleto" }
  Ok "painel, gravador e ferramentas"

  # ---------- 3) Python embutido ----------
  Etapa "3/9 Python"
  if (-not (Test-Path $PY)) {
    $pz = Join-Path $env:TEMP 'py-embed.zip'
    if (-not (Baixar @('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip') $pz)) { Falha "nao consegui baixar o Python" }
    Extrair $pz "$APP\python"
  }
  $pth = Get-ChildItem "$APP\python" -Filter 'python*._pth' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pth -and -not (Select-String -Path $pth.FullName -SimpleMatch $APP -Quiet)) { Add-Content -Path $pth.FullName -Value $APP }
  if (-not (Test-Path $PY)) { Falha "Python nao instalou" }
  Ok "Python $(& $PY -c 'import sys;print(sys.version.split()[0])')"

  # ---------- 4) ffmpeg ----------
  Etapa "4/9 ffmpeg"
  if (-not (Test-Path "$APP\bin\ffmpeg.exe")) {
    $fz = Join-Path $env:TEMP 'ffmpeg.zip'
    $urls = @('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
              'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip')
    if (-not (Baixar $urls $fz 10000000)) { Falha "nao consegui baixar o ffmpeg" }
    $fx = Join-Path $env:TEMP 'ffmpeg-x'
    Remove-Item $fx -Recurse -Force -ErrorAction SilentlyContinue
    Extrair $fz $fx
    $b = Get-ChildItem $fx -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    if (-not $b) { Falha "ffmpeg.exe nao encontrado no pacote" }
    Copy-Item (Join-Path $b.DirectoryName 'ffmpeg.exe'), (Join-Path $b.DirectoryName 'ffprobe.exe') "$APP\bin\" -Force
    Remove-Item $fx -Recurse -Force -ErrorAction SilentlyContinue
  }
  Ok "ffmpeg e ffprobe"

  # ---------- 5) go2rtc ----------
  Etapa "5/9 go2rtc"
  $gz = Join-Path $env:TEMP 'go2rtc.zip'
  if (-not (Baixar @('https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_win64.zip') $gz)) { Falha "nao consegui baixar o go2rtc" }
  $gx = Join-Path $env:TEMP 'go2rtc-x'
  Remove-Item $gx -Recurse -Force -ErrorAction SilentlyContinue
  Extrair $gz $gx
  $g = Get-ChildItem $gx -Recurse -Filter 'go2rtc*.exe' | Select-Object -First 1
  if (-not $g) { Falha "go2rtc.exe nao encontrado" }
  Copy-Item $g.FullName "$APP\go2rtc.exe" -Force
  Ok "go2rtc v1.9.14"

  # ---------- 6) senha + cameras ----------
  Etapa "6/9 Cameras"
  $senhaF = "$APP\senha.txt"
  $pedir = -not (Test-Path $senhaF)
  if (-not $pedir) {
    $r = Read-Host "  Ja existe uma senha salva. Trocar? (s/N)"
    if ($r -match '^[sS]') { $pedir = $true }
  }
  if ($pedir) {
    $plain = ''
    while (-not $plain) {
      $s = Read-Host "  Digite a senha RTSP das cameras" -AsSecureString
      $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    }
    [IO.File]::WriteAllText($senhaF, $plain)
    SoAdmins $senhaF
  }
  $env:FFMPEG  = "$APP\bin\ffmpeg.exe"
  $env:FFPROBE = "$APP\bin\ffprobe.exe"
  Push-Location $APP
  Write-Host "  procurando cameras na rede (uns 30-60s)..."
  & $PY -X utf8 scan_cameras.py 2>&1 | Tee-Object -FilePath "$APP\logs\scan.log" | Select-String -Pattern 'Prov.veis c.meras|Sem porta 554|Traceback|Error' | ForEach-Object { Write-Host "  $_" }
  if (-not (Test-Path "$APP\scan\cameras.json")) { Aviso "a varredura falhou (veja $APP\logs\scan.log); usando os IPs conhecidos" }
  & $PY -X utf8 setup_cameras.py --senha-arquivo $senhaF
  Pop-Location
  if (-not (Test-Path "$APP\go2rtc.yaml")) { Falha "nao gerou a configuracao das cameras" }
  SoAdmins "$APP\go2rtc.yaml"

  # gravador.env (so cria na primeira vez; teto de disco automatico)
  if (-not (Test-Path "$APP\gravador.env")) {
    $livre = [math]::Floor((Get-PSDrive -Name ($APP.Substring(0,1))).Free / 1GB)
    $cap  = [math]::Max(5, [math]::Min(500, [math]::Floor($livre * 0.6) - 5))
    $piso = [math]::Max(5, [math]::Min(20, [math]::Floor($livre / 10)))
    @(
      "# Ajustes do gravador (depois de editar, rode 'Reconfigurar cameras')",
      "REC_STREAM=sub",
      "CAP_GB=$cap",
      "FREE_FLOOR_GB=$piso",
      "RETENTION_HOURS=168",
      "GRACE_HOURS=2",
      "MOTION_THRESHOLD=0.8",
      "FFMPEG=$APP\bin\ffmpeg.exe",
      "FFPROBE=$APP\bin\ffprobe.exe"
    ) | Set-Content -Path "$APP\gravador.env" -Encoding ASCII
    Ok "gravacao: teto $cap GB (livre agora: $livre GB), guarda 7 dias"
  }

  # ---------- 7) tarefa que liga tudo no boot ----------
  Etapa "7/9 Ligando no boot"
  try {
    Unregister-ScheduledTask -TaskName $TN -Confirm:$false -ErrorAction SilentlyContinue
    $act = New-ScheduledTaskAction -Execute $PY -Argument "-X utf8 `"$APP\supervisor.py`"" -WorkingDirectory $APP
    $t1  = New-ScheduledTaskTrigger -AtStartup
    $t2  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $pr  = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $st  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
             -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    try {
      Register-ScheduledTask -TaskName $TN -Action $act -Trigger $t1, $t2 -Principal $pr -Settings $st -Force -ErrorAction Stop | Out-Null
    } catch {
      Aviso "vigia a cada 5 min nao aceito ($($_.Exception.Message)); usando so o gatilho de boot"
      Register-ScheduledTask -TaskName $TN -Action $act -Trigger $t1 -Principal $pr -Settings $st -Force -ErrorAction Stop | Out-Null
    }
    Start-ScheduledTask -TaskName $TN -ErrorAction Stop
    Ok "sistema ligado (sobe sozinho quando o notebook liga, sem precisar logar)"
  } catch { Falha "nao consegui criar a tarefa de inicializacao: $($_.Exception.Message)" }

  # ---------- 8) notebook como servidor ----------
  Etapa "8/9 Notebook como servidor"
  & powercfg /change standby-timeout-ac 0 2>&1 | Out-Null
  & powercfg /change standby-timeout-dc 0 2>&1 | Out-Null
  & powercfg /change hibernate-timeout-ac 0 2>&1 | Out-Null
  & powercfg /change hibernate-timeout-dc 0 2>&1 | Out-Null
  & powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>&1 | Out-Null
  & powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>&1 | Out-Null
  & powercfg /setactive SCHEME_CURRENT 2>&1 | Out-Null
  Ok "nao dorme mais (nem fechando a tampa)"
  try {
    Get-NetFirewallRule -DisplayName 'Mercadinho*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName 'Mercadinho - painel e video (so Tailscale)' -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 8099, 1984, 8555 -RemoteAddress '100.64.0.0/10' -Profile Any -ErrorAction Stop | Out-Null
    New-NetFirewallRule -DisplayName 'Mercadinho - WebRTC (so Tailscale)' -Direction Inbound -Action Allow `
      -Protocol UDP -LocalPort 8555 -RemoteAddress '100.64.0.0/10' -Profile Any -ErrorAction Stop | Out-Null
    Ok "firewall: o painel so abre pelo Tailscale (na rede da loja fica fechado)"
  } catch { Aviso "nao consegui criar a regra de firewall: $($_.Exception.Message)" }

  # atalhos na area de trabalho (de todos os usuarios)
  try {
    $desk = [Environment]::GetFolderPath('CommonDesktopDirectory')
    Set-Content -Path (Join-Path $desk 'Painel das Cameras.url') -Value "[InternetShortcut]`r`nURL=http://localhost:8099/" -Encoding ASCII
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path $desk 'Reconfigurar cameras.lnk'))
    $lnk.TargetPath = "$APP\reconfigurar-auto.bat"; $lnk.WorkingDirectory = $APP; $lnk.Save()
    Ok "atalhos 'Painel das Cameras' e 'Reconfigurar cameras' na area de trabalho"
  } catch { Aviso "nao criei os atalhos" }

  # ---------- 9) Tailscale ----------
  Etapa "9/9 Acesso de fora (Tailscale)"
  $ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
  if (-not (Test-Path $ts)) {
    $msi = Join-Path $env:TEMP 'tailscale.msi'
    $urls = @('https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi',
              'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.4-amd64.msi')
    if (Baixar $urls $msi 1000000) {
      Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    } else {
      Aviso "nao baixei o Tailscale; tentando pelo winget..."
      & winget install -e --id Tailscale.Tailscale --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    }
    Start-Sleep 8
  }
  if (Test-Path $ts) {
    & $ts status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $o = Join-Path $env:TEMP 'ts-up.out'; $e = Join-Path $env:TEMP 'ts-up.err'
      Remove-Item $o, $e -ErrorAction SilentlyContinue
      $p = Start-Process -FilePath $ts -ArgumentList 'up', '--unattended', '--hostname=mercadinho-cameras' `
             -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
      $url = $null
      for ($i = 0; $i -lt 60 -and -not $url; $i++) {
        Start-Sleep 1
        $txt = ((Get-Content $o, $e -Raw -ErrorAction SilentlyContinue) -join "`n")
        if ($txt -match 'https://login\.tailscale\.com/\S+') { $url = $Matches[0] }
        if ($p.HasExited) { break }
      }
      if ($url) {
        Write-Host ""
        Write-Host "  Abrindo o login do Tailscale no navegador. Entre (pode ser com Google)" -ForegroundColor Yellow
        Write-Host "  e clique em Connect. Link: $url" -ForegroundColor Yellow
        Start-Process $url
      }
      Write-Host "  aguardando voce entrar no Tailscale (ate 10 min)..."
      for ($i = 0; $i -lt 120; $i++) {
        & $ts status 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep 5
      }
    }
    & $ts status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Ok "Tailscale conectado"
      & schtasks /End /TN $TN 2>&1 | Out-Null; Start-Sleep 3; & schtasks /Run /TN $TN 2>&1 | Out-Null   # pega o IP do Tailscale
    } else { Aviso "Tailscale ainda nao conectado. Abra o Tailscale (icone perto do relogio) e faca login." }
  } else { Aviso "Tailscale nao instalou. Baixe em tailscale.com/download e faca login." }

  # ---------- resumo ----------
  Etapa "Pronto!"
  Start-Sleep 15
  $stf = "$APP\logs\status.json"
  if (Test-Path $stf) {
    $stj = Get-Content $stf -Raw | ConvertFrom-Json
    foreach ($pp in $stj.processos.PSObject.Properties) {
      $estado = 'parado'; if ($pp.Value.rodando) { $estado = 'rodando' }
      Write-Host ("  {0,-16} {1}" -f $pp.Name, $estado)
    }
  } else { Aviso "o sistema ainda esta subindo (status em $stf)" }
  $tsname = $null
  if (Test-Path $ts) {
    try { $tsname = ((& $ts status --json 2>$null | Out-String) | ConvertFrom-Json).Self.DNSName.TrimEnd('.') } catch {}
  }
  Write-Host ""
  Write-Host "  Neste notebook:        http://localhost:8099" -ForegroundColor Green
  if ($tsname) { Write-Host "  De qualquer lugar:     http://$($tsname):8099   (no celular/PC com Tailscale)" -ForegroundColor Green }
  Write-Host "  Se as cameras mudarem de IP: atalho 'Reconfigurar cameras' na area de trabalho."
  Write-Host "  Registro desta instalacao: $APP\logs\instalacao.log"
  Start-Process 'http://localhost:8099/'
  try { Stop-Transcript | Out-Null } catch {}
  exit 0
}
