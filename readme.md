# koishi-plugin-best-cave

[![npm](https://img.shields.io/npm/v/koishi-plugin-best-cave?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-best-cave)

功能最强的 cave 插件，支持黑白名单、审核与自动查重，人性化的添加方式，可添加图文甚至视频，可查阅投稿列表，完善的 ID 管理与 Hash 校验机制，比你听过的任何 cave 都强！

## 功能亮点

- 支持文字、图片与视频内容
- 审核与自动查重机制
- 黑白名单管理
- 完善的用户统计

## 核心功能

- **内容管理**
  - 文字与图片混合保存，自动保持布局顺序
  - 视频内容单独发送，支持多种格式
  - 自动文本格式化与排版
  - 引用消息自动解析和保存

- **重复检测**
  - 基于感知哈希的图片查重
  - 基于MD5的精确查重
  - 相似内容提示预览

- **审核机制**
  - 完整的黑白名单系统
  - 白名单用户自动跳过审核
  - 拒绝审核时自动清理媒体文件

- **媒体处理**
  - 智能处理多种类型媒体链接
  - 支持本地图片上传和URL引用
  - 自动文件大小检查与限制

## 指令说明

### 基础指令

| 指令 | 示例 | 说明 |
|------|------|------|
| `cave` | `cave` | 随机抽取一条回声洞 |
| `cave -a` | `cave -a 内容` | 添加新回声洞 |
| `cave -g` | `cave -g 123` | 查看指定编号回声洞 |
| `cave -r` | `cave -r 123` | 删除指定回声洞 |
| `cave -l` | `cave -l 2` 或 `cave -l 114514` | 查看统计或指定用户投稿 |

### 审核指令 (仅管理员)

| 指令 | 示例 | 说明 |
|------|------|------|
| `cave.pass` | `cave.pass 123` 或 `cave.pass all` | 通过指定/所有待审核内容 |
| `cave.reject` | `cave.reject 123` 或 `cave.reject all` | 拒绝指定/所有待审核内容 |

## 配置说明

### 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| manager | string[] | [] | 管理员ID列表 |
| number | number | 60 | 冷却时间(秒) |
| enablePagination | boolean | false | 启用统计分页 |
| itemsPerPage | number | 10 | 每页显示数目 |

### 权限管理

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| enableAudit | boolean | false | 启用审核机制 |
| blacklist | string[] | [] | 黑名单(用户) |
| whitelist | string[] | [] | 白名单(用户/群组/频道) |

### 查重配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| enableTextDuplicate | boolean | true | 启用文本查重 |
| textDuplicateThreshold | number | 0.9 | 文本相似度阈值 |
| enableImageDuplicate | boolean | true | 启用图片查重 |
| imageDuplicateThreshold | number | 0.8 | 图片相似度阈值 |

### 媒体配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| imageMaxSize | number | 4 | 图片最大大小(MB) |
| allowVideo | boolean | true | 允许视频上传 |
| videoMaxSize | number | 16 | 视频最大大小(MB) |

## 注意事项

1. 图片和视频会自动保存到本地，请确保存储空间充足
2. 管理员不受群组冷却时间限制且可查看所有用户统计
3. 开启审核模式后，白名单内的用户可直接投稿
4. 支持两种重复检测机制：
   - 基于MD5的精确查重
   - 基于感知哈希的相似度查重
5. 临时消息（如错误提示）会在10秒后自动消失
6. 视频内容会单独发送以保证正常显示
7. 支持自动清理被拒绝或删除的媒体文件
