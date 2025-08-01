import { Context, Schema, Logger, h } from 'koishi'
import { FileManager } from './FileManager'
import { ProfileManager } from './ProfileManager'
import { DataManager } from './DataManager'
import { ReviewManager } from './ReviewManager'
import * as utils from './Utils'

export const name = 'best-cave'
export const inject = ['database']

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

// --- 数据类型定义 ---

/**
 * @interface StoredElement
 * @description 单个消息元素的数据库存储格式。
 * @property type - 元素类型: 'text', 'image', 'video', 'audio', 'file'。
 * @property content - 文本内容，仅用于 'text' 类型。
 * @property file - 文件标识符 (本地文件名或 S3 Key)，用于媒体类型。
 */
export interface StoredElement {
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  content?: string;
  file?: string;
}

/**
 * @interface CaveObject
 * @description `cave` 数据表的完整对象模型。
 * @property id - 回声洞的唯一数字 ID (主键)。
 * @property elements - 构成回声洞内容的 StoredElement 数组。
 * @property channelId - 提交回声洞的频道 ID，若为私聊则为 null。
 * @property userId - 提交用户的 ID。
 * @property userName - 提交用户的昵称。
 * @property status - 回声洞状态: 'active' (活跃), 'delete' (待删除), 'pending' (待审核)。
 * @property time - 提交的时间戳。
 */
export interface CaveObject {
  id: number;
  elements: StoredElement[];
  channelId: string;
  userId: string;
  userName: string;
  status: 'active' | 'delete' | 'pending';
  time: Date;
}

declare module 'koishi' {
  interface Tables {
    cave: CaveObject;
  }
}

// --- 插件配置 ---

