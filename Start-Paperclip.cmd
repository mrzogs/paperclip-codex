@echo off
setlocal
cd /d D:\Paperclip-codex
"C:\Program Files\nodejs\corepack.cmd" pnpm paperclipai run --data-dir "D:\Paperclip-codex\.paperclip-home" --bind loopback
