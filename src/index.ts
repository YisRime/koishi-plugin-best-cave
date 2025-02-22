import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import {} from 'koishi-plugin-adapter-onebot'
import { FileHandler } from './utils/FileHandle'
import { IdManager } from './utils/IdManage'
import { ContentHashManager } from './utils/HashManage'
import { AuditManager } from './utils/AuditManage'
import { extractMediaContent, Element, TextElement, MediaElement, saveMedia } from './utils/MediaHandle'

// 基础定义
export const name = 'best-cave';
export const inject = ['database'];

/**
 * 插件配置项
 * @type {Schema}
 */
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required(), // 管理员用户ID
  number: Schema.number().default(60),              // 冷却时间(秒)
  enableAudit: Schema.boolean().default(false),     // 启用审核
  enableTextDuplicate: Schema.boolean().default(true), // 启用文本查重
  textDuplicateThreshold: Schema.number().default(0.9), // 文本查重阈值
  enableImageDuplicate: Schema.boolean().default(true), // 开启图片查重
  imageDuplicateThreshold: Schema.number().default(0.8), // 图片查重阈值
  imageMaxSize: Schema.number().default(4),         // 图片大小限制(MB)
  allowVideo: Schema.boolean().default(true),       // 允许视频
  videoMaxSize: Schema.number().default(16),        // 视频大小限制(MB)
  enablePagination: Schema.boolean().default(false),// 启用分页
  itemsPerPage: Schema.number().default(10),        // 每页条数
  blacklist: Schema.array(Schema.string()).default([]), // 黑名单
  whitelist: Schema.array(Schema.string()).default([]), // 白名单
}).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
});

/**
 * 插件主入口
 * @param {Context} ctx - Koishi上下文
 * @param {Config} config - 插件配置
 */
