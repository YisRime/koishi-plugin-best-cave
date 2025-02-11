// -------- 导入依赖、接口定义与配置 --------
// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

// 基础定义
export const name = 'best-cave';
export const inject = ['database'];

// 配置Schema
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required(),
  blacklist: Schema.array(Schema.string()).default([]),
  whitelist: Schema.array(Schema.string()).default([]),
  number: Schema.number().default(60),
  enableAudit: Schema.boolean().default(false),
  allowVideo: Schema.boolean().default(true),
  videoMaxSize: Schema.number().default(16),
  imageMaxSize: Schema.number().default(4),
  enablePagination: Schema.boolean().default(false),
  itemsPerPage: Schema.number().default(10),
}).i18n({
  'zh-CN': require('./locales/zh-CN')._config,
  'en-US': require('./locales/en-US')._config,
});

// 插件主函数：初始化和命令注册
export async function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
  ctx.i18n.define('en-US', require('./locales/en-US'));

  // 初始化路径和冷却管理
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');
  const caveFilePath = path.join(caveDir, 'cave.json');
  const resourceDir = path.join(caveDir, 'resources');
  const pendingFilePath = path.join(caveDir, 'pending.json');

  await FileHandler.ensureDirectory(dataDir);
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(resourceDir);
  await FileHandler.ensureJsonFile(caveFilePath);
  await FileHandler.ensureJsonFile(pendingFilePath);

  const lastUsed: Map<string, number> = new Map();

  // 提取为独立函数
  async function processList(
    caveFilePath: string,
    session: any,
    content: string[],
    options: any,
    config: Config
  ): Promise<string> {
    const caveData = await CacheManager.getCaveData(caveFilePath, session);
    const caveDir = path.dirname(caveFilePath);
    const stats: Record<string, number[]> = {};
    for (const cave of caveData) {
      if (cave.contributor_number === '10000') continue;
      if (!stats[cave.contributor_number]) stats[cave.contributor_number] = [];
      stats[cave.contributor_number].push(cave.cave_id);
    }
    const statFilePath = path.join(caveDir, 'stat.json');
    fs.writeFileSync(statFilePath, JSON.stringify(stats, null, 2), 'utf8');
    const lines: string[] = Object.entries(stats).map(([cid, ids]) => {
      return session.text('commands.cave.list.totalItems', [cid, ids.length]) + '\n' +
             session.text('commands.cave.list.idsLine', [ids.join(',')]);
    });
    // 修改处：计算总投稿数
    const totalSubmissions = Object.values(stats).reduce((sum, arr) => sum + arr.length, 0);
    if (config.enablePagination) {
      const itemsPerPage = config.itemsPerPage;
      const totalPages = Math.max(1, Math.ceil(lines.length / itemsPerPage));
      let query = (content[0] || String(options.l) || '').trim();
      let pageNum = parseInt(query, 10);
      if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
      if (pageNum > totalPages) pageNum = totalPages;
      const start = (pageNum - 1) * itemsPerPage;
      const paginatedLines = lines.slice(start, start + itemsPerPage);
      // 调整返回顺序：先统计头部和分页数据，再显示分页信息
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             paginatedLines.join('\n') + '\n' +
             session.text('commands.cave.list.pageInfo', [pageNum, totalPages]);
    } else {
      return session.text('commands.cave.list.header', [totalSubmissions]) + '\n' +
             lines.join('\n');
    }
  }

  async function processAudit(
    ctx: Context,
    pendingFilePath: string,
    caveFilePath: string,
    resourceDir: string,
    session: any,
    options: any,
    content: string[]
  ): Promise<string> {
    const pendingData = await CacheManager.getPendingData(pendingFilePath, session);
    const isApprove = Boolean(options.p);
    if ((options.p === true && content[0] === 'all') ||
        (options.d === true && content[0] === 'all')) {
      return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session);
    }
    const id = parseInt(content[0] ||
      (typeof options.p === 'string' ? options.p : '') ||
      (typeof options.d === 'string' ? options.d : ''));
    if (isNaN(id)) {
      return sendMessage(session, 'commands.cave.error.invalidId', [], true);
    }
    return sendMessage(session, await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, session, id), [], true);
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
    const data = await CacheManager.getCaveData(caveFilePath, session);
    const cave = data.find(item => item.cave_id === caveId);
    if (!cave) return sendMessage(session, 'commands.cave.error.notFound', [], true);

    // 调用修改后的 buildMessage 发送视频消息内部处理
    const caveContent = await buildMessage(cave, resourceDir, session);
    return caveContent;
  }

  async function processRandom(
    caveFilePath: string,
    resourceDir: string,
    session: any,
    config: Config,
    lastUsed: Map<string, number>
  ): Promise<string | void> {
    try {
      // 抽取符合条件的随机回声洞
      const data = await CacheManager.getCaveData(caveFilePath, session);
      if (data.length === 0) {
        return sendMessage(session, 'commands.cave.error.noCave', [], true);
      }
      const guildId = session.guildId;
      const now = Date.now();
      const lastCall = lastUsed.get(guildId) || 0;
      const isManager = config.manager.includes(session.userId);
      if (!isManager && now - lastCall < config.number * 1000) {
        const waitTime = Math.ceil((config.number * 1000 - (now - lastCall)) / 1000);
        return sendMessage(session, 'commands.cave.message.cooldown', [waitTime], true);
      }
      if (!isManager) lastUsed.set(guildId, now);
      const cave = (() => {
        const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
        if (!validCaves.length) return undefined;
        const randomIndex = Math.floor(Math.random() * validCaves.length);
        return validCaves[randomIndex];
      })();
      return cave ? buildMessage(cave, resourceDir, session)
                  : sendMessage(session, 'commands.cave.error.getCave', [], true);
    } catch (error) {
      return sendMessage(session, 'commands.cave.error.commandProcess', [error.message], true);
    }
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
    const data = await CacheManager.getCaveData(caveFilePath, session);
    const pendingData = await CacheManager.getPendingData(pendingFilePath, session);
    const index = data.findIndex(item => item.cave_id === caveId);
    const pendingIndex = pendingData.findIndex(item => item.cave_id === caveId);
    if (index === -1 && pendingIndex === -1) return sendMessage(session, 'commands.cave.error.notFound', [], true);
    let targetCave: CaveObject;
    let isPending = false;
    if (index !== -1) {
      targetCave = data[index];
    } else {
      targetCave = pendingData[pendingIndex];
      isPending = true;
    }
    if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
      return sendMessage(session, 'commands.cave.remove.noPermission', [], true);
    }

    // 先生成回声洞预览消息（图片等媒体将被嵌入）
    const caveContent = await buildMessage(targetCave, resourceDir, session);

    if (targetCave.elements) {
      for (const element of targetCave.elements) {
        if ((element.type === 'img' || element.type === 'video') && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    }
    // 返回预览消息后再更新数据文件
    if (isPending) {
      pendingData.splice(pendingIndex, 1);
      await FileHandler.writeJsonData(pendingFilePath, pendingData, session);
      const deleteStatus = isPending
        ? session.text('commands.cave.remove.deletePending')
        : '';
      const deleteMessage = session.text('commands.cave.remove.deleted');
      return `${deleteMessage}${deleteStatus}\n${caveContent}`;
    } else {
      data.splice(index, 1);
      await FileHandler.writeJsonData(caveFilePath, data, session);
      const deleteStatus = isPending
        ? session.text('commands.cave.remove.deletePending')
        : '';
      const deleteMessage = session.text('commands.cave.remove.deleted');
      return `${deleteMessage}${deleteStatus}${caveContent}`;
    }
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
      // 1. 收集所有输入内容
      let inputParts: string[] = [];

      // 读取命令后的内容（如果有）
      if (content.length > 0) {
        inputParts = content;
      }

      // 如果没有任何内容，进入提示流程
      if (!inputParts.length) {
        await sendMessage(session, 'commands.cave.add.noContent', [], true);
        const reply = await session.prompt({ timeout: 60000 });
        if (!reply || reply.trim() === "") {
          return sendMessage(session, 'commands.cave.add.operationTimeout', [], true);
        }
        inputParts = [reply];
      }

      // 检查是否包含本地文件路径
      const combinedInput = inputParts.join('\n');
      if (combinedInput.includes('/app/.config/QQ/')) {
        return sendMessage(session, 'commands.cave.add.localFileNotAllowed', [], true);
      }

      // 提取媒体内容
      let { imageUrls, imageElements, videoUrls, videoElements, textParts } = await extractMediaContent(combinedInput);

      // 检查配置：是否允许添加视频
      if (videoUrls.length > 0 && !config.allowVideo) {
        return sendMessage(session, 'commands.cave.add.videoDisabled', [], true);
      }

      // 生成新的回声洞ID及处理媒体文件
      const pendingData = await CacheManager.getPendingData(pendingFilePath, session);
      const data = await CacheManager.getCaveData(caveFilePath, session);

      // 修复获取maxid问题：检测中间是否有空缺，使用最小可用ID
      const usedIds = new Set<number>([...data.map(item => item.cave_id), ...pendingData.map(item => item.cave_id)]);
      let caveId = 1;
      while (usedIds.has(caveId)) {
        caveId++;
      }

      let savedImages: string[] = [];
      if (imageUrls.length > 0) {
        try {
          const imageFileNames = imageElements.map(el => el.fileName);
          const imageFileSizes = imageElements.map(el => el.fileSize);
          savedImages = await saveMedia(
            imageUrls,
            imageFileNames,
            imageFileSizes,
            resourceDir,
            caveId,
            config,
            ctx,
            'img',
            session
          );
        } catch (error) {
          return sendMessage(session, 'commands.cave.error.uploadImageFailed', [], true);
        }
      }

      let savedVideos: string[] = [];
      if (videoUrls.length > 0) {
        try {
          const videoFileNames = videoElements.map(el => el.fileName);
          const videoFileSizes = videoElements.map(el => el.fileSize);
          savedVideos = await saveMedia(
            videoUrls,
            videoFileNames,
            videoFileSizes,
            resourceDir,
            caveId,
            config,
            ctx,
            'video',
            session
          );
        } catch (error) {
          return sendMessage(session, 'commands.cave.error.uploadVideoFailed', [], true);
        }
      }

      // 合并所有元素：文本/图片/视频
      const elements: Element[] = [];
      elements.push(...textParts);
      savedImages.forEach((file, idx) => {
        if (imageElements[idx]) {
          elements.push({ ...imageElements[idx], type: 'img', file });
        }
      });
      savedVideos.forEach((file, idx) => {
        if (videoElements[idx]) {
          elements.push({ ...videoElements[idx], type: 'video', file });
        }
      });
      elements.sort((a, b) => a.index - b.index);

      // 获取投稿者信息保持不变
      let contributorName = session.username;
      if (ctx.database) {
        try {
          const userInfo = await ctx.database.getUser(session.platform, session.userId);
          contributorName = (userInfo as unknown as User)?.nickname || session.username;
        } catch (error) {
          return sendMessage(
            session,
            'commands.cave.error.userInfo',
            [error.message],
            true
          );
        }
      }

      const newCave: CaveObject = {
        cave_id: caveId,
        elements: cleanElementsForSave(elements, true),
        contributor_number: session.userId,
        contributor_name: contributorName
      };

      // 判断是否绕过审核：白名单包括用户、群组和频道
      const bypassAudit = config.whitelist.includes(session.userId) ||
                      (session.guildId && config.whitelist.includes(session.guildId)) ||
                      (session.channelId && config.whitelist.includes(session.channelId));
      if (config.enableAudit && !bypassAudit) {
        pendingData.push({ ...newCave, elements: cleanElementsForSave(elements, true) });
        await FileHandler.writeJsonData(pendingFilePath, pendingData, session);
        await sendAuditMessage(ctx, config, newCave, await buildMessage(newCave, resourceDir, session), session);
        return sendMessage(session, 'commands.cave.add.submitPending', [caveId], false);
      } else {
        const caveWithoutIndex = { ...newCave, elements: cleanElementsForSave(elements, false) };
        data.push(caveWithoutIndex);
        await FileHandler.writeJsonData(caveFilePath, data, session);
        return sendMessage(session, 'commands.cave.add.addSuccess', [caveId], false);
      }
    } catch (error) {
      return sendMessage(session, 'commands.cave.error.commandProcess', [error.message], true);
    }
  }

  // 注册命令并配置权限检查
  ctx.command('cave [message]')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    // 仅对 -l、-p 和 -d 指令进行权限检查
    .before(async ({ session, options }) => {
      // 黑名单检查
      if (config.blacklist.includes(session.userId)) {
        return sendTempMessage(session, 'commands.cave.message.blacklisted');
      }
      // 如果输入内容包含 "-help"，不进行权限检查
      if (session.content && session.content.includes('-help')) return;
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return sendTempMessage(session, 'commands.cave.message.managerOnly');
      }
    })
    .action(async ({ session, options }, ...content) => {
      try {
        // 使用上下文中已定义的文件路径变量
        const dataDir = path.join(ctx.baseDir, 'data');
        const caveDir = path.join(dataDir, 'cave');
        const caveFilePath = path.join(caveDir, 'cave.json');
        const resourceDir = path.join(caveDir, 'resources');
        const pendingFilePath = path.join(caveDir, 'pending.json');

        // 直接调用相应的处理函数
        if (options.l !== undefined) {
          return await processList(caveFilePath, session, content, options, config);
        }
        if (options.p || options.d) {
          return await processAudit(ctx, pendingFilePath, caveFilePath, resourceDir, session, options, content);
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
        return await processRandom(caveFilePath, resourceDir, session, config, lastUsed);
      } catch (error) {
        logger.error(error);
        return sendMessage(session, 'commands.cave.error.commandProcess', [error.message], true);
      }
    });
}

