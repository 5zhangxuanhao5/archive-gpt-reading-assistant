from pathlib import Path
for browser in ('Microsoft Edge', 'Google/Chrome'):
    host = Path.home() / 'Library/Application Support' / browser / 'NativeMessagingHosts/com.yueji.notes.json'
    host.unlink(missing_ok=True)
print('Edge 和 Chrome 的本地组件注册已移除；笔记文件夹、共享缓存和已选位置均已保留。')
