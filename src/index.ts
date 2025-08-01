import { Context, Schema, Logger, h } from 'koishi'
import * as path from 'path'
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
  status: 'active' | 'delete' | 'pending'; // 活跃、待删除、待审核
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
    adminChannel: Schema.string().description("管理群组 ID"),
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
  const lastUsed = new Map<string, number>(); // 指令冷却时间戳存储
  let profileManager: ProfileManager;
  let dataManager: DataManager;
  let reviewManager: ReviewManager;

  // --- 指令定义 ---
  const cave = ctx.command('cave', '回声洞')
    .option('add', '-a <content:text> 添加回声洞')
    .option('view', '-g <id:posint> 查看指定回声洞')
    .option('delete', '-r <id:posint> 删除指定回声洞')
    .option('list', '-l 查询投稿统计')
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
        // 仅获取ID以提高性能
        const candidates = await ctx.database.get('cave', query, { fields: ['id'] });
        if (candidates.length === 0) {
          return `当前${config.perChannel && session.channelId ? '本群' : ''}还没有任何回声洞`;
        }

        // 随机抽取并获取完整数据
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
        let sourceElements: h[];
        // 优先使用引用消息，其次是指令内容，最后提示用户输入
        if (session.quote?.elements) {
          sourceElements = session.quote.elements;
        } else if (content?.trim()) {
          sourceElements = h.parse(content);
        } else {
          await session.send("请在一分钟内发送你要添加的内容");
          const reply = await session.prompt(60000);
          if (!reply) return "操作超时，已取消添加";
          sourceElements = h.parse(reply);
        }

        // 为获取下一个可用ID创建一个查询，此查询需包含所有状态的洞（active, pending等），以避免ID冲突
        const idScopeQuery = {};
        if (config.perChannel && session.channelId) {
          idScopeQuery['channelId'] = session.channelId;
        }
        const newId = await utils.getNextCaveId(ctx, idScopeQuery);

        const finalElementsForDb: StoredElement[] = [];
        const mediaToSave: { sourceUrl: string, fileName: string }[] = [];
        let mediaIndex = 0; // 媒体文件计数器

        // 定义从 Koishi 元素类型到数据库存储类型的映射
        const typeMap: Record<string, StoredElement['type']> = {
          'img': 'image',
          'image': 'image',
          'video': 'video',
          'audio': 'audio',
          'file': 'file',
          'text': 'text'
        };

        // 递归处理消息元素，生成文件名但不立即保存
        async function traverseAndProcess(elements: h[]) {
          for (const el of elements) {
            const normalizedType = typeMap[el.type]; // 使用映射获取标准类型

            if (!normalizedType) {
              if (el.children) await traverseAndProcess(el.children);
              continue;
            }

            // 处理媒体文件
            if (['image', 'video', 'audio', 'file'].includes(normalizedType) && el.attrs.src) {
              let fileIdentifier = el.attrs.src as string;
              // 如果 src 是网络链接，则生成文件名并加入待下载列表
              if (fileIdentifier.startsWith('http')) {
                mediaIndex++;
                const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };
                // 优先使用元素自带的文件名来获取扩展名，否则使用默认值
                const ext = el.attrs.file && path.extname(el.attrs.file as string)
                  ? path.extname(el.attrs.file as string)
                  : (defaultExtMap[normalizedType] || '.dat');
                const channelIdentifier = session.channelId || 'private';
                const fileName = `${newId}_${mediaIndex}_${channelIdentifier}_${session.userId}${ext}`;
                mediaToSave.push({ sourceUrl: fileIdentifier, fileName: fileName });
                fileIdentifier = fileName;
              }
              finalElementsForDb.push({ type: normalizedType, file: fileIdentifier });
            } else if (normalizedType === 'text' && el.attrs.content?.trim()) {
              finalElementsForDb.push({ type: 'text', content: el.attrs.content.trim() });
            }

            // 递归处理子元素
            if (el.children) {
              await traverseAndProcess(el.children);
            }
          }
        }

        await traverseAndProcess(sourceElements);

        if (finalElementsForDb.length === 0) return "内容为空，已取消添加";

        // 若启用昵称功能，获取并使用自定义昵称
        const customNickname = config.enableProfile ? await profileManager.getNickname(session.userId) : null;

        const newCave: CaveObject = {
          id: newId,
          elements: finalElementsForDb,
          channelId: session.channelId,
          userId: session.userId,
          userName: customNickname || session.username,
          status: config.enableReview ? 'pending' : 'active',
          time: new Date(),
        };

        // 先创建数据库条目
        await ctx.database.create('cave', newCave);

        // 然后下载并保存所有媒体文件
        try {
          await Promise.all(mediaToSave.map(async (media) => {
            const response = await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
            await fileManager.saveFile(media.fileName, Buffer.from(response));
          }));
        } catch (fileSaveError) {
          logger.error(`文件保存失败:`, fileSaveError);
          await ctx.database.remove('cave', { id: newId });
          throw fileSaveError;
        }

        if (newCave.status === 'pending') {
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
        if (targetCave.userId !== session.userId && session.channelId !== config.adminChannel) {
          return '你没有权限删除这条回声洞';
        }

        // 先将状态标记为 'delete'，以防文件被清理前消息发送失败
        await ctx.database.upsert('cave', [{ id: id, status: 'delete' }]);
        // 在触发后台清理前，先构建好消息
        const caveMessage = await utils.buildCaveMessage(targetCave, config, fileManager, logger);
        // 异步触发清理，不阻塞当前响应
        utils.cleanupPendingDeletions(ctx, fileManager, logger);
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