// 日志记录器
const logger = new Logger('cave');

// 接口定义
export interface User {
  userId: string;
  username: string;
  nickname?: string;
}

export interface getStrangerInfo {
  user_id: string;
  nickname: string;
}

export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;
  allowVideo: boolean;
  videoMaxSize: number;
  imageMaxSize: number;  // 新增属性
  blacklist: string[];  // 新增属性
  whitelist: string[]; // 新增白名单属性
  enablePagination: boolean;
  itemsPerPage: number;
}

// 定义数据类型接口
interface Element {
  type: 'text' | 'img' | 'video';
  content?: string;      // 文本内容
  file?: string;         // 图片或视频文件名
  index: number;         // 排序索引
}

// 定义回声洞数据结构
interface CaveObject {
  cave_id: number;             // 回声洞唯一ID
  elements: Element[];         // 内容元素数组
  contributor_number: string;  // 投稿者ID
  contributor_name: string;    // 投稿者昵称
}

interface PendingCave extends CaveObject {}

// -------- 新增：文件处理类 --------
// 修改 FileHandler 类以接收 session 参数
class FileHandler {
  private static writeQueue = new Map<string, Promise<void>>();

  static async readJsonData<T>(filePath: string, session: any, validator?: (item: any) => boolean): Promise<T[]> {
    try {
      const data = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(data || '[]');
      return Array.isArray(parsed) ? (validator ? parsed.filter(validator) : parsed) : [];
    } catch (error) {
      logger.error(session.text('commands.cave.error.fileRead', [error.message]));
      return [];
    }
  }

