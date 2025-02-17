// 回声洞插件 - 提供文本、图片、视频的投稿与管理功能

// 导入依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import {} from 'koishi-plugin-adapter-onebot'
import { FileHandler } from './utils/fileHandler'
import { IdManager } from './utils/idManager'
import { HashStorage } from './utils/HashStorage'

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
  imageMaxSize: Schema.number().default(4),         // 图片大小限制(MB)
  enableMD5: Schema.boolean().default(true),        // 启用MD5查重
  enableDuplicate: Schema.boolean().default(true),  // 启用相似度查重
  duplicateThreshold: Schema.number().default(0.8), // 相似度查重阈值(0-1)
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
  const hashStorage = new HashStorage(caveDir);

  // 等待所有组件初始化完成
  await Promise.all([
    idManager.initialize(path.join(caveDir, 'cave.json'), path.join(caveDir, 'pending.json')),
    hashStorage.initialize()
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

  // 处理审核操作
  async function processAudit(
    pendingFilePath: string,
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
    const isApprove = Boolean(options.p);
    if ((options.p === true && content[0] === 'all') ||
        (options.d === true && content[0] === 'all')) {
      return await handleAudit(pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session);
    }
    const id = parseInt(content[0] ||
      (typeof options.p === 'string' ? options.p : '') ||
      (typeof options.d === 'string' ? options.d : ''));
    if (isNaN(id)) {
      return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    }
    return sendMessage(session, await handleAudit(pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session, id), [], true);
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

    // 删除相关的媒体文件和哈希记录
    if (targetCave.elements) {
      const hashStorage = new HashStorage(caveDir);
      await hashStorage.initialize();

      // 使用新的清除方法
      await hashStorage.clearHashes(caveId);

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
    try {
      const inputContent = content.length > 0 ? content.join('\n') : await (async () => {
        await sendMessage(session, 'commands.cave.add.noContent', [], true);
        const reply = await session.prompt({ timeout: 60000 });
        if (!reply) session.text('commands.cave.add.operationTimeout');
        return reply;
      })();

      const caveId = await idManager.getNextId();

      if (inputContent.includes('/app/.config/QQ/')) {
        return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
      }

      const bypassAudit = config.whitelist.includes(session.userId) ||
                         config.whitelist.includes(session.guildId) ||
                         config.whitelist.includes(session.channelId);

      const { imageUrls, imageElements, videoUrls, videoElements, textParts } =
        await extractMediaContent(inputContent, config, session);

      // 新增纯文本查重逻辑（仅在启用 MD5 查重时进行）
      const pureText = textParts
        .filter(tp => tp.type === 'text')
        .map((tp: any) => tp.content.trim())
        .join('\n').trim();
      if (config.enableMD5 && pureText) {
        const textHash = HashStorage.hashText(pureText);
        const textDuplicates = await hashStorage.findDuplicates('text', [textHash]);

        if (textDuplicates[0]) {
          const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
          const duplicateCave = data.find(item => item.cave_id === textDuplicates[0].caveId);

          if (duplicateCave) {
            const message = session.text('commands.cave.error.exactDuplicateFound');
            await session.send(message + await buildMessage(duplicateCave, resourceDir, session));
            throw new Error('duplicate_found');
          }
        }
      }

      if (videoUrls.length > 0 && !config.allowVideo) {
        return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
      }

      const [savedImages, savedVideos] = await Promise.all([
        imageUrls.length > 0 ? saveMedia(
          imageUrls,
          imageElements.map(el => el.fileName),
          resourceDir,
          caveId,
          'img',
          config,
          ctx,
          session
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
        cave_id: caveId,
        elements: [
          ...textParts,
          ...imageElements.map((el, idx) => ({
            ...el,
            file: savedImages[idx],
            // 保持原始文本和图片的相对位置
            index: el.index
          }))
        ].sort((a) => a.index - a.index),
        contributor_number: session.userId,
        contributor_name: session.username
      };

      // 如果有视频，直接添加到elements末尾，不需要计算index
      if (videoUrls.length > 0 && savedVideos.length > 0) {
        newCave.elements.push({
          type: 'video',
          file: savedVideos[0],
          index: Number.MAX_SAFE_INTEGER
        });
      }

      // 如果启用了hash记录,先检查是否有需要检测的图片
      const existingData = await FileHandler.readJsonData<CaveObject>(caveFilePath);
      const hasImages = existingData.some(cave =>
        cave.elements?.some(element => element.type === 'img' && element.file)
      );

      // 初始化 hashStorage，它会自动处理所有现有图片的哈希
      if (hasImages) {
        await hashStorage.initialize();
      }

      // 处理审核逻辑
      if (config.enableAudit && !bypassAudit) {
        const pendingData = await FileHandler.readJsonData<PendingCave>(pendingFilePath);
        // 保存到 pending.json 时保留 index
        pendingData.push(newCave);
        await Promise.all([
          FileHandler.writeJsonData(pendingFilePath, pendingData),
          sendAuditMessage(ctx, config, newCave, await buildMessage(newCave, resourceDir, session), session)
        ]);
        return sendMessage(session, 'commands.cave.add.submitPending', [caveId], false);
      }

      // 直接保存到 cave.json 时移除 index
      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
      data.push({
        ...newCave,
        elements: cleanElementsForSave(newCave.elements, false)
      });

      // 保存数据并更新hash
      await Promise.all([
        FileHandler.writeJsonData(caveFilePath, data),
        pureText && config.enableMD5
          ? hashStorage.updateHash(caveId, 'text', pureText)
          : Promise.resolve(),
        savedImages?.length
          ? Promise.all(savedImages.map(buffer => hashStorage.updateHash(caveId, 'image', buffer)))
          : Promise.resolve()
      ]);

      await idManager.addStat(session.userId, caveId);

      // 在通过审核并成功保存后，更新纯文字 hash 记录（启用MD5时）
      if (config.enableMD5 && pureText) {
        const textHash = HashStorage.hashText(pureText);
        await hashStorage.updateHash(caveId, 'text', textHash);
      }

      return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);

    } catch (error) {
      logger.error(`Failed to process add command: ${error.message}`);
    }
  }

  // 合并审核相关函数
  async function handleAudit(
    pendingData: PendingCave[],
    isApprove: boolean,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    targetId?: number
  ): Promise<string> {
    if (pendingData.length === 0) {
      return sendMessage(session, 'commands.cave.audit.noPending', [], true);
    }

    // 处理单条审核
    if (typeof targetId === 'number') {
      const targetCave = pendingData.find(item => item.cave_id === targetId);
      if (!targetCave) {
        return sendMessage(session, 'commands.cave.audit.pendingNotFound', [], true);
      }

      const newPendingData = pendingData.filter(item => item.cave_id !== targetId);

      if (isApprove) {
        const oldCaveData = await FileHandler.readJsonData<CaveObject>(caveFilePath);
        // 确保cave_id保持不变
        const newCaveData = [...oldCaveData, {
          ...targetCave,
          cave_id: targetId,
          elements: cleanElementsForSave(targetCave.elements, false)
        }];

        await FileHandler.withTransaction([
          {
            filePath: caveFilePath,
            operation: async () => FileHandler.writeJsonData(caveFilePath, newCaveData),
            rollback: async () => FileHandler.writeJsonData(caveFilePath, oldCaveData)
          },
          {
            filePath: pendingFilePath,
            operation: async () => FileHandler.writeJsonData(pendingFilePath, newPendingData),
            rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
          }
        ]);
        await idManager.addStat(targetCave.contributor_number, targetId);
      } else {
        // 拒绝审核时，需要将ID标记为已删除
        await FileHandler.writeJsonData(pendingFilePath, newPendingData);
        await idManager.markDeleted(targetId);

        // 删除关联的媒体文件
        if (targetCave.elements) {
          for (const element of targetCave.elements) {
            if ((element.type === 'img' || element.type === 'video') && element.file) {
              const fullPath = path.join(resourceDir, element.file);
              if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
              }
            }
          }
        }
      }

      const remainingCount = newPendingData.length;
      if (remainingCount > 0) {
        const remainingIds = newPendingData.map(c => c.cave_id).join(', ');
        const action = isApprove ? 'auditPassed' : 'auditRejected';
        return sendMessage(session, 'commands.cave.audit.pendingResult', [
          session.text(`commands.cave.audit.${action}`),
          remainingCount,
          remainingIds
        ], false);
      }
      return sendMessage(
        session,
        isApprove ? 'commands.cave.audit.auditPassed' : 'commands.cave.audit.auditRejected',
        [],
        false
      );
    }

    // 处理批量审核
    const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath) : null;
    let processedCount = 0;

    if (isApprove && data) {
      const oldData = [...data];
      const newData = [...data];

      await FileHandler.withTransaction([
        {
          filePath: caveFilePath,
          operation: async () => {
            for (const cave of pendingData) {
              newData.push({
                ...cave,
                cave_id: cave.cave_id,
                elements: cleanElementsForSave(cave.elements, false)
              });
              processedCount++;
              await idManager.addStat(cave.contributor_number, cave.cave_id);
            }
            return FileHandler.writeJsonData(caveFilePath, newData);
          },
          rollback: async () => FileHandler.writeJsonData(caveFilePath, oldData)
        },
        {
          filePath: pendingFilePath,
          operation: async () => FileHandler.writeJsonData(pendingFilePath, []),
          rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
        }
      ]);
    } else {
      // 拒绝审核时，需要将所有ID标记为已删除
      for (const cave of pendingData) {
        await idManager.markDeleted(cave.cave_id);
      }

      await FileHandler.writeJsonData(pendingFilePath, []);
      // 删除所有被拒绝投稿的媒体文件
      for (const cave of pendingData) {
        if (cave.elements) {
          for (const element of cave.elements) {
            if ((element.type === 'img' || element.type === 'video') && element.file) {
              const fullPath = path.join(resourceDir, element.file);
              if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
              }
            }
          }
        }
        processedCount++;
      }
    }

    return sendMessage(session, 'commands.cave.audit.batchAuditResult', [
      isApprove ? '通过' : '拒绝',
      processedCount,
      pendingData.length
    ], false);
  }

  // 注册命令并配置权限检查
  ctx.command('cave [message]')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    .before(async ({ session, options }) => {
      // 黑名单检查
      if (config.blacklist.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.blacklisted', [], true);
      }
      // 审核命令权限检查
      if ((options.p || options.d) && !config.manager.includes(session.userId)) {
        return sendMessage(session, 'commands.cave.message.managerOnly', [], true);
      }
    })
    .action(async ({ session, options }, ...content) => {
      const dataDir = path.join(ctx.baseDir, 'data');
      const caveDir = path.join(dataDir, 'cave');
      const caveFilePath = path.join(caveDir, 'cave.json');
      const resourceDir = path.join(caveDir, 'resources');
      const pendingFilePath = path.join(caveDir, 'pending.json');

      // 基础检查 - 需要冷却的命令
      const needsCooldown = !options.l && !options.a && !options.p && !options.d;
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

      if (options.p || options.d) {
        return await processAudit(pendingFilePath, caveFilePath, resourceDir, session, options, content);
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
    });
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
  duplicateThreshold: number;
  enableDuplicate: boolean;
  enableMD5: boolean;
}

// 定义数据类型接口
interface BaseElement {
  type: 'text' | 'img' | 'video';
  index: number;  // 元素排序索引
}

interface TextElement extends BaseElement {
  type: 'text';
  content: string; // 文本内容
}

interface MediaElement extends BaseElement {
  type: 'img' | 'video';
  file?: string;     // 保存的文件名
  fileName?: string; // 原始文件名
  fileSize?: string; // 文件大小
  filePath?: string; // 文件路径
}
type Element = TextElement | MediaElement;

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

// 审核相关功能
// 发送审核消息给管理员
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string, session: any) {
  const auditMessage = `${session.text('commands.cave.audit.title')}\n${content}
${session.text('commands.cave.audit.from')}${cave.contributor_number}`;

  for (const managerId of config.manager) {
    const bot = ctx.bots[0];
    if (bot) {
      try {
        await bot.sendPrivateMessage(managerId, auditMessage);
      } catch (error) {
        logger.error(session.text('commands.cave.audit.sendFailed', [managerId]));
      }
    }
  }
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

// 媒体处理相关函数
// 从原始内容中提取文本、图片和视频元素
async function extractMediaContent(
  originalContent: string,
  config: Config,
  session: any
): Promise<{
  imageUrls: string[],
  imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>,
  videoUrls: string[],
  videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>,
  textParts: Element[]
}> {
  const textParts = originalContent
    .split(/<(img|video)[^>]+>/)
    .map((text, idx) => text.trim() && ({
      type: 'text' as const,
      content: text.replace(/^(img|video)$/, '').trim(),
      index: idx * 3
    }))
    .filter(text => text && text.content);

  const getMediaElements = (type: 'img' | 'video', maxSize: number) => {
    const regex = new RegExp(`<${type}[^>]+src="([^"]+)"[^>]*>`, 'g');
    const elements: Array<{ type: typeof type; index: number; fileName?: string; fileSize?: string }> = [];
    const urls: string[] = [];

    let match;
    let idx = 0;
    while ((match = regex.exec(originalContent)) !== null) {
      const element = match[0];
      const url = match[1];
      const fileName = element.match(/file="([^"]+)"/)?.[1];
      const fileSize = element.match(/fileSize="([^"]+)"/)?.[1];

      if (fileSize) {
        const sizeInBytes = parseInt(fileSize);
        if (sizeInBytes > maxSize * 1024 * 1024) {
          throw new Error(session.text('commands.cave.message.mediaSizeExceeded', [type]));
        }
      }

      urls.push(url);
      elements.push({
        type,
        index: type === 'video' ? Number.MAX_SAFE_INTEGER : idx * 3 + 1,
        fileName,
        fileSize
      });
      idx++;
    }
    return { urls, elements };
  };

  // 分别检查图片和视频
  const { urls: imageUrls, elements: imageElementsRaw } = getMediaElements('img', config.imageMaxSize);
  const imageElements = imageElementsRaw as Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  const { urls: videoUrls, elements: videoElementsRaw } = getMediaElements('video', config.videoMaxSize);
  const videoElements = videoElementsRaw as Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

