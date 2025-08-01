import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement } from './index';
import { FileManager } from './FileManager';

const mimeTypeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };

/**
 * @description 将数据库存储的 StoredElement[] 转换为 Koishi 的 h() 元素数组。
 * @param elements 从数据库读取的元素数组。
 * @returns 转换后的 h() 元素数组。
 */
export function storedFormatToHElements(elements: StoredElement[]): h[] {
  return elements.map(el => {
    if (el.type === 'text') return h.text(el.content);
    if (['image', 'video', 'audio', 'file'].includes(el.type)) return h(el.type, { src: el.file });
    return null;
  }).filter(Boolean); // 过滤掉无效元素
}

/**
 * @description 构建一条用于发送的完整回声洞消息。
 * 此函数会处理 S3 URL、文件映射路径或本地文件到 Base64 的转换。
 * @param cave 要展示的回声洞对象。
 * @param config 插件配置。
 * @param fileManager FileManager 实例。
 * @param logger Logger 实例。
 * @returns 包含 h() 元素和字符串的消息数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger): Promise<(string | h)[]> {
  const caveHElements = storedFormatToHElements(cave.elements);

  const processedElements = await Promise.all(caveHElements.map(async (element) => {
    const isMedia = ['image', 'video', 'audio', 'file'].includes(element.type);
    const fileName = element.attrs.src as string;

    if (!isMedia || !fileName) return element;

    if (config.enableS3 && config.publicUrl) {
      const fullUrl = new URL(fileName, config.publicUrl).href;
      return h(element.type, { ...element.attrs, src: fullUrl });
    }
    if (config.localPath) {
      return h(element.type, { ...element.attrs, src: `file://${path.join(config.localPath, fileName)}` });
    }
    try {
      const data = await fileManager.readFile(fileName);
      const mimeType = mimeTypeMap[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
      return h(element.type, { ...element.attrs, src: `data:${mimeType};base64,${data.toString('base64')}` });
    } catch (error) {
      logger.warn(`转换文件 ${fileName} 为 Base64 失败:`, error);
      return h('p', {}, `[${element.type}]`);
    }
  }));

  const replacements = { id: cave.id.toString(), name: cave.userName };
  const formatPart = (part: string) => part.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]).trim();
  const [header, footer] = config.caveFormat.split('|', 2).map(formatPart);

  const finalMessage: (string | h)[] = [];
  if (header) finalMessage.push(header + '\n');
  finalMessage.push(...processedElements);
  if (footer) finalMessage.push('\n' + footer);

  return finalMessage;
}

/**
 * @description 清理数据库中所有被标记为 'delete' 状态的回声洞及其关联文件。
 * @param ctx Koishi 上下文。
 * @param fileManager FileManager 实例。
 * @param logger Logger 实例。
 */
export async function cleanupPendingDeletions(ctx: Context, fileManager: FileManager, logger: Logger): Promise<void> {
  try {
    const cavesToDelete = await ctx.database.get('cave', { status: 'delete' });
    if (!cavesToDelete.length) return;

    for (const cave of cavesToDelete) {
      const deletePromises = cave.elements
        .filter(el => el.file)
        .map(el => fileManager.deleteFile(el.file));
      await Promise.all(deletePromises);
      await ctx.database.remove('cave', { id: cave.id });
    }
  } catch (error) {
    logger.error('清理回声洞时发生错误:', error);
  }
}

/**
 * @description 根据配置（是否分群）和当前会话，生成数据库查询的范围条件。
 * @param session 当前会话对象。
 * @param config 插件配置。
 * @returns 用于数据库查询的条件对象。
 */
export function getScopeQuery(session: Session, config: Config): object {
  const baseQuery = { status: 'active' as const };
  return config.perChannel && session.channelId ? { ...baseQuery, channelId: session.channelId } : baseQuery;
}

/**
 * @description 获取下一个可用的回声洞 ID（最小的未使用正整数）。
 * @param ctx Koishi 上下文。
 * @param query 查询范围条件，用于分群模式。
 * @returns 可用的新 ID。
 * @performance 在大数据集下，此函数可能存在性能瓶颈，因为它需要获取所有现有ID。
 */
export async function getNextCaveId(ctx: Context, query: object = {}): Promise<number> {
  const allCaveIds = (await ctx.database.get('cave', query, { fields: ['id'] })).map(c => c.id);
  const existingIds = new Set(allCaveIds);
  let newId = 1;
  while (existingIds.has(newId)) {
    newId++;
  }
  return newId;
}

