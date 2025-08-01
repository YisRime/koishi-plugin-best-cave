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

// --- 数据类型定义 ---

/**
 * @description 存储在数据库中的单个消息元素。
 */
export interface StoredElement {
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  content?: string; // 文本内容
  file?: string;    // 媒体文件的标识符 (本地文件名或S3 Key)
}

/**
 * @description 数据库 `cave` 表的完整对象模型。
 */
export interface CaveObject {
  id: number;
  elements: StoredElement[];
  channelId: string;
  userId: string;
  userName: string;
  status: 'active' | 'delete' | 'pending' | 'preload';
  time: Date;
}

// 扩展 Koishi 数据库表接口，以获得 'cave' 表的类型提示。
declare module 'koishi' {
  interface Tables {
    cave: CaveObject
  }
}

// --- 插件配置 ---

export interface Config {
  coolDown: number;
  perChannel: boolean;
  adminChannel: string;
  enableProfile: boolean;
  enableIO: boolean;
  enableReview: boolean;
  caveFormat: string;
  localPath?: string;
  enableS3: boolean;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicUrl?: string;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    coolDown: Schema.number().default(10).description("冷却时间（秒）"),
    perChannel: Schema.boolean().default(false).description("启用分群模式"),
    enableProfile: Schema.boolean().default(false).description("启用自定义昵称"),
    enableIO: Schema.boolean().default(false).description("启用导入导出"),
    adminChannel: Schema.string().default('onebot:').description("管理群组 ID"),
    caveFormat: Schema.string().default('回声洞 ——（{id}）|—— {name}').description('自定义文本'),
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
export function apply(ctx: Context, config: Config) {
  // 扩展 'cave' 数据表模型
  ctx.model.extend('cave', {
    id: 'unsigned',
    elements: 'json',
    channelId: 'string',
    userId: 'string',
    userName: 'string',
    status: 'string',
    time: 'timestamp',
  }, { primary: 'id' });

  // --- 初始化管理器 ---
  const fileManager = new FileManager(ctx.baseDir, config, logger);
  const lastUsed = new Map<string, number>();
  const profileManager = config.enableProfile ? new ProfileManager(ctx) : null;
  const dataManager = config.enableIO ? new DataManager(ctx, config, fileManager, logger) : null;
  const reviewManager = config.enableReview ? new ReviewManager(ctx, config, fileManager, logger) : null;

  // --- 指令定义 ---
  const cave = ctx.command('cave', '回声洞')
    .option('add', '-a <content:text>')
    .option('view', '-g <id:posint>')
    .option('delete', '-r <id:posint>')
    .option('list', '-l')
    .usage('随机抽取一条已添加的回声洞。')
    .action(async ({ session, options }) => {
      // 选项快捷方式
      if (options.add) return session.execute(`cave.add ${options.add}`);
      if (options.view) return session.execute(`cave.view ${options.view}`);
      if (options.delete) return session.execute(`cave.del ${options.delete}`);
      if (options.list) return session.execute('cave.list');

      const cdMessage = utils.checkCooldown(session, config, lastUsed);
      if (cdMessage) return cdMessage;

      try {
        const query = utils.getScopeQuery(session, config);
        const candidates = await ctx.database.get('cave', query, { fields: ['id'] });
        if (!candidates.length) {
          return `当前${config.perChannel && session.channelId ? '本群' : ''}还没有任何回声洞`;
        }

        const randomId = candidates[Math.floor(Math.random() * candidates.length)].id;
        const [randomCave] = await ctx.database.get('cave', { ...query, id: randomId });

        utils.updateCooldownTimestamp(session, config, lastUsed);
        return utils.buildCaveMessage(randomCave, config, fileManager, logger);
      } catch (error) {
        logger.error('随机获取回声洞失败:', error);
        return '随机获取回声洞失败';
      }
    });

  // --- 注册子命令 ---

  cave.subcommand('.add [content:text]', '添加回声洞')
    .usage('添加一条回声洞。可以直接发送内容，也可以回复或引用一条消息。')
    .action(async ({ session }, content) => {
      try {
        let sourceElements = session.quote?.elements;
        if (!sourceElements && content?.trim()) {
            sourceElements = h.parse(content);
        }
        if (!sourceElements) {
            await session.send("请在一分钟内发送你要添加的内容");
            const reply = await session.prompt(60000);
            if (!reply) return "操作超时，已取消添加";
            sourceElements = h.parse(reply);
        }

        const idScopeQuery = config.perChannel && session.channelId ? { channelId: session.channelId } : {};
        const newId = await utils.getNextCaveId(ctx, idScopeQuery);

        const { finalElementsForDb, mediaToSave } = await utils.processMessageElements(
          sourceElements, newId, session.channelId, session.userId
        );

        if (finalElementsForDb.length === 0) return "内容为空，已取消添加";

        const userName = (config.enableProfile ? await profileManager.getNickname(session.userId) : null) || session.username;
        const hasMedia = mediaToSave.length > 0;
        const initialStatus = hasMedia ? 'preload' : (config.enableReview ? 'pending' : 'active');

        const newCave: CaveObject = {
          id: newId,
          elements: finalElementsForDb,
          channelId: session.channelId,
          userId: session.userId,
          userName,
          status: initialStatus,
          time: new Date(),
        };

        await ctx.database.create('cave', newCave);

        if (hasMedia) {
          // 异步处理文件上传
          utils.handleFileUploads(ctx, config, fileManager, logger, reviewManager, newCave, mediaToSave);
        } else if (initialStatus === 'pending') {
          reviewManager.sendForReview(newCave);
        }

        return (initialStatus === 'pending' || initialStatus === 'preload' && config.enableReview)
          ? `提交成功，序号为（${newId}）`
          : `添加成功，序号为（${newId}）`;
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

        const adminChannelId = config.adminChannel?.split(':')[1];
        const isAuthor = targetCave.userId === session.userId;
        const isAdmin = session.channelId === adminChannelId;

        if (!isAuthor && !isAdmin) {
          return '你没有权限删除这条回声洞';
        }

        await ctx.database.upsert('cave', [{ id: id, status: 'delete' }]);
        const caveMessage = await utils.buildCaveMessage(targetCave, config, fileManager, logger);
        utils.cleanupPendingDeletions(ctx, fileManager, logger); // 异步清理
        return [`已删除`, ...caveMessage];
      } catch (error) {
        logger.error(`标记回声洞（${id}）失败:`, error);
        return '删除失败，请稍后再试';
      }
    });

  cave.subcommand('.list', '查询我的投稿')
    .usage('查询并列出你所有投稿的回声洞序号。')
    .action(async ({ session }) => {
      try {
        const query = { ...utils.getScopeQuery(session, config), userId: session.userId };
        const userCaves = await ctx.database.get('cave', query, { fields: ['id'] });
        if (!userCaves.length) return '你还没有投稿过回声洞';
        const caveIds = userCaves.map(c => c.id).sort((a, b) => a - b).join(', ');
        return `你已投稿 ${userCaves.length} 条回声洞，序号为：\n${caveIds}`;
      } catch (error) {
        logger.error('查询投稿列表失败:', error);
        return '查询失败，请稍后再试';
      }
    });

  // --- 条件化注册子模块 ---
  if (profileManager) profileManager.registerCommands(cave);
  if (dataManager) dataManager.registerCommands(cave);
  if (reviewManager) reviewManager.registerCommands(cave);
}
