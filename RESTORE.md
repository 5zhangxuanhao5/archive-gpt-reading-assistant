# GPT阅读助手恢复开发

根目录是1.5.2的完整Chrome/Edge扩展，可直接作为未打包扩展加载；vendor包含可用的编辑器/KaTeX资源。修改编辑器时进入development，准备Node/npm，执行 `npm ci`、`node build.mjs`；package-lock.json固定依赖。没有node_modules缓存不影响取回源代码，首次重建需下载公开npm依赖。

native/yueji_host.py及安装/卸载脚本使用Python3；在新电脑需要由本人重新运行native安装程序登记NativeMessaging，并重新授权浏览器扩展。固定扩展公钥保留，不能把用户生成的私钥或账号令牌放入项目。

个人笔记数据库、选定目录、浏览器历史缓存/登录状态不在源码包内，应单独保管。补充开发测试和历史说明位于archive-development-projects的projects/reading-assistant-development-tools与reading-assistant-extra-notes，主源继续开发不依赖旧历史目录。
