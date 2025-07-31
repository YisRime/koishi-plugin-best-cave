# koishi-plugin-best-cave

[![npm](https://img.shields.io/npm/v/koishi-plugin-best-cave?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-best-cave)

一款功能强大且灵活的回声洞插件，支持丰富的媒体类型、可插拔的功能模块和双重存储后端（本地或 S3）。

## ✨ 功能亮点

- **丰富的媒体支持**：不止于文本，轻松发布包含图片、视频、音频甚至文件的混合内容。插件会自动处理消息引用，解析并保存其内容。
- **双重存储后端**：可根据需求选择将媒体文件存储在 **本地服务器** (`data/cave` 目录) 或 **AWS S3** 兼容的云端对象存储中，便于扩展和管理。
- **可选的审核机制**：可开启审核模式 (`enableReview`)。开启后，所有新提交的内容都需要管理员审核通过才会进入公共池，确保内容质量。
- **作用域隔离**：通过 `perChannel` 配置，可设定回声洞是在所有群聊中共享（全局模式），还是在每个群聊中独立（分群模式）。
- **用户身份定制**：当 `enableProfile` 开启时，用户可以为自己在回声洞中的发言设置一个专属昵称。
- **便捷的数据管理**：管理员可以通过指令轻松地将所有回声洞数据导出为 `JSON` 文件备份，或从文件中恢复数据，迁移无忧 (`enableDataIO`)。
- **完善的权限控制**：通过 `adminUsers` 列表指定管理员，只有管理员才能执行审核、数据迁移和删除任意投稿等高级操作。

## 📖 指令说明

### 核心指令

| 指令 | 别名/选项 | 说明 |
| :--- | :--- | :--- |
| `cave` | | 随机查看一条回声洞。 |
| `cave.add <内容>` | `cave -a <内容>` | 添加一条新的回声洞。可以直接在指令后跟内容，也可以回复或引用一条消息来添加。 |
| `cave.view <序号>` | `cave -g <序号>` | 查看指定序号的回声洞。 |
| `cave.del <序号>` | `cave -r <序号>` | 删除指定序号的回声洞。仅投稿人或管理员可操作。 |
| `cave.list` | `cave -l` | 查询并列出自己投稿过的所有回声洞序号。 |

### 模块化指令

这些指令只有在配置中启用了相应功能后才可用。

| 指令 | 所需配置 | 说明 |
| :--- | :--- | :--- |
| `cave.profile [昵称]` | `enableProfile: true` | 设置你在回声洞中显示的昵称。若不提供昵称，则清除设置。 |
| `cave.review` | `enableReview: true` | **(仅管理员)** 列出所有待审核的回声洞。 |
| `cave.review <序号>` | `enableReview: true` | **(仅管理员)** 查看指定待审核内容的详情。 |
| `cave.review <序号> <Y/N>` | `enableReview: true` | **(仅管理员)** 审核指定内容。`Y` (或 `yes`, `pass`) 表示通过，`N` (或 `no`, `reject`) 表示拒绝。 |
| `cave.export` | `enableDataIO: true` | **(仅管理员)** 将所有回声洞数据导出到 `cave_export.json` 文件中。 |
| `cave.import` | `enableDataIO: true` | **(仅管理员)** 从 `cave_import.json` 文件中导入数据。 |

## ⚙️ 配置说明

插件配置分为三个部分：基础配置、审核配置和存储配置。

### 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `cooldown` | `number` | `10` | 指令冷却时间（秒）。管理员不受此限制。 |
| `perChannel` | `boolean` | `false` | 是否启用分群模式。`true` 表示每个群的回声洞独立，`false` 表示所有群共享一个回声洞池。 |
| `adminUsers` | `string[]` | `[]` | 管理员的用户 ID 列表。 |
| `enableProfile` | `boolean` | `false` | 是否启用自定义昵称功能 (`cave.profile` 指令)。 |
| `enableDataIO` | `boolean` | `false` | 是否启用数据导入/导出功能 (`cave.export` / `.import` 指令)。 |

### 审核配置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enableReview` | `boolean` | `false` | 是否启用审核机制。启用后，新投稿将进入待审核状态，并由管理员使用 `cave.review` 指令处理。 |

### 存储配置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enableS3` | `boolean` | `false` | 是否启用 S3 存储。若为 `false`，所有媒体文件将保存在本地 `data/cave` 目录下。 |
| `endpoint` | `string` | | **(S3 必填)** S3 兼容存储的 Endpoint URL。 |
| `bucket` | `string` | | **(S3 必填)** S3 存储桶 (Bucket) 名称。 |
| `region` | `string` | `'auto'` | **(S3 可选)** S3 区域 (Region)。 |
| `publicUrl` | `string` | | **(S3 可选)** S3 存储桶的公共访问 URL。如果提供，插件将直接用此 URL 拼接文件名来访问资源，否则将尝试使用 Base64 格式发送媒体。 |
| `accessKeyId` | `string` | | **(S3 必填)** S3 访问密钥 ID。 |
| `secretAccessKey` | `string` | | **(S3 必填)** S3 秘密访问密钥。 |

## ⚠️ 注意事项

1. **文件存储**：所有媒体文件（图片、视频等）会根据配置保存在本地 `data/cave` 目录或 S3 存储桶中。请确保 Koishi 拥有对本地目录的读写权限，或 S3 配置正确无误。
2. **S3 公共访问**：如果启用了 S3 并配置了 `publicUrl`，请确保该 URL 指向的存储桶策略允许公共读取，否则媒体文件将无法正常显示。
3. **删除机制**：删除操作（`cave.del` 或审核拒绝）并非立即从数据库和文件系统中移除。内容会被标记为 `delete` 状态，并在后台任务中被异步清理，以避免阻塞当前指令的响应。
4. **数据导入/导出**：导入功能会读取插件工作目录下的 `cave_import.json` 文件。请在执行导入指令前，将数据文件放置在正确位置。导出会生成 `cave_export.json`。