export interface Config {
  coolDown: number;
  perChannel: boolean;
  adminUsers: string[];
  enableProfile: boolean;
  enableIO: boolean;
  enableReview: boolean;
  caveFormat: string;
  localPath?: string;
  enableS3: boolean;
  publicUrl?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

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

// --- 插件主逻辑 ---

/**
 * 插件主逻辑入口。
 * @param ctx - Koishi 上下文。
 * @param config - 用户提供的插件配置。
 */
export function apply(ctx: Context, config: Config) {
  ctx.model.extend('cave', {
    id: 'unsigned',
    elements: 'json',
    channelId: 'string',
    userId: 'string',
    userName: 'string',
    status: 'string',
    time: 'timestamp',
  }, {
    primary: 'id',
  });

  // --- 初始化管理器 ---
  const fileManager = new FileManager(ctx.baseDir, config, logger);
  const lastUsed = new Map<string, number>();

  let profileManager: ProfileManager;
  let dataManager: DataManager;
  let reviewManager: ReviewManager;

  // --- 主命令定义 ---
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
        const query = utils.getScopeQuery(session, config);
        const candidates = await ctx.database.get('cave', query, { fields: ['id'] });
        if (candidates.length === 0) {
          return `当前${config.perChannel && session.channelId ? '本群' : ''}还没有任何回声洞`;
        }

        const randomId = candidates[Math.floor(Math.random() * candidates.length)].id;
        const [randomCave] = await ctx.database.get('cave', { ...query, id: randomId });

        if (randomCave) {
            utils.updateCooldownTimestamp(session, config, lastUsed);
            return utils.buildCaveMessage(randomCave, config, fileManager, logger);
        }
        return '未能获取到回声洞';
      } catch (error) {
        logger.error('随机获取回声洞失败:', error);
      }
    });

  // --- 子命令注册 ---

  cave.subcommand('.add [content:text]', '添加回声洞')
    .usage('添加一条回声洞。可以直接发送内容，也可以回复或引用一条消息。')
    .action(async ({ session }, content) => {
      try {
        let sourceElements: h[] = session.quote?.elements;
        if (!sourceElements) {
            const sourceText = content?.trim();
            if(sourceText) {
                sourceElements = h.parse(sourceText);
            } else {
                await session.send("请在一分钟内发送你要添加的内容");
                const reply = await session.prompt(60000);
                if (!reply) return "操作超时，已取消添加";
                sourceElements = h.parse(reply);
            }
        }

        const scopeQuery = utils.getScopeQuery(session, config);

        // Inlined getNextCaveId
        const allCaves = await ctx.database.get('cave', scopeQuery, { fields: ['id'] });
        const existingIds = new Set(allCaves.map(c => c.id));
        let newId = 1;
        while (existingIds.has(newId)) {
          newId++;
        }

        const { finalElementsForDb, mediaToDownload } = utils.prepareElementsForStorage(sourceElements, newId, session.channelId, session.userId);
        if (finalElementsForDb.length === 0) return "内容为空，已取消添加";

        let userName = session.username;
        if (config.enableProfile && profileManager) {
          userName = (await profileManager.getNickname(session.userId)) || userName;
        }

        const newCave: CaveObject = {
          id: newId,
          elements: finalElementsForDb,
          channelId: session.channelId,
          userId: session.userId,
          userName,
          status: config.enableReview ? 'pending' : 'active',
          time: new Date(),
        };

        await ctx.database.create('cave', newCave);

        try {
          const downloadPromises = mediaToDownload.map(async (media) => {
            const response = await ctx.http.get(media.url, { responseType: 'arraybuffer', timeout: 30000 });
            await fileManager.saveFile(media.fileName, Buffer.from(response));
          });
          await Promise.all(downloadPromises);
        } catch (fileError) {
          await ctx.database.remove('cave', { id: newId });
          logger.error('媒体文件存储失败:', fileError);
          return '添加失败：媒体文件存储失败';
        }

        if (newCave.status === 'pending' && reviewManager) {
          reviewManager.sendForReview(newCave);
          return `提交成功，序号为（${newCave.id}）`;
        }
        return `添加成功，序号为（${newId}）`;
      } catch (error) {
        logger.error('添加回声洞失败:', error);
        return '添加失败，请稍后再试';
      }
    });

  cave.subcommand('.view <id:posint>', '查看指定回声洞')
    .usage('通过序号查看对应的回声洞。')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要查看的回声洞序号';

      const cdMessage = utils.checkCooldown(session, config, lastUsed);
      if (cdMessage) return cdMessage;

      try {
        const query = { ...utils.getScopeQuery(session, config), id };
        const [targetCave] = await ctx.database.get('cave', query);

        if (!targetCave) return `回声洞（${id}）不存在`;

        utils.updateCooldownTimestamp(session, config, lastUsed);
        return utils.buildCaveMessage(targetCave, config, fileManager, logger);
      } catch (error) {
        logger.error(`查看回声洞（${id}）失败:`, error);
        return '查看失败，请稍后再试';
      }
    });

  cave.subcommand('.del <id:posint>', '删除指定回声洞')
    .usage('通过序号删除对应的回声洞。')
    .action(async ({ session }, id) => {
      if (!id) return '请输入要删除的回声洞序号';

      try {
        const [targetCave] = await ctx.database.get('cave', { id, status: 'active' });
        if (!targetCave) return `回声洞（${id}）不存在`;

        const isOwner = targetCave.userId === session.userId;
        const isAdmin = config.adminUsers.includes(session.userId);
        if (!isOwner && !isAdmin) {
          return '抱歉，你没有权限删除这条回声洞';
        }

        const caveMessage = await utils.buildCaveMessage(targetCave, config, fileManager, logger);

        await ctx.database.upsert('cave', [{ id: id, status: 'delete' }]);

        session.send([`已删除`, ...caveMessage]);

        utils.cleanupPendingDeletions(ctx, fileManager, logger).catch(err => {
            logger.error(`删除回声洞（${id}）失败:`, err);
        });

      } catch (error) {
        logger.error(`标记删除回声洞（${id}）失败:`, error);
        return '删除失败，请稍后再试';
      }
    });

  cave.subcommand('.list', '查询我的投稿')
    .usage('查询并列出你所有投稿的回声洞序号。')
    .action(async ({ session }) => {
      try {
        const query = { ...utils.getScopeQuery(session, config), userId: session.userId };
        const userCaves = await ctx.database.get('cave', query);
        if (userCaves.length === 0) return '你还没有投稿过回声洞';

        const caveIds = userCaves.map(c => c.id).sort((a, b) => a - b).join(', ');
        return `你已投稿 ${userCaves.length} 条回声洞，序号为：\n${caveIds}`;
      } catch (error) {
        logger.error('查询投稿列表失败:', error);
        return '查询失败，请稍后再试';
      }
    });

  // --- 条件化注册子模块 ---

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
