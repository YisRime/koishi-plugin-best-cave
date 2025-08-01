import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement } from './index';
import { FileManager } from './FileManager';

// 定义了常见文件扩展名到 MIME 类型的映射，用于 Base64 转换。
const mimeTypeMap: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp'
};

/**
 * 将数据库存储格式的元素数组转换为 Koishi 消息元素 (h-element) 数组。
 * @param elements - StoredElement 对象数组。
 * @returns 可用于发送的 h-element 数组。
 */
export function storedFormatToHElements(elements: StoredElement[]): h[] {
  return elements.map(el => {
    switch (el.type) {
      case 'text':
        return h.text(el.content);
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        return h(el.type, { src: el.file });
      default:
        return null;
    }
  }).filter(Boolean);
}

/**
 * 将指向本地媒体文件的 h-element 转换为内联 Base64 数据。
 * @param element - 包含本地文件路径的媒体 h-element。
 * @param fileManager - FileManager 实例，用于读取文件。
 * @param logger - Logger 实例，用于记录日志。
 * @returns 转换后的 h-element，其 src 为 Base64 数据 URI，或在失败时返回一个文本提示。
 */
export async function mediaElementToBase64(element: h, fileManager: FileManager, logger: Logger): Promise<h> {
  const fileName = element.attrs.src as string;
  try {
    const data = await fileManager.readFile(fileName);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = mimeTypeMap[ext] || 'application/octet-stream';
    return h(element.type, { ...element.attrs, src: `data:${mimeType};base64,${data.toString('base64')}` });
  } catch (error) {
    logger.warn(`转换本地文件 ${fileName} 为 Base64 失败:`, error);
    return h.text(`[${element.type}]`);
  }
}

/**
 * 根据配置构建一条包含回声洞内容的完整可发送消息。
 * @param cave - 要展示的回声洞对象。
 * @param config - 插件配置对象。
 * @param fileManager - FileManager 实例。
 * @param logger - Logger 实例。
 * @returns 一个包含字符串和 h-element 的消息数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger): Promise<(string | h)[]> {
  const caveHElements = storedFormatToHElements(cave.elements);

  const processedElements = await Promise.all(caveHElements.map(element => {
    const isMedia = ['image', 'video', 'audio', 'file'].includes(element.type);
    const fileName = element.attrs.src as string;

    if (!isMedia || !fileName) {
      return element;
    }

    if (config.enableS3 && config.publicUrl) {
      const fullUrl = new URL(fileName, config.publicUrl.endsWith('/') ? config.publicUrl : `${config.publicUrl}/`).href;
      return h(element.type, { ...element.attrs, src: fullUrl });
    }

    if (config.localPath) {
      const fileUri = `file://${path.join(config.localPath, fileName)}`;
      return h(element.type, { ...element.attrs, src: fileUri });
    }

    return mediaElementToBase64(element, fileManager, logger);
  }));

  const finalMessage: (string | h)[] = [];
  const [headerFormat, footerFormat] = config.caveFormat.split('|');

  const replacer = (str: string) => str.replace('{id}', cave.id.toString()).replace('{name}', cave.userName);

  if (headerFormat?.trim()) finalMessage.push(replacer(headerFormat));
  finalMessage.push(...processedElements);
  if (footerFormat?.trim()) finalMessage.push(replacer(footerFormat));

  return finalMessage;
}

/**
 * 遍历并转换消息元素为可存储格式，同时识别待下载的媒体文件。
 * @param sourceElements - 源消息中的 h-element 数组。
 * @param newId - 新回声洞的 ID。
 * @param channelId - 频道 ID。
 * @param userId - 用户 ID。
 * @returns 一个包含待存储元素和待下载媒体列表的对象。
 */