// 下载并保存媒体文件到本地
async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  mediaType: 'img' | 'video',
  config: Config,
  ctx: Context,
  session: any
): Promise<string[]> {
  const accept = mediaType === 'img' ? 'image/*' : 'video/*';
  const hashStorage = new HashStorage(path.join(ctx.baseDir, 'data', 'cave'));
  await hashStorage.initialize();

  const downloadTasks = urls.map(async (url, i) => {
    const fileName = fileNames[i];
    const ext = path.extname(fileName || url) || (mediaType === 'img' ? '.png' : '.mp4');

    try {
      const response = await ctx.http(decodeURIComponent(url).replace(/&amp;/g, '&'), {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': accept,
          'Referer': 'https://qq.com'
        }
      });

      if (!response.data) throw new Error('empty_response');
      const buffer = Buffer.from(response.data);

      if (mediaType === 'img') {
        // 获取原始文件名(MD5)
        const baseName = path.basename(fileName || 'md5', ext).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

        // 如果启用了MD5查重，检查是否存在相同MD5的文件
        if (config.enableMD5) {
          const files = await fs.promises.readdir(resourceDir);
          const duplicateFile = files.find(file => file.startsWith(baseName + '_'));

          if (duplicateFile) {
            const duplicateCaveId = parseInt(duplicateFile.split('_')[1]);
            if (!isNaN(duplicateCaveId)) {
              const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
              const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
              const originalCave = data.find(item => item.cave_id === duplicateCaveId);

              if (originalCave) {
                const message = session.text('commands.cave.error.exactDuplicateFound');
                await session.send(message + await buildMessage(originalCave, resourceDir, session));
                throw new Error('duplicate_found');
              }
            }
          }
        }

        // 如果启用了相似度查重，进行perceptual hash比较
        if (config.enableDuplicate) {
          const hashStorage = new HashStorage(path.join(ctx.baseDir, 'data', 'cave'));
          await hashStorage.initialize();
          const result = await hashStorage.findDuplicates('image', [buffer.toString('base64')], config.duplicateThreshold);

          if (result.length > 0 && result[0] !== null) {
            const duplicate = result[0];
            const similarity = duplicate.similarity;

            if (similarity >= config.duplicateThreshold) {
              const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
              const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
              const originalCave = data.find(item => item.cave_id === duplicate.caveId);

              if (originalCave) {
                const message = session.text('commands.cave.error.similarDuplicateFound',
                  [(similarity * 100).toFixed(1)]);
                await session.send(message + await buildMessage(originalCave, resourceDir, session));
                throw new Error('duplicate_found');
              }
            }
          }
        }

        // 使用原始文件名(MD5)作为文件名的一部分
        const finalFileName = `${caveId}_${baseName}${ext}`;
        const filePath = path.join(resourceDir, finalFileName);

        await FileHandler.saveMediaFile(filePath, buffer);
        return finalFileName;
      } else {
        // 新增视频文件MD5查重逻辑（与图片一致）
        const baseName = path.basename(fileName || 'video', ext).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
        if (config.enableMD5) {
          const files = await fs.promises.readdir(resourceDir);
          const duplicateFile = files.find(file => file.startsWith(baseName + '_'));
          if (duplicateFile) {
            const duplicateCaveId = parseInt(duplicateFile.split('_')[1]);
            if (!isNaN(duplicateCaveId)) {
              const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
              const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
              const originalCave = data.find(item => item.cave_id === duplicateCaveId);
              if (originalCave) {
                const message = session.text('commands.cave.error.exactDuplicateFound');
                await session.send(message + await buildMessage(originalCave, resourceDir, session));
                throw new Error('duplicate_found');
              }
            }
          }
        }
        const finalFileName = `${caveId}_${baseName}${ext}`;
        const filePath = path.join(resourceDir, finalFileName);
        await FileHandler.saveMediaFile(filePath, buffer);
        return finalFileName;
      }
    } catch (error) {
      if (error.message === 'duplicate_found') {
        throw error;
      }
      logger.error(`Failed to download media: ${error.message}`);
      throw new Error(session.text(`commands.cave.error.upload${mediaType === 'img' ? 'Image' : 'Video'}Failed`));
    }
  });
  return Promise.all(downloadTasks);
}
