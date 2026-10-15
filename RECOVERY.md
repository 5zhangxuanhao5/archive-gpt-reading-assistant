# 恢复开发入口

完整恢复源码包、校验清单：[recovery-complete-2026-10-16](https://github.com/He-He-He-He-He-He/archive-development-projects/releases/tag/recovery-complete-2026-10-16)。这些是私有仓库，下载前需登录本人的 GitHub 账号。

下载对应工程的 `*-recovery-source-2026-10-16.zip` 并完整解压，在解压根运行 `python3 verify-source.py`，再按工程内 `RESTORE.md` 安装开发环境并构建。
源码包不包含整套 SDK/编译器、可重建缓存、用户登录会话和签名私钥。平台 SDK 及普通依赖按固定版本/锁文件安装；原发行身份需要本人另存的密钥。

本轮工程：

- [gpt-reading-assistant](./) — `gpt-reading-assistant-recovery-source-2026-10-16.zip`。
