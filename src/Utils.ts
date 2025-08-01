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

    // 优先使用 S3 公共 URL
    if (config.enableS3 && config.publicUrl) {
      const fullUrl = config.publicUrl.endsWith('/') ? `${config.publicUrl}${fileName}` : `${config.publicUrl}/${fileName}`;
      return h(element.type, { ...element.attrs, src: fullUrl });
    }
    // 其次使用本地文件映射路径
    if (config.localPath) {
      const fileUri = `file://${path.join(config.localPath, fileName)}`;
      return h(element.type, { ...element.attrs, src: fileUri });
    }
    // 最后，将本地文件转换为 Base64
    try {
      const data = await fileManager.readFile(fileName);
      const ext = path.extname(fileName).toLowerCase();
      const mimeType = mimeTypeMap[ext] || 'application/octet-stream';
      return h(element.type, { ...element.attrs, src: `data:${mimeType};base64,${data.toString('base64')}` });
    } catch (error) {
      logger.warn(`转换文件 ${fileName} 为 Base64 失败:`, error);
      return h('p', {}, `[${element.type}]`); // 转换失败时返回文本提示
    }
  }));

  // 根据配置格式化最终消息
  const finalMessage: (string | h)[] = [];
  const [headerFormat, footerFormat = ''] = config.caveFormat.split('|');
  const replacements = { id: cave.id.toString(), name: cave.userName };

  const headerText = headerFormat.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]);
  if (headerText.trim()) finalMessage.push(headerText);

  finalMessage.push(...processedElements);

  const footerText = footerFormat.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]);
  if (footerText.trim()) finalMessage.push(footerText);

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
      // 并发删除所有关联文件
      const deletePromises = cave.elements
        .filter(el => el.file)
        .map(el => fileManager.deleteFile(el.file));
      await Promise.all(deletePromises);
      // 从数据库中移除记录
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
  // 启用分群且在群聊中时，添加 channelId 条件
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
 * @description 下载网络媒体资源并保存到文件存储中。
 * @returns 保存后的文件名/标识符。
 */
export async function downloadMedia(ctx: Context, fileManager: FileManager, url: string, originalName: string, type: string, caveId: number, index: number, channelId: string, userId: string): Promise<string> {
  const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };
  const ext = originalName ? path.extname(originalName) : (defaultExtMap[type] || '.dat');
  // 构建唯一的、包含元数据的文件名
  const fileName = `${caveId}_${index}_${channelId}_${userId}${ext}`;
  const response = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return fileManager.saveFile(fileName, Buffer.from(response));
}

/**
 * @description 检查用户是否处于指令冷却中。
 * @returns 若在冷却中则返回提示字符串，否则返回 null。
 */
export function checkCooldown(session: Session, config: Config, lastUsed: Map<string, number>): string | null {
  if (config.coolDown <= 0 || !session.channelId) return null;
  const now = Date.now();
  const lastTime = lastUsed.get(session.channelId) || 0;
  if (now - lastTime < config.coolDown * 1000) {
    const waitTime = Math.ceil((config.coolDown * 1000 - (now - lastTime)) / 1000);
    return `指令冷却中，请在 ${waitTime} 秒后重试`;
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