  static async writeJsonData<T>(filePath: string, data: T[], session: any): Promise<void> {
    const queueKey = filePath;

    const writeOperation = async () => {
      try {
        const jsonString = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(filePath, jsonString, 'utf8');
      } catch (error) {
        logger.error(session.text('commands.cave.error.fileWrite', [error.message]));
        throw new Error(session.text('commands.cave.error.saveFailed'));
      }
    };

    // 队列写入操作
    if (!this.writeQueue.has(queueKey)) {
      this.writeQueue.set(queueKey, Promise.resolve());
    }

    const currentPromise = this.writeQueue.get(queueKey)!
      .then(writeOperation)
      .finally(() => {
        if (this.writeQueue.get(queueKey) === currentPromise) {
          this.writeQueue.delete(queueKey);
        }
      });

    this.writeQueue.set(queueKey, currentPromise);
    return currentPromise;
  }

  static async ensureDirectory(dir: string): Promise<void> {
    !fs.existsSync(dir) && await fs.promises.mkdir(dir, { recursive: true });
  }

  static async ensureJsonFile(filePath: string, defaultContent = '[]'): Promise<void> {
    !fs.existsSync(filePath) && await fs.promises.writeFile(filePath, defaultContent, 'utf8');
  }
}

// -------- 图片及视频处理函数 --------
async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  fileSizes: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  config: Config,
  ctx: Context,
  mediaType: 'img' | 'video',
  session: any
): Promise<string[]> {
  const defaults = mediaType === 'img'
    ? { ext: 'png', accept: 'image/*', maxSize: config.imageMaxSize }
    : { ext: 'mp4', accept: 'video/*', maxSize: config.videoMaxSize };
  const extPattern = /\.[a-zA-Z0-9]+$/;

  const downloadPromises = urls.map(async (url, i) => {
    try {
      const processedUrl = (() => {
        try {
          const decodedUrl = decodeURIComponent(url);
          return decodedUrl.includes('multimedia.nt.qq.com.cn') ? decodedUrl.replace(/&amp;/g, '&') : url;
        } catch {
          return url;
        }
      })();

      let ext = defaults.ext;
      const fileName = fileNames[i];
      const fileSize = fileSizes[i];

      // 检查文件大小
      if (fileSize) {
        const sizeInBytes = parseInt(fileSize);
        if (sizeInBytes > defaults.maxSize * 1024 * 1024) {
          logger.warn(session.text('commands.cave.message.mediaSizeExceeded', [mediaType]));
          return null;
        }
      }

      // 处理文件名和扩展名
      if (fileName && extPattern.test(fileName)) {
        ext = fileName.match(extPattern)![0].slice(1);
      }

      // 生成最终的文件名
      const finalFileName = fileName
        ? `${caveId}_${path.basename(fileName)}`
        : `${caveId}_${i + 1}.${ext}`;

      // ...其余下载和保存逻辑保持不变...
      const targetPath = path.join(resourceDir, finalFileName);
      const response = await ctx.http(processedUrl, {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': defaults.accept,
          'Referer': 'https://qq.com'
        }
      });

      const fileBuffer = Buffer.from(response.data);
      await fs.promises.writeFile(targetPath, fileBuffer);
      return finalFileName;
    } catch (error) {
      const errorKey = mediaType === 'img'
        ? 'commands.cave.error.uploadImageFailed' // 修改合并后的错误键
        : 'commands.cave.error.uploadVideoFailed';
      await sendTempMessage(session, errorKey);
      return null;
    }
  });

  const results = await Promise.all(downloadPromises);
  return results.filter((name): name is string => name !== null);
}