export async function apply(ctx: Context, config: Config) {
  // 初始化国际化
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  // 初始化路径
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');

  // 初始化存储系统
  await FileHandler.ensureDirectory(dataDir);
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(path.join(caveDir, 'resources'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'cave.json'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'pending.json'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'hash.json'));

  // 初始化核心组件
  const idManager = new IdManager(ctx.baseDir);
  const contentHashManager = new ContentHashManager(caveDir);
  const auditManager = new AuditManager(ctx, config, caveDir, idManager);

  // 等待所有组件初始化完成
  await Promise.all([
    idManager.initialize(path.join(caveDir, 'cave.json'), path.join(caveDir, 'pending.json')),
    contentHashManager.initialize()
  ]);

  const lastUsed = new Map<string, number>();

  // 处理列表查询
  async function processList(
    session: any,
    config: Config,
    userId?: string,
    pageNum: number = 1
  ): Promise<string> {
    const stats = idManager.getStats();

    // 如果指定了用户ID，只返回该用户的统计信息
    if (userId && userId in stats) {
      const ids = stats[userId];
      return session.text('commands.cave.list.totalItems', [userId, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    }

    const lines: string[] = Object.entries(stats).map(([cid, ids]) => {
      return session.text('commands.cave.list.totalItems', [cid, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    });

    const totalSubmissions = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);

    if (config.enablePagination) {
      const itemsPerPage = config.itemsPerPage;
      const totalPages = Math.max(1, Math.ceil(lines.length / itemsPerPage));
      pageNum = Math.min(Math.max(1, pageNum), totalPages);
      const start = (pageNum - 1) * itemsPerPage;
      const paginatedLines = lines.slice(start, start + itemsPerPage);
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             paginatedLines.join('\n') + '\n' +
             session.text('commands.cave.list.pageInfo', [pageNum, totalPages]);
    } else {
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             lines.join('\n');
    }
  }

  async function processView(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
    if (isNaN(caveId)) return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    const cave = data.find(item => item.cave_id === caveId);
    if (!cave) return sendMessage(session, 'commands.cave.error.notFound', [], true);
    return buildMessage(cave, resourceDir, session);
  }

  async function processRandom(
    caveFilePath: string,
    resourceDir: string,
    session: any
  ): Promise<string | void> {
    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    if (data.length === 0) {
      return sendMessage(session, 'commands.cave.error.noCave', [], true);
    }

    const cave = (() => {
      const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
      if (!validCaves.length) return undefined;
      const randomIndex = Math.floor(Math.random() * validCaves.length);
      return validCaves[randomIndex];
    })();

    return cave ? buildMessage(cave, resourceDir, session)
                : sendMessage(session, 'commands.cave.error.getCave', [], true);
  }

  async function processDelete(
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    config: Config,
    options: any,
    content: string[]
  ): Promise<string> {
    const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
    if (isNaN(caveId)) return sendMessage(session, 'commands.cave.error.invalidId', [], true);

    const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);

    // 根据 cave_id 查找而不是索引查找
    const targetInData = data.find(item => item.cave_id === caveId);
    const targetInPending = pendingData.find(item => item.cave_id === caveId);

    if (!targetInData && !targetInPending) {
      return sendMessage(session, 'commands.cave.error.notFound', [], true);
    }

    const targetCave = targetInData || targetInPending;
    const isPending = !targetInData;

    // 权限检查
    if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
      return sendMessage(session, 'commands.cave.remove.noPermission', [], true);
    }

    // 先生成回声洞预览消息
    const caveContent = await buildMessage(targetCave, resourceDir, session);

    // 删除相关的媒体文件
    if (targetCave.elements) {

      // 直接删除对应的哈希
      await contentHashManager.updateCaveContent(caveId, {
        images: undefined,
        texts: undefined
      });

      for (const element of targetCave.elements) {
        if ((element.type === 'img' || element.type === 'video') && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
          }
        }
      }
    }

    // 从数组中移除目标对象
    if (isPending) {
      const newPendingData = pendingData.filter(item => item.cave_id !== caveId);
      await FileHandler.writeJsonData(pendingFilePath, newPendingData);
    } else {
      const newData = data.filter(item => item.cave_id !== caveId);
      await FileHandler.writeJsonData(caveFilePath, newData);
      await idManager.removeStat(targetCave.contributor_number, caveId);
    }

    // 标记 ID 为已删除
    await idManager.markDeleted(caveId);

    const deleteStatus = isPending
      ? session.text('commands.cave.remove.deletePending')
      : '';
    const deleteMessage = session.text('commands.cave.remove.deleted');
    return `${deleteMessage}${deleteStatus}${caveContent}`;
  }

  async function processAdd(
    ctx: Context,
    config: Config,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    content: string[]
  ): Promise<string> {
    let caveId: number;
    try {
      // 获取新ID并验证
      caveId = await idManager.getNextId();
      if (isNaN(caveId) || caveId <= 0) {
        throw new Error('Invalid ID generated');
      }

      const inputContent = content.length > 0 ? content.join('\n') : await (async () => {
        await sendMessage(session, 'commands.cave.add.noContent', [], true, 60000);
        const reply = await session.prompt({ timeout: 60000 });
        if (!reply) {
          await sendMessage(session, 'commands.cave.add.operationTimeout', [], true);
          return null;
        }
        return reply;
      })();

      if (!inputContent) {
        return '';
      }

      if (inputContent.includes('/app/.config/QQ/')) {
        return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
      }

      const bypassAudit = config.whitelist.includes(session.userId) ||
                         config.whitelist.includes(session.guildId) ||
                         config.whitelist.includes(session.channelId);

      const { imageUrls, imageElements, videoUrls, videoElements, textParts } =
        await extractMediaContent(inputContent, config, session);

      if (videoUrls.length > 0 && !config.allowVideo) {
        return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
      }

      // 先下载并保存媒体文件，这样我们可以复用buffers
      const imageBuffers: Buffer[] = [];
      const [savedImages, savedVideos] = await Promise.all([
        imageUrls.length > 0 ? saveMedia(
          imageUrls,
          imageElements.map(el => el.fileName),
          resourceDir,
          caveId,
          'img',
          config,
          ctx,
          session,
          imageBuffers // 添加参数用于收集buffer
        ) : [],
        videoUrls.length > 0 ? saveMedia(
          videoUrls,
          videoElements.map(el => el.fileName),
          resourceDir,
          caveId,
          'video',
          config,
          ctx,
          session
        ) : []
      ]);

      const newCave: CaveObject = {
        cave_id: caveId,  // 确保使用有效的数字ID
        elements: [
          ...textParts,
          ...imageElements.map((el, idx) => ({
            ...el,
            file: savedImages[idx],
            // 保持原始文本和图片的相对位置
            index: el.index
          }))
        ].sort((a, b) => a.index - b.index),
        contributor_number: session.userId || '100000',  // 添加默认值
        contributor_name: session.username || 'User'  // 添加默认值
      };

      // 如果有视频，直接添加到elements末尾，不需要计算index
      if (videoUrls.length > 0 && savedVideos.length > 0) {
        newCave.elements.push({
          type: 'video',
          file: savedVideos[0],
          index: Number.MAX_SAFE_INTEGER
        });
      }

      // 检查是否有hash记录
      const hashStorage = new ContentHashManager(path.join(ctx.baseDir, 'data', 'cave'));
      await hashStorage.initialize();
      const hashStatus = await hashStorage.getStatus();

      // 如果没有hash记录,先检查是否有需要检测的图片
      if (!hashStatus.lastUpdated || hashStatus.entries.length === 0) {
        const existingData = await FileHandler.readJsonData<CaveObject>(caveFilePath);
        const hasImages = existingData.some(cave =>
          cave.elements?.some(element => element.type === 'img' && element.file)
        );

        if (hasImages) {
          await hashStorage.updateAllCaves(true);
        }
      }

      // 处理审核逻辑
      if (config.enableAudit && !bypassAudit) {
        const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
        pendingData.push(newCave);
        await Promise.all([
          FileHandler.writeJsonData(pendingFilePath, pendingData),
          auditManager.sendAuditMessage(newCave, await buildMessage(newCave, resourceDir, session), session)
        ]);
        return sendMessage(session, 'commands.cave.add.submitPending', [caveId], false);
      }

      // 直接保存到 cave.json 时移除 index
      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
      data.push({
        ...newCave,
        elements: cleanElementsForSave(newCave.elements, false)
      });

      // 检查内容重复 - 直接使用已下载的buffers
      if (config.enableImageDuplicate || config.enableTextDuplicate) {
        const duplicateResults = await contentHashManager.findDuplicates({
          images: config.enableImageDuplicate ? imageBuffers : undefined,
          texts: config.enableTextDuplicate ?
            textParts.filter((p): p is TextElement => p.type === 'text').map(p => p.content) : undefined
        }, {
          image: config.imageDuplicateThreshold,
          text: config.textDuplicateThreshold
        });

        // 处理重复检测结果
        for (const result of duplicateResults) {
          if (!result) continue;

          const originalCave = data.find(item => item.cave_id === result.caveId);
          if (!originalCave) continue;

          // 回收未使用的ID
          await idManager.markDeleted(caveId);

          const duplicateMessage = session.text('commands.cave.error.similarDuplicateFound',
            [(result.similarity * 100).toFixed(1)]);
          await session.send(duplicateMessage + await buildMessage(originalCave, resourceDir, session));
          throw new Error('duplicate_found');
        }
      }

      // 保存数据并更新hash
      await Promise.all([
        FileHandler.writeJsonData(caveFilePath, data),
        contentHashManager.updateCaveContent(caveId, {
          images: savedImages.length > 0 ?
            await Promise.all(savedImages.map(file =>
              fs.promises.readFile(path.join(resourceDir, file)))) : undefined,
          texts: textParts.filter(p => p.type === 'text').map(p => (p as TextElement).content)
        })
      ]);

      await idManager.addStat(session.userId, caveId);
      return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);

    } catch (error) {
      // 在出错时确保回收ID
      if (typeof caveId === 'number' && !isNaN(caveId) && caveId > 0) {
        await idManager.markDeleted(caveId);
      }

      if (error.message === 'duplicate_found') {
        return '';
      }

      logger.error(`Failed to process add command: ${error.message}`);
      return sendMessage(session, 'commands.cave.error.addFailed', [], true);
    }
  }

  // 注册主命令和子命令
  const caveCommand = ctx.command('cave [message]')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    .before(async ({ session, options }) => {
      // 黑名单检查
      if (config.blacklist.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.blacklisted', [], true);
      }
    })
    .action(async ({ session, options }, ...content) => {
      const dataDir = path.join(ctx.baseDir, 'data');
      const caveDir = path.join(dataDir, 'cave');
      const caveFilePath = path.join(caveDir, 'cave.json');
      const resourceDir = path.join(caveDir, 'resources');
      const pendingFilePath = path.join(caveDir, 'pending.json');

      // 基础检查 - 需要冷却的命令
      const needsCooldown = !options.l && !options.a;
      if (needsCooldown) {
        const guildId = session.guildId;
        const now = Date.now();
        const lastTime = lastUsed.get(guildId) || 0;
        const isManager = config.manager.includes(session.userId);

        if (!isManager && now - lastTime < config.number * 1000) {
          const waitTime = Math.ceil((config.number * 1000 - (now - lastTime)) / 1000);
          return sendMessage(session, 'commands.cave.message.cooldown', [waitTime], true);
        }

        lastUsed.set(guildId, now);
      }

      // 处理各种命令
      if (options.l !== undefined) {
        const input = typeof options.l === 'string' ? options.l : content[0];
        const num = parseInt(input);

        if (config.manager.includes(session.userId)) {
          if (!isNaN(num)) {
            if (num < 10000) {
              return await processList(session, config, undefined, num);
            } else {
              return await processList(session, config, num.toString());
            }
          } else if (input) {
            return await processList(session, config, input);
          }
          return await processList(session, config);
        } else {
          return await processList(session, config, session.userId);
        }
      }

      if (options.g) {
        return await processView(caveFilePath, resourceDir, session, options, content);
      }
      if (options.r) {
        return await processDelete(caveFilePath, resourceDir, pendingFilePath, session, config, options, content);
      }
      if (options.a) {
        return await processAdd(ctx, config, caveFilePath, resourceDir, pendingFilePath, session, content);
      }
      return await processRandom(caveFilePath, resourceDir, session);
    })

  // 通过审核子命令
  caveCommand
    .subcommand('.pass <id:text>', '通过回声洞审核')
    .before(async ({ session }) => {
      if (!config.manager.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.managerOnly', [], true);
      }
    })
    .action(async ({ session }, id) => {
      const dataDir = path.join(ctx.baseDir, 'data');
      const caveDir = path.join(dataDir, 'cave');
      const caveFilePath = path.join(caveDir, 'cave.json');
      const resourceDir = path.join(caveDir, 'resources');
      const pendingFilePath = path.join(caveDir, 'pending.json');

      const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
      return await auditManager.processAudit(pendingData, true, caveFilePath, resourceDir, pendingFilePath, session, id === 'all' ? undefined : parseInt(id));
    })

  // 拒绝审核子命令
  caveCommand
    .subcommand('.reject <id:text>', '拒绝回声洞审核')
    .before(async ({ session }) => {
      if (!config.manager.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.managerOnly', [], true);
      }
    })
    .action(async ({ session }, id) => {
      const dataDir = path.join(ctx.baseDir, 'data');
      const caveDir = path.join(dataDir, 'cave');
      const caveFilePath = path.join(caveDir, 'cave.json');
      const resourceDir = path.join(caveDir, 'resources');
      const pendingFilePath = path.join(caveDir, 'pending.json');

      const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
      return await auditManager.processAudit(pendingData, false, caveFilePath, resourceDir, pendingFilePath, session, id === 'all' ? undefined : parseInt(id));
    })

}

