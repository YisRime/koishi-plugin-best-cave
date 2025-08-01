import { Context, Schema, Logger, h } from 'koishi'
import { FileManager } from './FileManager'
import { ProfileManager } from './ProfileManager'
import { DataManager } from './DataManager'
import { ReviewManager } from './ReviewManager'
import * as utils from './Utils'

export const name = 'best-cave'
export const inject = ['database']

// 插件使用说明
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>

<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`
const logger = new Logger('best-cave');

// --- 数据类型定义 (Data Type Definitions) ---

/**
 * 存储在数据库中的单个消息元素。
 * @property type - 元素类型。
 * @property content - 文本内容，仅用于 'text' 类型。
 * @property file - 文件标识符（本地文件名或 S3 Key），用于媒体类型。
 */
export interface StoredElement {
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  content?: string;
  file?: string;
}

/**
 * 数据库中 `cave` 表的完整对象模型。
 * @property id - 回声洞的唯一数字 ID。
 * @property elements - 构成回声洞内容的元素数组。
 * @property channelId - 提交回声洞的频道 ID，若为私聊则为 null。
 * @property userId - 提交用户的 ID。
 * @property userName - 提交用户的昵称。
 * @property status - 回声洞状态: 'active' (活跃), 'delete' (待删除), 'pending' (待审核)。
 * @property time - 提交时间。
 */
export interface CaveObject {
  id: number
  elements: StoredElement[]
  channelId: string
  userId: string
  userName: string
  status: 'active' | 'delete' | 'pending'
  time: Date
}

// 扩展 Koishi 的数据库表接口，以获得 'cave' 表的类型提示。
declare module 'koishi' {
  interface Tables {
    cave: CaveObject
  }
}

// --- 插件配置 (Plugin Configuration) ---

/**
 * 插件的配置接口。
 */
export interface Config {
  coolDown: number
  perChannel: boolean
  adminUsers: string[]
  enableProfile: boolean
  enableIO: boolean
  enableReview: boolean
  caveFormat: string
  localPath?: string
  enableS3: boolean
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  bucket?: string
  publicUrl?: string
}

/**
 * 使用 Koishi Schema 定义插件的配置项，用于生成配置界面。
 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    coolDown: Schema.number().default(10).description("冷却时间（秒）"),
    perChannel: Schema.boolean().default(false).description("启用分群模式"),
    enableProfile: Schema.boolean().default(false).description("启用自定义昵称"),
    enableIO: Schema.boolean().default(false).description("启用导入导出"),
    caveFormat: Schema.string().default('回声洞 ——（{id}）|—— {name}').description('自定义文本'),
    adminUsers: Schema.array(Schema.string()).default([]).description("管理员 ID 列表"),
  }).description("基础配置"),
  Schema.object({
    enableReview: Schema.boolean().default(false).description("启用审核"),
  }).description('审核配置'),
  Schema.object({
    localPath: Schema.string().description('文件映射路径'),
    enableS3: Schema.boolean().default(false).description("启用 S3 存储"),
    publicUrl: Schema.string().description('公共访问 URL').role('link'),
    endpoint: Schema.string().description('端点 (Endpoint)').role('link'),
    bucket: Schema.string().description('存储桶 (Bucket)'),
    region: Schema.string().default('auto').description('区域 (Region)'),
    accessKeyId: Schema.string().description('Access Key ID').role('secret'),
    secretAccessKey: Schema.string().description('Secret Access Key').role('secret'),
  }).description("存储配置"),
]);

// --- 插件主逻辑 (Plugin Main Logic) ---

/**
 * 插件的入口函数。
 * @param ctx - Koishi 上下文。
 * @param config - 用户提供的插件配置。
 */
export function apply(ctx: Context, config: Config) {

  // 扩展 'cave' 数据表模型。
  ctx.model.extend('cave', {
    id: 'unsigned',       // 无符号整数，作为主键。
    elements: 'json',     // 存储为 JSON 字符串的元素数组。
    channelId: 'string',  // 频道 ID。
    userId: 'string',     // 用户 ID。
    userName: 'string',   // 用户昵称。
    status: 'string',     // 回声洞状态。
    time: 'timestamp',    // 提交时间。
  }, {
    primary: 'id', // 将 'id' 字段设置为主键。
  });

  // --- 初始化管理器 (Initialize Managers) ---

  const fileManager = new FileManager(ctx.baseDir, config, logger);
  const lastUsed = new Map<string, number>(); // 存储指令冷却时间戳，键为 channelId。

  let profileManager: ProfileManager;
  let dataManager: DataManager;
  let reviewManager: ReviewManager;

  // --- 指令定义 (Command Definitions) ---

  const cave = ctx.command('cave', '回声洞')
    .option('add', '-a <content:text> 添加回声洞')
    .option('view', '-g <id:posint> 查看指定回声洞')
    .option('delete', '-r <id:posint> 删除指定回声洞')
    .option('list', '-l 查询投稿统计')
    .usage('随机抽取一条已添加的回声洞。')
    .action(async ({ session, options }) => {
      if (options.add) return session.execute(`cave.add ${options.add}`);
      if (options.view) return session.execute(`cave.view ${options.view}`);
      if (options.delete) return session.execute(`cave.del ${options.delete}`);
      if (options.list) return session.execute('cave.list');

      const cdMessage = utils.checkCooldown(session, config, lastUsed);
      if (cdMessage) return cdMessage;

      try {
        // 获取当前作用域的查询条件（全局或本群）。
        const query = utils.getScopeQuery(session, config);
        // 只获取 ID 列表以提高性能。
        const candidates = await ctx.database.get('cave', query, { fields: ['id'] });

        if (candidates.length === 0) {
          return `当前${config.perChannel && session.channelId ? '本群' : ''}还没有任何回声洞`;
        }

        // 从候选列表中随机抽取一个 ID。
        const randomId = candidates[Math.floor(Math.random() * candidates.length)].id;
        // 获取该 ID 对应的完整回声洞数据。
        const [randomCave] = await ctx.database.get('cave', { ...query, id: randomId });

        // 更新冷却时间戳。
        utils.updateCooldownTimestamp(session, config, lastUsed);
        // 构建并返回消息。
        return utils.buildCaveMessage(randomCave, config, fileManager, logger);
      } catch (error) {
        logger.error('随机获取回声洞失败:', error);
        return '随机获取回声洞失败';
      }
    });

  // --- 注册子命令 (Register Subcommands) ---

  cave.subcommand('.add [content:text]', '添加回声洞')
    .usage('添加一条回声洞。可以直接发送内容，也可以回复或引用一条消息。')
    .action(async ({ session }, content) => {
      const savedFileIdentifiers: string[] = []; // 存储本次操作中保存的文件名，用于失败时回滚。
      try {
        let sourceElements: h[]; // 用来存储源消息的 h() 元素数组。

        if (session.quote?.elements) {
          // 优先使用引用的消息内容。
          sourceElements = session.quote.elements;
        } else if (content?.trim()) {
          // 其次使用指令后的文本内容。
          sourceElements = h.parse(content);
        } else {
          // 如果都没有，则提示用户输入。
          await session.send("请在一分钟内发送你要添加的内容");
          const reply = await session.prompt(60000); // 等待 60 秒。
          if (!reply) return "操作超时，已取消添加";
          sourceElements = h.parse(reply);
        }

        const scopeQuery = utils.getScopeQuery(session, config);
        const newId = await utils.getNextCaveId(ctx, scopeQuery);
        const finalElementsForDb: StoredElement[] = []; // 存储处理后待存入数据库的元素。
        let mediaIndex = 0; // 媒体文件计数器，用于生成唯一文件名。

        // 递归函数，用于遍历处理消息中的所有 h() 元素。
        async function traverseAndProcess(elements: h[]) {
          for (const el of elements) {
            const elementType = el.type as StoredElement['type'];

            // 处理媒体元素
            if (['image', 'video', 'audio', 'file'].includes(elementType) && el.attrs.src) {
              let fileIdentifier = el.attrs.src as string;
              // 如果 src 是网络链接，则下载。
              if (fileIdentifier.startsWith('http')) {
                mediaIndex++;
                const originalName = el.attrs.file as string;
                const savedId = await utils.downloadMedia(ctx, fileManager, fileIdentifier, originalName, elementType, newId, mediaIndex, session.channelId, session.userId);
                savedFileIdentifiers.push(savedId);
                fileIdentifier = savedId; // 更新文件标识符为保存后的名称。
              }
              finalElementsForDb.push({ type: elementType, file: fileIdentifier });
            } else if (elementType === 'text' && el.attrs.content?.trim()) {
              // 处理文本元素，忽略纯空白内容。
              finalElementsForDb.push({ type: 'text', content: el.attrs.content.trim() });
            }
            // 递归处理子元素。
            if (el.children) await traverseAndProcess(el.children);
          }
        }

        await traverseAndProcess(sourceElements);

        if (finalElementsForDb.length === 0) return "内容为空，已取消添加";

        let userName = session.username;
        // 如果启用了昵称功能，获取并使用自定义昵称。
        if (config.enableProfile) {
          userName = (await profileManager.getNickname(session.userId)) || userName;
        }

        // 构建新的回声洞对象。
        const newCave: CaveObject = {
          id: newId,
          elements: finalElementsForDb,
          channelId: session.channelId,
          userId: session.userId,
          userName: userName,
          status: config.enableReview ? 'pending' : 'active',
          time: new Date(),
        };
        await ctx.database.create('cave', newCave);

        // 如果需要审核，则发送通知给管理员。
        if (newCave.status === 'pending') {
          reviewManager.sendForReview(newCave);
          return `提交成功，序号为（${newCave.id}）`;
        }

        return `添加成功，序号为（${newId}）`;
      } catch (error) {
        logger.error('添加回声洞失败:', error);
        // 如果在处理过程中已经保存了文件，但最终失败了，则删除这些“孤儿”文件。
        if (savedFileIdentifiers.length > 0) {
          logger.info(`添加失败，回滚并删除 ${savedFileIdentifiers.length} 个文件...`);
          await Promise.all(savedFileIdentifiers.map(fileId => fileManager.deleteFile(fileId)));
        }
        return '添加失败，请稍后再试';
      }
    });

  // 子命令: cave.review
  cave.subcommand('.view <id:posint>', '查看指定回声洞')
    .usage('通过序号查看对应的回声洞。')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要查看的回声洞序号';

      const cdMessage = utils.checkCooldown(session, config, lastUsed);
      if (cdMessage) return cdMessage;

      try {
        const query = { ...utils.getScopeQuery(session, config), id };
        const [targetCave] = await ctx.database.get('cave', query);

        if (!targetCave) {
          return `回声洞（${id}）不存在`;
        }

        utils.updateCooldownTimestamp(session, config, lastUsed);
        return utils.buildCaveMessage(targetCave, config, fileManager, logger);
      } catch (error) {
        logger.error(`查看回声洞（${id}）失败:`, error);
        return '查看失败，请稍后再试';
      }
    });

  // 子命令: cave.del
  cave.subcommand('.del <id:posint>', '删除指定回声洞')
    .usage('通过序号删除对应的回声洞。')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要删除的回声洞序号';

      try {
        // 只能删除 active 状态的洞。
        const [targetCave] = await ctx.database.get('cave', { id, status: 'active' });
        if (!targetCave) return `回声洞（${id}）不存在`;

        const isOwner = targetCave.userId === session.userId;
        const isAdmin = config.adminUsers.includes(session.userId);
        if (!isOwner && !isAdmin) {
          return '抱歉，你没有权限删除这条回声洞';
        }

        // 先将状态标记为 'delete'。
        await ctx.database.upsert('cave', [{ id: id, status: 'delete' }]);

        // 在触发后台清理前，先构建好消息，避免竞争删除文件导致消息内容不完整。
        const caveMessage = await utils.buildCaveMessage(targetCave, config, fileManager, logger);

        // 立即触发一次清理，让它在后台运行，不会阻塞当前响应。
        utils.cleanupPendingDeletions(ctx, fileManager, logger);

        // 立刻向用户返回已删除的消息。
        return [
          `以下内容已删除`,
          ...caveMessage,
        ];
      } catch (error) {
        logger.error(`标记回声洞（${id}）失败:`, error);
        return '删除失败，请稍后再试';
      }
    });

  // 子命令: cave.list
  cave.subcommand('.list', '查询我的投稿')
    .usage('查询并列出你所有投稿的回声洞序号。')
    .action(async ({ session }) => {
      try {
        // 查询条件：当前作用域、当前用户、活动状态。
        const query = { ...utils.getScopeQuery(session, config), userId: session.userId };
        const userCaves = await ctx.database.get('cave', query);
        if (userCaves.length === 0) return '你还没有投稿过回声洞';

        // 格式化输出 ID 列表。
        const caveIds = userCaves.map(c => c.id).sort((a, b) => a - b).join(', ');
        return `你已投稿 ${userCaves.length} 条回声洞，序号为：\n${caveIds}`;
      } catch (error) {
        logger.error('查询投稿列表失败:', error);
        return '查询失败，请稍后再试';
      }
    });

  // --- 条件化注册子模块 (Conditionally Register Sub-modules) ---

  if (config.enableProfile) {
    profileManager = new ProfileManager(ctx);
    profileManager.registerCommands(cave);
  }

  if (config.enableIO) {
    dataManager = new DataManager(ctx, config, fileManager, logger);
    dataManager.registerCommands(cave);
  }

  if (config.enableReview) {
    reviewManager = new ReviewManager(ctx, config, fileManager, logger);
    reviewManager.registerCommands(cave);
  }

}