// -------- 审核相关函数 --------
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string, session: any) {
  const auditMessage = `${session.text('commands.cave.audit.title')}\n${content}
${session.text('commands.cave.audit.from')}${cave.contributor_number}`;

  for (const managerId of config.manager) {
    try {
      await ctx.bots[0]?.sendPrivateMessage(managerId, auditMessage);
    } catch (error) {
      logger.error(session.text('commands.cave.audit.sendFailed', [managerId]));
    }
  }
}

// 审核相关函数
async function handleSingleCaveAudit(
  ctx: Context,
  cave: PendingCave,
  isApprove: boolean,
  resourceDir: string,
  data?: CaveObject[],
  session?: any
): Promise<boolean | string> {
  // 处理单个审核项，根据审批状态更新数据或删除文件
  try {
    if (isApprove && data) {
      // 保存经过清理的回声洞数据
      const caveWithoutIndex = {
        ...cave,
        elements: cleanElementsForSave(cave.elements, false)
      };
      data.push(caveWithoutIndex);
    } else if (!isApprove && cave.elements) {
      // 删除与回声洞关联的媒体文件
      for (const element of cave.elements) {
        if (element.type === 'img' && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    }
    return true;
  } catch (error) {
    return sendTempMessage(session, 'commands.cave.error.auditProcess', [error.message]);
  }
}

async function handleAudit(
  ctx: Context,
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string,
  session: any,
  targetId?: number
): Promise<string> {
  // 处理审核操作，支持单条及批量处理
  if (pendingData.length === 0) return sendMessage(session, 'commands.cave.audit.noPending', [], true);

  // 处理单条审核
  if (typeof targetId === 'number') {
    const pendingIndex = pendingData.findIndex(item => item.cave_id === targetId);
    if (pendingIndex === -1) return sendMessage(session, 'commands.cave.audit.pendingNotFound', [], true);

    const cave = pendingData[pendingIndex];
    const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath, session) : null;

    const auditResult = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data, session);
    if (typeof auditResult === 'string') return auditResult;
    if (isApprove && data) await FileHandler.writeJsonData(caveFilePath, data, session);

    pendingData.splice(pendingIndex, 1);
    await FileHandler.writeJsonData(pendingFilePath, pendingData, session);

    const remainingCount = pendingData.length;
    if (remainingCount > 0) {
      const remainingIds = pendingData.map(c => c.cave_id).join(', ');
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
      false // 审核结果改为永久消息
    );
  }

  // 处理批量审核
  const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath, session) : null;
  let processedCount = 0;

  for (const cave of pendingData) {
    await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data, session) && processedCount++;
  }

  if (isApprove && data) await FileHandler.writeJsonData(caveFilePath, data, session);
  await FileHandler.writeJsonData(pendingFilePath, [], session);

  return sendMessage(session, 'commands.cave.audit.batchAuditResult', [
    isApprove ? '通过' : '拒绝',
    processedCount,
    pendingData.length
  ], false); // 批量审核结果改为永久消息
}