// 日志记录器
const logger = new Logger('cave');

// 核心类型定义
export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;
  allowVideo: boolean;
  videoMaxSize: number;
  imageMaxSize: number;
  blacklist: string[];
  whitelist: string[];
  enablePagination: boolean;
  itemsPerPage: number;
  enableImageDuplicate: boolean; // 替换 enableDuplicate
  imageDuplicateThreshold: number;
  textDuplicateThreshold: number;
  enableTextDuplicate: boolean;
}

// 定义数据类型接口
interface CaveObject { cave_id: number; elements: Element[]; contributor_number: string; contributor_name: string }
interface PendingCave extends CaveObject {}

// 工具函数定义
// session: 会话上下文
// key: 消息key
// params: 消息参数
// isTemp: 是否为临时消息
// timeout: 临时消息超时时间
async function sendMessage(
  session: any,
  key: string,
  params: any[] = [],
  isTemp = true,
  timeout = 10000
): Promise<string> {
  try {
    const msg = await session.send(session.text(key, params));
    if (isTemp && msg) {
      setTimeout(async () => {
        try {
          await session.bot.deleteMessage(session.channelId, msg);
        } catch (error) {
          logger.debug(`Failed to delete temporary message: ${error.message}`);
        }
      }, timeout);
    }
  } catch (error) {
    logger.error(`Failed to send message: ${error.message}`);
  }
  return '';
}