export function prepareElementsForStorage(sourceElements: h[], newId: number, channelId: string, userId: string): { finalElementsForDb: StoredElement[], mediaToDownload: { url: string, fileName: string }[] } {
    const finalElementsForDb: StoredElement[] = [];
    const mediaToDownload: { url: string; fileName: string }[] = [];
    let mediaIndex = 0;

    const processElement = (el: h) => {
        const elementType = el.type as StoredElement['type'];

        if (['image', 'video', 'audio', 'file'].includes(elementType) && el.attrs.src) {
            const fileIdentifier = el.attrs.src as string;
            if (fileIdentifier.startsWith('http')) {
                mediaIndex++;
                const originalName = el.attrs.file as string;
                const defaultExtMap: Record<string, string> = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };
                const ext = originalName ? path.extname(originalName) : '';
                const finalExt = ext || defaultExtMap[elementType] || '.dat';
                const generatedFileName = `${newId}_${mediaIndex}_${channelId}_${userId}${finalExt}`;

                finalElementsForDb.push({ type: elementType, file: generatedFileName });
                mediaToDownload.push({ url: fileIdentifier, fileName: generatedFileName });
            } else {
                finalElementsForDb.push({ type: elementType, file: fileIdentifier });
            }
        } else if (elementType === 'text' && el.attrs.content?.trim()) {
            finalElementsForDb.push({ type: 'text', content: el.attrs.content.trim() });
        }

        if (el.children) {
            el.children.forEach(processElement);
        }
    };

    sourceElements.forEach(processElement);

    return { finalElementsForDb, mediaToDownload };
}

/**
 * 清理数据库中所有标记为 'delete' 状态的回声洞及其关联的文件。
 * @param ctx - Koishi 上下文。
 * @param fileManager - FileManager 实例，用于删除文件。
 * @param logger - Logger 实例。
 */
export async function cleanupPendingDeletions(ctx: Context, fileManager: FileManager, logger: Logger): Promise<void> {
  try {
    const cavesToDelete = await ctx.database.get('cave', { status: 'delete' });
    if (cavesToDelete.length === 0) return;

    const filesToDelete = cavesToDelete.flatMap(cave =>
        cave.elements.filter(el => el.file).map(el => el.file)
    );

    await Promise.all(filesToDelete.map(file => fileManager.deleteFile(file)));

    const idsToRemove = cavesToDelete.map(cave => cave.id);
    await ctx.database.remove('cave', { id: { $in: idsToRemove } });

  } catch (error) {
    logger.error('清理回声洞时发生错误:', error);
  }
}

/**
 * 根据插件配置和会话上下文，生成数据库查询的作用域条件。
 * @param session - 当前 Koishi 会话对象。
 * @param config - 插件配置对象。
 * @returns 一个用于数据库查询的条件对象，其类型已精确定义。
 */
export function getScopeQuery(session: Session, config: Config): { status: 'active'; channelId?: string } {
  const baseQuery: { status: 'active' } = { status: 'active' };
  if (config.perChannel && session.channelId) {
    return { ...baseQuery, channelId: session.channelId };
  }
  return baseQuery;
}

/**
 * 检查用户在当前频道是否处于指令冷却中。
 * @param session - 当前 Koishi 会话对象。
 * @param config - 插件配置对象。
 * @param lastUsed - 存储各频道最后使用时间的 Map。
 * @returns 若处于冷却中，返回提示信息字符串；否则返回 null。
 */
export function checkCooldown(session: Session, config: Config, lastUsed: Map<string, number>): string | null {
  if (config.coolDown <= 0 || !session.channelId || config.adminUsers.includes(session.userId)) {
    return null;
  }
  const now = Date.now();
  const lastTime = lastUsed.get(session.channelId) || 0;
  if (now - lastTime < config.coolDown * 1000) {
    const waitTime = Math.ceil((config.coolDown * 1000 - (now - lastTime)) / 1000);
    return `指令冷却中，请在 ${waitTime} 秒后重试`;
  }
  return null;
}

/**
 * 更新指定频道的指令使用时间戳。
 * @param session - 当前 Koishi 会话对象。
 * @param config - 插件配置对象。
 * @param lastUsed - 存储各频道最后使用时间的 Map。
 */
export function updateCooldownTimestamp(session: Session, config: Config, lastUsed: Map<string, number>): void {
  if (config.coolDown > 0 && session.channelId) {
    lastUsed.set(session.channelId, Date.now());
  }
}
