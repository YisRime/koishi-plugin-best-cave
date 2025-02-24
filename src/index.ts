import { Context, Schema, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';
import { FileHandler } from './utils/FileHandler'
import { IdManager } from './utils/IdManager'
import { HashManager } from './utils/HashManager'
import { AuditManager } from './utils/AuditHandler'
import { extractMediaContent, saveMedia, buildMessage, sendMessage } from './utils/MediaHandler'
import { processList, processView, processRandom, processDelete } from './utils/ProcessHandle'

export const name = 'best-cave';
export const inject = ['database'];

const logger = new Logger('cave');

/**
 * 基础元素类型
 * @interface BaseElement
 * @property {('text'|'img'|'video')} type - 元素类型
 * @property {number} index - 排序索引
 */
export interface BaseElement {
  type: 'text' | 'img' | 'video'
  index: number
}

/**
 * 文本元素类型
 * @interface TextElement
 * @extends {BaseElement}
 * @property {'text'} type - 文本类型
 * @property {string} content - 文本内容
 */
export interface TextElement extends BaseElement {
  type: 'text'
  content: string
}

/**
 * 媒体元素类型
 * @interface MediaElement
 * @extends {BaseElement}
 * @property {('img'|'video')} type - 媒体类型
 * @property {string} [file] - 文件名
 * @property {string} [fileName] - 原始文件名
 * @property {string} [fileSize] - 文件大小
 * @property {string} [filePath] - 文件路径
 */
export interface MediaElement extends BaseElement {
  type: 'img' | 'video'
  file?: string
  fileName?: string
  fileSize?: string
  filePath?: string
}

export type Element = TextElement | MediaElement

/**
 * 回声洞对象
 * @interface CaveObject
 * @property {number} cave_id - 回声洞ID
 * @property {Element[]} elements - 元素列表
 * @property {string} contributor_number - 投稿者ID
 * @property {string} contributor_name - 投稿者名称
 */
export interface CaveObject {
  cave_id: number
  elements: Element[]
  contributor_number: string
  contributor_name: string
}

export interface PendingCave extends CaveObject {}

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
  enableImageDuplicate: boolean;
  imageDuplicateThreshold: number;
  textDuplicateThreshold: number;
  enableTextDuplicate: boolean;
}

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
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(path.join(caveDir, 'resources'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'cave.json'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'pending.json'));
  await FileHandler.ensureJsonFile(path.join(caveDir, 'hash.json'));

  // 初始化核心组件
  const idManager = new IdManager(ctx.baseDir);
  const contentHashManager = new HashManager(caveDir);
  const auditManager = new AuditManager(ctx, config, idManager);

  // 等待所有组件初始化完成
  await Promise.all([
    idManager.initialize(path.join(caveDir, 'cave.json'), path.join(caveDir, 'pending.json')),
    contentHashManager.initialize()
  ]);

  const lastUsed = new Map<string, number>();

  /**
   * 处理添加回声洞命令
   * @param {Context} ctx - Koishi上下文
   * @param {Config} config - 插件配置
   * @param {string} caveFilePath - 回声洞数据文件路径
   * @param {string} resourceDir - 资源目录路径
   * @param {string} pendingFilePath - 待审核数据文件路径
   * @param {any} session - 会话对象
   * @param {string[]} content - 投稿内容
   * @returns {Promise<string>} 处理结果消息
   */
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
          imageBuffers
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
            index: el.index
          }))
        ].sort((a, b) => a.index - b.index),
        contributor_number: session.userId || '100000',
        contributor_name: session.username || 'User'
      };

      // 视频直接添加到elements末尾
      if (videoUrls.length > 0 && savedVideos.length > 0) {
        newCave.elements.push({
          type: 'video',
          file: savedVideos[0],
          index: Number.MAX_SAFE_INTEGER
        });
      }

      // 检查是否有hash记录
      const hashStorage = new HashManager(path.join(ctx.baseDir, 'data', 'cave'));
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

      const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
      data.push({
        ...newCave,
        elements: cleanElementsForSave(newCave.elements, false)
      });

      // 检查内容重复
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
    .before(async ({ session }) => {
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
              return await processList(session, config, idManager, undefined, num);
            } else {
              return await processList(session, config, idManager, num.toString());
            }
          } else if (input) {
            return await processList(session, config, idManager, input);
          }
          return await processList(session, config, idManager);
        } else {
          return await processList(session, config, idManager, session.userId);
        }
      }

      if (options.g) {
        return await processView(caveFilePath, resourceDir, session, options, content);
      }

      if (options.r) {
        return await processDelete(caveFilePath, resourceDir, pendingFilePath, session, config, options, content, idManager, contentHashManager);
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

/**
 * 清理元素数据用于保存
 * @param {Element[]} elements - 要清理的元素数组
 * @param {boolean} [keepIndex=false] - 是否保留索引
 * @returns {Element[]} 清理后的元素数组
 */
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