// 消息构建工具
// 清理元素数据用于保存
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  if (!elements?.length) return [];

  const cleanedElements = elements.map(element => {
    if (element.type === 'text') {
      const cleanedElement: Partial<TextElement> = {
        type: 'text' as const,
        content: (element as TextElement).content
      };
      if (keepIndex) cleanedElement.index = element.index;
      return cleanedElement as TextElement;
    } else if (element.type === 'img' || element.type === 'video') {
      const mediaElement = element as MediaElement;
      const cleanedElement: Partial<MediaElement> = {
        type: mediaElement.type
      };
      if (mediaElement.file) cleanedElement.file = mediaElement.file;
      if (keepIndex) cleanedElement.index = element.index;
      return cleanedElement as MediaElement;
    }
    return element;
  });

  return keepIndex ? cleanedElements.sort((a, b) => (a.index || 0) - (b.index || 0)) : cleanedElements;
}

// 处理媒体文件
async function processMediaFile(filePath: string, type: 'image' | 'video'): Promise<string | null> {
  const data = await fs.promises.readFile(filePath).catch(() => null);
  if (!data) return null;
  return `data:${type}/${type === 'image' ? 'png' : 'mp4'};base64,${data.toString('base64')}`;
}

// 构建消息内容
async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  // 分离视频元素和其他元素，并确保按index排序
  const videoElement = cave.elements.find((el): el is MediaElement => el.type === 'video');
  const nonVideoElements = cave.elements
    .filter(el => el.type !== 'video')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // 如果有视频元素，先发送基本信息，然后单独发送视频
  if (videoElement?.file) {
    // 构建基本信息
    const basicInfo = [
    session.text('commands.cave.message.caveTitle', [cave.cave_id]),
    session.text('commands.cave.message.contributorSuffix', [cave.contributor_name])
    ].join('\n');

    // 先发送标题和作者信息
    await session?.send(basicInfo);

    // 发送视频
    const filePath = path.join(resourceDir, videoElement.file);
    const base64Data = await processMediaFile(filePath, 'video');
    if (base64Data && session) {
      await session.send(h('video', { src: base64Data }));
    }
    return '';
  }

  // 如果没有视频，按原来的方式处理
  const lines = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];

  for (const element of nonVideoElements) {
    if (element.type === 'text') {
      lines.push(element.content);
    } else if (element.type === 'img' && element.file) {
      const filePath = path.join(resourceDir, element.file);
      const base64Data = await processMediaFile(filePath, 'image');
      if (base64Data) {
        lines.push(h('image', { src: base64Data }));
      }
    }
  }

  lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));
  return lines.join('\n');
}
