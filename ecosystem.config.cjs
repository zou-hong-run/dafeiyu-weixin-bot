// pm2 配置。用法：
//   pm2 start ecosystem.config.cjs
//   pm2 logs dafeiyu
//   pm2 restart dafeiyu
//
// 名字要和 restart_self 用的 PM2_APP_NAME 一致，否则机器人自己重启不了自己。

module.exports = {
  apps: [
    {
      name: 'dafeiyu',
      script: 'src/index.js',
      cwd: __dirname,

      // 必须是 1。同一个微信号只能有一个进程在长轮询，
      // 多开会让两边互相覆盖游标——消息偶尔不回或回两遍，日志还都正常。
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      // 连续崩溃超过这个次数就停下（errored），别无限重启刷日志。
      // 真崩了先 pm2 logs 看原因，修好再 pm2 restart。
      max_restarts: 10,
      restart_delay: 5000,
      // 进程活过这个时间才重置重启计数，避免「慢慢崩」被算成快速崩溃
      min_uptime: 30000,

      // 定时任务用本地时间，服务器默认 UTC 的话「早上 8:30」会变北京时间 16:30
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
      },

      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,

      // 不设 watch：改代码后自己决定什么时候重启。
      // 开着 watch 的话机器人改一个文件就触发重启，改到一半的代码会把进程带下去。
      watch: false,
    },
  ],
}