// -------- 消息构建函数 --------
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  // 清理元素对象，移除无关属性，并排序
  const sorted = elements.sort((a, b) => a.index - b.index);
  return sorted.map(({ type, content, file, index }) => ({
    type,
    ...(keepIndex && { index }),
    ...(content && { content }),
    ...(file && { file })
  }));
}

// 添加辅助函数到文件开头的函数定义区域
async function sendTempMessage(session: any, key: string, params: any[] = [], timeout = 10000): Promise<string> {
  const msg = await session.send(session.text(key, params));
  setTimeout(async () => {
    try {
      await session.bot.deleteMessage(session.channelId, msg);
    } catch (error) {
      logger.error('Failed to delete message:', error);
    }
  }, timeout);
  return '';  // 返回空字符串避免重复发送
}

// 修改 sendMessage 函数替换原有的 sendTempMessage
const messageQueue = new Map<string, Promise<void>>();
async function sendMessage(session: any, key: string, params: any[] = [], isTemp = true, timeout = 10000): Promise<string> {
  const channelId = session.channelId;

  const sendOperation = async () => {
    const msg = await session.send(session.text(key, params));
    if (isTemp) {
      setTimeout(async () => {
        try {
          await session.bot.deleteMessage(channelId, msg);
        } catch (error) {
          logger.error('Failed to delete message:', error);
        }
      }, timeout);
    }
  };

  if (!messageQueue.has(channelId)) {
    messageQueue.set(channelId, Promise.resolve());
  }

  const currentPromise = messageQueue.get(channelId)!
    .then(sendOperation)
    .finally(() => {
      if (messageQueue.get(channelId) === currentPromise) {
        messageQueue.delete(channelId);
      }
    });

  messageQueue.set(channelId, currentPromise);
  return '';
}

