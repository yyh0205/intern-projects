# 上传部署说明

这是一个 Node.js 项目，不是单独的静态 HTML 页面。请在支持 Node.js 18+ 的平台上传此 ZIP。

- 启动命令：`npm start`
- 健康检查：`/health`
- 后台首页：部署域名根路径 `/`
- 签到页面：从后台生成二维码进入

后台无需密码，打开根路径即可直接管理。

## 环境变量

- `FEISHU_APP_ID`：飞书应用 App ID
- `FEISHU_APP_SECRET`：飞书应用 App Secret
- `PUBLIC_BASE_URL`：可选。平台没有正确转发公开域名时，填写实际部署地址，例如 `https://你的域名/你的项目路径`
- `PUBLIC_BASE_PATH`：可选。平台没有通过 `X-Forwarded-Prefix` 转发路径前缀时，填写实际项目路径，例如 `/cw/你的项目名`
- `PORT`：平台通常会自动提供，不需要手动填写

请为项目开启持久化磁盘并挂载到项目的 `work/` 目录，用于保存活动数据、名单、奖品和上传文件。
