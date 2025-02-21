# koishi-plugin-best-cave

[![npm](https://img.shields.io/npm/v/koishi-plugin-best-cave?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-best-cave)

## 简介

最好的 cave 插件，可开关的审核系统，可引用添加，支持图文混合内容，可查阅投稿列表，完美复刻你的 .cave 体验！

### 核心功能

- **内容管理**
  - 支持文字与图片混合保存，自动保持布局顺序
  - 视频内容单独发送，支持多种格式
  - 自动文本格式化与排版
  - 引用消息自动解析和保存
  - 支持引用已有内容的布局

- **重复检测**
  - 独立的文本与图片查重开关
  - 可配置的文本相似度阈值
  - 可配置的图片相似度阈值
  - 基于感知哈希的图片查重
  - 基于MD5的精确查重
  - 精确重复自动拒绝
  - 相似内容提示预览

- **审核机制**
  - 可配置的审核开关与多级权限
  - 完整的黑白名单系统（支持用户/群组/频道）
  - 白名单用户自动跳过审核
  - 支持单条和批量审核操作
  - 拒绝审核时自动清理媒体文件
  - 审核消息自动通知管理员

- **媒体处理**
  - 智能处理多种类型媒体链接
  - 支持本地图片上传和URL引用
  - 自动文件大小检查与限制
  - 视频内容自动单独发送
  - MD5文件名防重复
  - 自动清理无效媒体

- **使用体验**
  - 基于群组的调用冷却机制
  - 管理员操作不受冷却限制
  - 支持按页浏览投稿记录
  - 支持按用户ID查询统计
  - 临时消息自动清理
  - 错误提示自动消失

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
| enableImageDuplicate | boolean | true | 是否启用图片查重 |
| imageDuplicateThreshold | number | 0.8 | 图片查重阈值(0-1) |
| enableTextDuplicate | boolean | true | 是否启用文本查重 |
| textDuplicateThreshold | number | 0.9 | 文本查重阈值(0-1) |
| allowVideo | boolean | true | 是否允许视频 |
| videoMaxSize | number | 16 | 视频大小限制(MB) |
| enablePagination | boolean | false | 是否启用分页 |
| itemsPerPage | number | 10 | 每页显示条数 |
| blacklist | string[] | [] | 黑名单用户/群组ID |
| whitelist | string[] | [] | 白名单用户/群组ID |

### 注意事项

1. 图片和视频会自动保存到本地，请确保存储空间充足
2. 管理员不受群组冷却时间限制且可查看所有用户统计
3. 开启审核模式后，白名单内的用户/群组/频道可直接投稿
4. 引用消息添加时会保留原消息的格式与布局顺序
5. 支持两种重复检测机制：
   - 基于MD5的精确查重
   - 基于感知哈希的相似度查重
6. 黑名单中的用户无法使用任何功能
7. 支持按页码和用户ID查看投稿统计
8. 临时消息（如错误提示）会在10秒后自动消失
9. 视频内容会单独发送以保证正常显示
10. 支持自动清理被拒绝或删除的媒体文件
