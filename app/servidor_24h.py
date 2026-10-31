#!/usr/bin/env python3
# servidor_24h.py — Windows: deixa o notebook configurado para ficar ligado 24h como servidor.
# Roda elevado (pede o "Sim" do Windows), sem janela, e escreve o relatório em logs\servidor_24h.log.
#  - nunca suspender/hibernar (tomada e bateria); tampa fechada não faz nada
#  - hibernação desligada (também desliga a "inicialização rápida")
#  - disco e Wi-Fi sem economia de energia (Wi-Fi em desempenho máximo)
#  - Windows Update: sem reinício automático com usuário logado + horário ativo 06h-00h
#  - tela pode apagar normalmente (10 min) — não afeta o sistema
import os, sys, subprocess, ctypes, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "logs", "servidor_24h.log")
NOWIN = 0x08000000

def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")

def run(args, show=True):
    r = subprocess.run(args, capture_output=True, timeout=60, creationflags=NOWIN)
    out = ((r.stdout or b"") + (r.stderr or b"")).decode("cp850", "replace").strip()
    status = "OK " if r.returncode == 0 else f"ERRO({r.returncode}) "
    log(f"  {status}{' '.join(args)}" + (f" -> {out[:200]}" if out and (show or r.returncode) else ""))
    return r.returncode == 0, out

def main():
    os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
    try: admin = ctypes.windll.shell32.IsUserAnAdmin()
    except Exception: admin = False
    if not admin:
        exe = sys.executable.replace("python.exe", "pythonw.exe")
        ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, f'-X utf8 "{os.path.abspath(__file__)}"', HERE, 0)
        return
    log("===== servidor 24h: início =====")
    P = "powercfg"
    log("[1/5] nunca suspender / hibernar / desligar disco; tampa não faz nada")
    for a in ("standby-timeout-ac 0", "standby-timeout-dc 0", "hibernate-timeout-ac 0", "hibernate-timeout-dc 0",
              "disk-timeout-ac 0", "disk-timeout-dc 0", "monitor-timeout-ac 10", "monitor-timeout-dc 10"):
        run([P, "/change", *a.split()], show=False)
    for sub, val in (("SUB_BUTTONS LIDACTION", "0"),):
        run([P, "/setacvalueindex", "SCHEME_CURRENT", *sub.split(), val], show=False)
        run([P, "/setdcvalueindex", "SCHEME_CURRENT", *sub.split(), val], show=False)
    # suspensão híbrida e "dormir depois de N min" (sub_sleep): 0 = nunca
    run([P, "/setacvalueindex", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE", "0"], show=False)
    run([P, "/setdcvalueindex", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE", "0"], show=False)
    run([P, "/setacvalueindex", "SCHEME_CURRENT", "SUB_SLEEP", "HIBERNATEIDLE", "0"], show=False)
    run([P, "/setdcvalueindex", "SCHEME_CURRENT", "SUB_SLEEP", "HIBERNATEIDLE", "0"], show=False)
    # modo de espera moderno: "ao desconectar tomada, não dormir" (quando existir)
    run([P, "/setacvalueindex", "SCHEME_CURRENT", "SUB_SLEEP", "UNATTENDSLEEP", "0"], show=False)
    run([P, "/setdcvalueindex", "SCHEME_CURRENT", "SUB_SLEEP", "UNATTENDSLEEP", "0"], show=False)

    log("[2/5] hibernação desligada (desliga também a inicialização rápida)")
    run([P, "/hibernate", "off"])

    log("[3/5] Wi-Fi em desempenho máximo (sem economia de energia) e sem suspensão seletiva USB")
    WIFI = "19cbb8fa-5279-450e-9fac-8a3d5fedd0c1"; WIFI_MODE = "12bbebe6-58d6-4636-95bb-3217ef867c1a"
    run([P, "/setacvalueindex", "SCHEME_CURRENT", WIFI, WIFI_MODE, "0"])
    run([P, "/setdcvalueindex", "SCHEME_CURRENT", WIFI, WIFI_MODE, "0"])
    USB = "2a737441-1930-4402-8d77-b2bebba308a3"; USB_SEL = "48e6b7a6-50f5-4782-a5d4-53bb50f7e206"
    run([P, "/setacvalueindex", "SCHEME_CURRENT", USB, USB_SEL, "0"], show=False)
    run([P, "/setdcvalueindex", "SCHEME_CURRENT", USB, USB_SEL, "0"], show=False)
    # placa de rede: desmarca "permitir que o computador desligue este dispositivo"
    ps = ("Get-NetAdapter -Physical | ForEach-Object { try { Disable-NetAdapterPowerManagement -Name $_.Name "
          "-NoRestart -ErrorAction Stop; \"$($_.Name): gerenciamento de energia desligado\" } catch { \"$($_.Name): $($_.Exception.Message)\" } }")
    run(["powershell", "-NoProfile", "-Command", ps])
    run([P, "/setactive", "SCHEME_CURRENT"], show=False)

    log("[4/5] Windows Update: não reiniciar sozinho com usuário logado; horário ativo 06h-00h")
    R = "reg"
    run([R, "add", r"HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU", "/v", "NoAutoRebootWithLoggedOnUsers", "/t", "REG_DWORD", "/d", "1", "/f"], show=False)
    run([R, "add", r"HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU", "/v", "AUOptions", "/t", "REG_DWORD", "/d", "3", "/f"], show=False)  # baixa, avisa antes de instalar
    run([R, "add", r"HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings", "/v", "ActiveHoursStart", "/t", "REG_DWORD", "/d", "6", "/f"], show=False)
    run([R, "add", r"HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings", "/v", "ActiveHoursEnd", "/t", "REG_DWORD", "/d", "0", "/f"], show=False)
    run([R, "add", r"HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings", "/v", "SmartActiveHoursState", "/t", "REG_DWORD", "/d", "0", "/f"], show=False)

    log("[5/5] conferência")
    ok, out = run([P, "/a"], show=False)
    log("  estados de suspensão disponíveis:\n    " + out.replace("\n", "\n    "))
    ok, out = run([P, "/query", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION"], show=False)
    import re
    vals = re.findall(r"(?:CA|AC|CC|DC)[^\n]*?:\s*0x([0-9a-f]+)", out, re.I)
    log(f"  tampa (AC/DC) = {vals}  (0 = não faz nada)")
    log("===== servidor 24h: fim =====")
    log("Lembrete: na BIOS, ative 'Restore on AC Power Loss' / 'Power On After Power Failure' para ligar sozinho depois de queda de luz; essa opção só existe na BIOS.")

if __name__ == "__main__":
    try: main()
    except Exception as e: log(f"ERRO: {type(e).__name__}: {e}")
