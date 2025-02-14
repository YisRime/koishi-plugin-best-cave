# koishi-plugin-best-cave

[![npm](https://img.shields.io/npm/v/koishi-plugin-best-cave?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-best-cave)

## 简介

最好的 cave 插件，可开关的审核系统，可引用添加，支持图文混合内容，可查阅投稿列表，完美复刻你的 .cave 体验！

### 核心功能

- 支持文字与图片混合保存
- 智能处理各类图片与视频链接
- 内容智能排序，保持原始布局
- 完整的权限管理系统
- 可选的内容审核流程
- 群组调用冷却机制
- 重复内容智能检测
- 黑白名单系统
- 分页显示支持

### 指令

| 指令 | 说明 | 权限 |
|------|------|------|
| `cave` | 随机展示一条回声洞 | 所有人 |
| `cave -a <内容>` | 添加新回声洞（支持文字、图片与视频） | 所有人 |
| `cave -g <编号>` | 查看指定回声洞 | 所有人 |
| `cave -r <编号>` | 删除指定回声洞 | 内容贡献者/管理员 |
| `cave -l [页码/用户ID]` | 查看投稿统计 | 所有人(仅自己)/管理员(全部) |

#### 管理指令

| 指令 | 说明 | 权限 |
|------|------|------|
| `cave -p <编号/all>` | 通过待审核内容 | 管理员 |
| `cave -d <编号/all>` | 拒绝待审核内容 | 管理员 |

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| manager | string[] | [] | 管理员用户ID列表 |
| number | number | 60 | 冷却时间(秒) |
| enableAudit | boolean | false | 是否启用审核 |
| imageMaxSize | number | 4 | 图片大小限制(MB) |
| duplicateThreshold | number | 0.8 | 图片查重阈值(0-1) |
| allowVideo | boolean | true | 是否允许视频 |
| videoMaxSize | number | 16 | 视频大小限制(MB) |
| enablePagination | boolean | false | 是否启用分页 |
| itemsPerPage | number | 10 | 每页显示条数 |
| blacklist | string[] | [] | 黑名单用户/群组ID |
| whitelist | string[] | [] | 白名单用户/群组ID |

### 注意事项

1. 图片和视频会自动保存到本地，请确保存储空间充足
2. 管理员不受群组冷却时间限制
3. 开启审核模式后，白名单内的用户可直接投稿
4. 引用消息添加时会保留原消息的格式与布局
5. 支持自动检测重复图片内容，可通过阈值调整严格程度
6. 黑名单中的用户无法使用任何功能
7. 支持按页码查看投稿统计，提升大量数据的浏览体验