// 媒体处理及回复
async function extractMediaContent(originalContent: string): Promise<{
  imageUrls: string[],
  imageElements: { type: 'img'; index: number; fileName?: string; fileSize?: string }[],
  videoUrls: string[],
  videoElements: { type: 'video'; index: number; fileName?: string; fileSize?: string }[],
  textParts: Element[]
}> {
  // 拆分文本与媒体标签，并分别提取相关信息
  const parsedTexts = originalContent
    .split(/<img[^>]+>|<video[^>]+>/g)
    .map(t => t.trim())
    .filter(t => t);
  const textParts: Element[] = [];
  parsedTexts.forEach((text, idx) => {
    textParts.push({ type: 'text', content: text, index: idx * 3 });
  });

  // 初始化数组用于存储媒体链接与元素信息
  const imageUrls: string[] = [];
  const imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }> = [];
  const videoUrls: string[] = [];
  const videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }> = [];

  // 提取 <img> 标签中的 src 和 file 属性
  const imgMatches = originalContent.match(/<img[^>]+src="([^"]+)"[^>]*>/g) || [];
  imgMatches.forEach((img, idx) => {
    const srcMatch = img.match(/src="([^"]+)"/);
    const fileName = img.match(/file="([^"]+)"/)?.[1];
    const fileSize = img.match(/fileSize="([^"]+)"/)?.[1];
    if (srcMatch?.[1]) {
      imageUrls.push(srcMatch[1]);
      imageElements.push({ type: 'img', index: idx * 3 + 1, fileName, fileSize });
    }
  });

  // 提取 <video> 标签中的 src 与 file 属性
  const videoMatches = originalContent.match(/<video[^>]+src="([^"]+)"[^>]*>/g) || [];
  videoMatches.forEach((video, idx) => {
    const srcMatch = video.match(/src="([^"]+)"/);
    const fileName = video.match(/file="([^"]+)"/)?.[1];
    const fileSize = video.match(/fileSize="([^"]+)"/)?.[1];
    if (srcMatch?.[1]) {
      videoUrls.push(srcMatch[1]);
      videoElements.push({ type: 'video', index: idx * 3 + 2, fileName, fileSize });
    }
  });

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  // 构建回声洞消息文本，并处理视频的单独发送
  let content = session.text('commands.cave.message.caveTitle', [cave.cave_id]) + '\n';
  const videoElements: { file: string }[] = [];
  for (const element of cave.elements) {
    if (element.type === 'text') {
      // 追加文本段落
      content += element.content + '\n';
    } else if (element.type === 'img' && element.file) {
      const fullImagePath = path.join(resourceDir, element.file);
      if (fs.existsSync(fullImagePath)) {
        try {
          const imageBuffer = fs.readFileSync(fullImagePath);
          content += h('image', { src: `data:image/png;base64,${imageBuffer.toString('base64')}` }) + '\n';
        } catch (error) {
          content += session.text('commands.cave.error.mediaLoadFailed', ['图片']) + '\n';
        }
      } else {
        content += session.text('commands.cave.message.mediaInvalid', ['图片']) + '\n';
      }
    } else if (element.type === 'video' && element.file) {
      // 将视频元素存入数组，待后续单独发送
      videoElements.push({ file: element.file });
    }
  }
  if (videoElements.length > 0 && session) {
    // 通知用户视频已单独发送
    content += session.text('commands.cave.message.videoSending') + '\n';
    for (const video of videoElements) {
      const fullVideoPath = path.join(resourceDir, video.file);
      if (fs.existsSync(fullVideoPath)) {
        try {
          const videoBuffer = fs.readFileSync(fullVideoPath);
          // 不等待 session.send 完成，异步发送视频消息
          session.send(h('video', { src: `data:video/mp4;base64,${videoBuffer.toString('base64')}` }))
            .catch((error) => logger.warn(session.text('commands.cave.error.videoSendFailed'), error.message));
        } catch (error) {
          content += session.text('commands.cave.error.mediaLoadFailed', ['视频']) + '\n';
        }
      } else {
        content += session.text('commands.cave.message.mediaInvalid', ['视频']) + '\n';
      }
    }
  }
  content += session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]);
  return content;
}