/**
 * @description 检查用户是否处于指令冷却中。
 * @returns 若在冷却中则返回提示字符串，否则返回 null。
 */
export function checkCooldown(session: Session, config: Config, lastUsed: Map<string, number>): string | null {
  if (config.coolDown <= 0 || !session.channelId) return null;
  const lastTime = lastUsed.get(session.channelId) || 0;
  const remainingTime = (lastTime + config.coolDown * 1000) - Date.now();
  if (remainingTime > 0) {
    return `指令冷却中，请在 ${Math.ceil(remainingTime / 1000)} 秒后重试`;
  }
  return null;
}

/**
 * @description 更新指定频道的指令使用时间戳。
 */
export function updateCooldownTimestamp(session: Session, config: Config, lastUsed: Map<string, number>) {
  if (config.coolDown > 0 && session.channelId) {
    lastUsed.set(session.channelId, Date.now());
  }
}

/**
 * @description 解析消息元素，分离出文本和待下载的媒体文件。
 * @param sourceElements - 原始的 Koishi 消息元素数组。
 * @param newId - 这条回声洞的新 ID。
 * @param channelId - 频道 ID。
 * @param userId - 用户 ID。
 * @returns 一个包含数据库元素和待保存媒体列表的对象。
 */
export async function processMessageElements(sourceElements: h[], newId: number, channelId: string, userId: string): Promise<{
  finalElementsForDb: StoredElement[],
  mediaToSave: { sourceUrl: string, fileName: string }[]
}> {
  const finalElementsForDb: StoredElement[] = [];
  const mediaToSave: { sourceUrl: string, fileName: string }[] = [];
  let mediaIndex = 0;

  const typeMap: Record<string, StoredElement['type']> = {
    'img': 'image', 'image': 'image', 'video': 'video', 'audio': 'audio', 'file': 'file', 'text': 'text'
  };
  const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };

  async function traverse(elements: h[]) {
    for (const el of elements) {
      const normalizedType = typeMap[el.type];
      if (normalizedType) {
        if (['image', 'video', 'audio', 'file'].includes(normalizedType) && el.attrs.src) {
          let fileIdentifier = el.attrs.src as string;
          if (fileIdentifier.startsWith('http')) {
            const ext = path.extname(el.attrs.file as string || '') || defaultExtMap[normalizedType];
            const fileName = `${newId}_${++mediaIndex}_${channelId || 'private'}_${userId}${ext}`;
            mediaToSave.push({ sourceUrl: fileIdentifier, fileName });
            fileIdentifier = fileName;
          }
          finalElementsForDb.push({ type: normalizedType, file: fileIdentifier });
        } else if (normalizedType === 'text' && el.attrs.content?.trim()) {
          finalElementsForDb.push({ type: 'text', content: el.attrs.content.trim() });
        }
      }
      if (el.children) await traverse(el.children);
    }
  }

  await traverse(sourceElements);
  return { finalElementsForDb, mediaToSave };
}

/**
 * @description 异步处理文件上传和状态更新的后台任务。
 * @param ctx - Koishi 上下文。
 * @param config - 插件配置。
 * @param fileManager - 文件管理器实例。
 * @param logger - 日志记录器实例。
 * @param reviewManager - 审核管理器实例 (可能为 null)。
 * @param cave - 已创建的、状态为 'preload' 的回声洞对象。
 * @param mediaToSave - 需要下载和保存的媒体文件列表。
 */
export async function handleFileUploads(ctx: Context, config: Config, fileManager: FileManager, logger: Logger, reviewManager: any, cave: CaveObject, mediaToSave: { sourceUrl: string, fileName: string }[]) {
  try {
    const uploadPromises = mediaToSave.map(async (media) => {
      const response = await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
      await fileManager.saveFile(media.fileName, Buffer.from(response));
    });
    await Promise.all(uploadPromises);

    const finalStatus = config.enableReview ? 'pending' : 'active';
    await ctx.database.upsert('cave', [{ id: cave.id, status: finalStatus }]);

    if (finalStatus === 'pending' && reviewManager) {
      const [finalCave] = await ctx.database.get('cave', { id: cave.id });
      if (finalCave) reviewManager.sendForReview(finalCave);
    }
  } catch (fileSaveError) {
    logger.error(`回声洞（${cave.id}）文件保存失败:`, fileSaveError);
    await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
    // 异步清理，不阻塞主流程
    cleanupPendingDeletions(ctx, fileManager, logger);
  }
}
