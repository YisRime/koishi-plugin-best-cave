import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement } from './index';
import { FileManager } from './FileManager';

// 定义了常见文件扩展名到 MIME 类型的映射，用于 Base64 转换。
const mimeTypeMap = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp'
};

/**
 * 将数据库中存储的 StoredElement[] 数组转换为 Koishi h() 元素数组。
 * @param elements - 从数据库读取的元素对象数组。
 * @returns 转换后的 h() 元素数组，用于消息发送。
 */
export function storedFormatToHElements(elements: StoredElement[]): h[] {
  // 遍历数据库元素，根据类型创建对应的 h() 元素。
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
        // 对于未知类型，返回 null，后续通过 filter 清除。
        return null;
    }
  }).filter(Boolean); // 过滤掉所有 null 或 undefined 的无效元素。
}

/**
 * 将指向本地媒体文件的 h() 元素转换为内联 Base64 格式。
 * @param element - 包含本地文件路径的 h() 媒体元素。
 * @param fileManager - FileManager 实例，用于读取文件。
 * @param logger - Logger 实例，用于记录错误。
 * @returns 转换后的 h() 元素，其 src 属性为 Base64 数据 URI。
 */
export async function mediaElementToBase64(element: h, fileManager: FileManager, logger: Logger): Promise<h> {
  const fileName = element.attrs.src as string;
  try {
    // 从文件管理器读取文件内容。
    const data = await fileManager.readFile(fileName);
    // 获取文件扩展名以确定 MIME 类型。
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = mimeTypeMap[ext] || 'application/octet-stream'; // 如果无匹配则使用通用二进制流类型。
    // 创建一个新的 h() 元素，将 src 更新为 Base64 格式。
    return h(element.type, { ...element.attrs, src: `data:${mimeType};base64,${data.toString('base64')}` });
  } catch (error) {
    logger.warn(`转换本地文件 ${fileName} 为 Base64 失败:`, error);
    // 转换失败时，返回一个纯文本提示，避免消息发送中断。
    return h('p', {}, `[${element.type}]`);
  }
}

/**
 * 构建一条包含回声洞内容的完整消息，准备发送。
 * 此函数会处理 S3 URL、文件映射路径或本地文件到 Base64 的转换。
 * @param cave - 要展示的回声洞对象。
 * @param config - 插件配置。
 * @param fileManager - FileManager 实例。
 * @param logger - Logger 实例。
 * @returns 一个包含 h() 元素和字符串的消息数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger): Promise<(string | h)[]> {
  const caveHElements = storedFormatToHElements(cave.elements);

  const processedElements = await Promise.all(caveHElements.map(element => {
    const isMedia = ['image', 'video', 'audio', 'file'].includes(element.type);
    const fileName = element.attrs.src as string;

    if (!isMedia || !fileName) {
      return Promise.resolve(element);
    }

    // 如果启用了 S3 并配置了公共 URL，则拼接完整的 URL。
    if (config.enableS3 && config.publicUrl) {
      const fullUrl = config.publicUrl.endsWith('/')
        ? `${config.publicUrl}${fileName}`
        : `${config.publicUrl}/${fileName}`;
      return Promise.resolve(h(element.type, { ...element.attrs, src: fullUrl }));
    }

    // 如果配置了映射路径，则构建 file:// URI。
    if (config.localPath) {
      const mappedPath = path.join(config.localPath, fileName);
      const fileUri = `file://${mappedPath}`;
      return Promise.resolve(h(element.type, { ...element.attrs, src: fileUri }));
    }

    // 否则，将本地媒体文件转换为 Base64。
    return mediaElementToBase64(element, fileManager, logger);
  }));

  // 根据 Config 拼接最终消息内容。
  const finalMessage: (string | h)[] = [];
  const formatString = config.caveFormat;
  const separatorIndex = formatString.indexOf('|');
  let headerFormat: string, footerFormat: string;
  if (separatorIndex === -1) {
    headerFormat = formatString;
    footerFormat = '';
  } else {
    headerFormat = formatString.substring(0, separatorIndex);
    footerFormat = formatString.substring(separatorIndex + 1);
  }
  const headerText = headerFormat.replace('{id}', cave.id.toString()).replace('{name}', cave.userName);
  if (headerText.trim()) finalMessage.push(headerText);
  finalMessage.push(...processedElements);
  const footerText = footerFormat.replace('{id}', cave.id.toString()).replace('{name}', cave.userName);
  if (footerText.trim()) finalMessage.push(footerText);

  return finalMessage;
}

/**
 * 清理数据库中所有被标记为 'delete' 状态的回声洞及其关联的文件。
 * @param ctx - Koishi 上下文。
 * @param fileManager - FileManager 实例，用于删除文件。
 * @param logger - Logger 实例。
 */