// -------- 主业务函数 --------
// 删除原有的 handleCaveAction 函数

// 添加缓存管理类
class CacheManager {
  private static caveDataCache: CaveObject[] | null = null;
  private static pendingDataCache: PendingCave[] | null = null;
  private static cacheTimeout = 5 * 60 * 1000; // 5分钟缓存
  private static lastCaveUpdate = 0;
  private static lastPendingUpdate = 0;

  static clearCache() {
    this.caveDataCache = null;
    this.pendingDataCache = null;
  }

  static async getCaveData(filePath: string, session: any): Promise<CaveObject[]> {
    const now = Date.now();
    if (!this.caveDataCache || now - this.lastCaveUpdate > this.cacheTimeout) {
      this.caveDataCache = await FileHandler.readJsonData<CaveObject>(filePath, session);
      this.lastCaveUpdate = now;
    }
    return this.caveDataCache;
  }

  static async getPendingData(filePath: string, session: any): Promise<PendingCave[]> {
    const now = Date.now();
    if (!this.pendingDataCache || now - this.lastPendingUpdate > this.cacheTimeout) {
      this.pendingDataCache = await FileHandler.readJsonData<PendingCave>(filePath, session);
      this.lastPendingUpdate = now;
    }
    return this.pendingDataCache;
  }

  static updateCaveData(data: CaveObject[]) {
    this.caveDataCache = data;
    this.lastCaveUpdate = Date.now();
  }

  static updatePendingData(data: PendingCave[]) {
    this.pendingDataCache = data;
    this.lastPendingUpdate = Date.now();
  }
}