export async function cleanupPendingDeletions(ctx: Context, fileManager: FileManager, logger: Logger): Promise<void> {
  try {
    // 从数据库中获取所有待删除的回声洞。
    const cavesToDelete = await ctx.database.get('cave', { status: 'delete' });
    if (cavesToDelete.length === 0) return; // 如果没有，则直接返回。

    // 遍历每一个待删除的回声洞。
    for (const cave of cavesToDelete) {
      // 收集所有需要删除的文件操作。
      const deletePromises = cave.elements
        .filter(el => el.file) // 筛选出有文件的元素。
        .map(el => fileManager.deleteFile(el.file)); // 创建删除文件的 Promise。

      // 并发删除所有关联文件。
      await Promise.all(deletePromises);
      // 从数据库中移除该回声洞的记录。
      await ctx.database.remove('cave', { id: cave.id });
    }
  } catch (error) {
    logger.error('清理回声洞时发生错误:', error);
  }
}

/**
 * 根据插件配置（是否分群）和当前会话，生成数据库查询所需的范围条件。
 * @param session - 当前会话对象。
 * @param config - 插件配置。
 * @returns 一个用于数据库查询的条件对象。
 */
export function getScopeQuery(session: Session, config: Config): object {
  const baseQuery = { status: 'active' as const }; // 基础查询条件，只查询活动状态的洞。
  // 如果启用了分群模式且当前会话在群聊中，则添加 channelId 条件。
  if (config.perChannel && session.channelId) {
    return { ...baseQuery, channelId: session.channelId };
  }
  // 否则，返回全局查询条件。
  return baseQuery;
}

/**
 * 获取下一个可用的回声洞 ID。
 * 策略是找到当前已存在的 ID 中最小的未使用正整数。
 * @param ctx - Koishi 上下文。
 * @param query - 查询回声洞的范围条件，用于分群模式。
 * @returns 一个可用的新 ID。
 * @performance 对于非常大的数据集，此函数可能会有性能瓶颈，因为它需要获取所有现有 ID。
 */
export async function getNextCaveId(ctx: Context, query: object = {}): Promise<number> {
  // 获取指定范围内的所有回声洞，但只选择 'id' 字段以提高效率。
  const allCaves = await ctx.database.get('cave', query, { fields: ['id'] });
  // 将所有已存在的 ID 存入 Set，以实现 O(1) 的查找效率。
  const existingIds = new Set(allCaves.map(c => c.id));
  let newId = 1;
  // 从 1 开始递增，直到找到一个不在 Set 中的 ID。
  while (existingIds.has(newId)) {
    newId++;
  }
  return newId;
}

/**
 * 下载网络媒体资源并保存到文件存储中（本地或 S3）。
 * @param ctx - Koishi 上下文。
 * @param fileManager - FileManager 实例。
 * @param url - 媒体资源的 URL。
 * @param originalName - 原始文件名，用于获取扩展名。
 * @param type - 媒体类型 ('image', 'video', 'audio', 'file')。
 * @param caveId - 新建回声洞的 ID。
 * @param index - 媒体在消息中的索引。
 * @param channelId - 频道 ID。
 * @param userId - 用户 ID。
 * @returns 保存后的文件名/标识符。
 */
export async function downloadMedia(ctx: Context, fileManager: FileManager, url: string, originalName: string, type: string, caveId: number, index: number, channelId: string, userId: string): Promise<string> {
  // 默认扩展名映射。
  const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };
  // 优先使用原始文件名中的扩展名，否则根据类型使用默认扩展名。
  const ext = originalName ? path.extname(originalName) : '';
  const finalExt = ext || defaultExtMap[type] || '.dat';
  // 构建一个唯一的、包含元数据的文件名。
  const fileName = `${caveId}_${index}_${channelId}_${userId}${finalExt}`;

  // 使用 ctx.http 下载文件，设置响应类型为 arraybuffer 和超时。
  const response = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  // 将下载的数据 buffer 交给 fileManager 保存。
  return fileManager.saveFile(fileName, Buffer.from(response));
}

/**
 * 检查用户在当前频道是否处于指令冷却状态。
 * @param session - 当前会话对象。
 * @param config - 插件配置。
 * @param lastUsed - 存储各频道最后使用时间的 Map。
 * @returns 如果处于冷却中，返回提示信息字符串；否则返回 null。
 */
export function checkCooldown(session: Session, config: Config, lastUsed: Map<string, number>): string | null {
  // 如果冷却时间小于等于0，或不在群聊中，或用户是管理员，则不进行冷却检查。
  if (config.coolDown <= 0 || !session.channelId || config.adminUsers.includes(session.userId)) {
    return null;
  }
  const now = Date.now();
  const lastTime = lastUsed.get(session.channelId) || 0; // 获取上次使用时间，如果没有则为0。
  // 检查时间差是否小于配置的冷却时间。
  if (now - lastTime < config.coolDown * 1000) {
    const waitTime = Math.ceil((config.coolDown * 1000 - (now - lastTime)) / 1000);
    return `指令冷却中，请在 ${waitTime} 秒后重试`;
  }
  return null;
}

/**
 * 更新指定频道的指令使用时间戳。
 * @param session - 当前会话对象。
 * @param config - 插件配置。
 * @param lastUsed - 存储各频道最后使用时间的 Map。
 */
export function updateCooldownTimestamp(session: Session, config: Config, lastUsed: Map<string, number>) {
  // 只有在冷却时间大于0且在群聊中时才更新时间戳。
  if (config.coolDown > 0 && session.channelId) {
    lastUsed.set(session.channelId, Date.now());
  }
}
