import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement, ForwardNode } from './index';
import { FileManager } from './FileManager';
import { HashManager, CaveHashObject } from './HashManager';
import { PendManager } from './PendManager';

const mimeTypeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };

/**
 * @description 构建一条用于发送的完整回声洞消息，处理不同存储后端的资源链接。
 * @param cave 回声洞对象。
 * @param config 插件配置。
 * @param fileManager 文件管理器实例。
 * @param logger 日志记录器实例。
 * @param platform 目标平台名称 (e.g., 'onebot')。
 * @param prefix 可选的消息前缀 (e.g., '已删除', '待审核')。
 * @returns 包含多条消息的数组，每条消息是一个 (string | h)[] 数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger, platform?: string, prefix?: string): Promise<(string | h)[][]> {
  // 递归地将 StoredElement 数组转换为 h() 元素数组
  async function transformToH(elements: StoredElement[]): Promise<h[]> {
    return Promise.all(elements.map(async (el): Promise<h> => {
      if (el.type === 'text') return h.text(el.content as string);
      if (el.type === 'at') return h('at', { id: el.content as string });
      if (el.type === 'reply') return h('reply', { id: el.content as string });
      if (el.type === 'forward') {
        try {
          const forwardNodes: ForwardNode[] = Array.isArray(el.content) ? el.content : [];
          const messageNodes = await Promise.all(forwardNodes.map(async (node) => {
            const author = h('author', { id: node.userId, name: node.userName });
            const content = await transformToH(node.elements);
            return h('message', {}, [author, ...content]);
          }));
          return h('message', { forward: true }, messageNodes);
        } catch (error) {
          logger.warn(`解析回声洞（${cave.id}）合并转发内容失败:`, error);
          return h.text('[合并转发]');
        }
      }
      // 处理媒体元素
      if (['image', 'video', 'audio', 'file'].includes(el.type)) {
        const fileName = el.file;
        if (!fileName) return h('p', {}, `[${el.type}]`);
        if (config.enableS3 && config.publicUrl) return h(el.type, { ...el, src: new URL(fileName, config.publicUrl).href });
        if (config.localPath) return h(el.type, { ...el, src: `file://${path.join(config.localPath, fileName)}` });
        try {
          const data = await fileManager.readFile(fileName);
          const mimeType = mimeTypeMap[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
          return h(el.type, { ...el, src: `data:${mimeType};base64,${data.toString('base64')}` });
        } catch (error) {
          logger.warn(`转换文件 ${fileName} 为 Base64 失败:`, error);
          return h('p', {}, `[${el.type}]`);
        }
      }
      return null;
    })).then(hElements => hElements.filter(Boolean));
  }
  const caveHElements = await transformToH(cave.elements);
  const replacements = { id: cave.id.toString(), name: cave.userName };
  const [rawHeader, rawFooter] = config.caveFormat.split('|', 2);
  let header = rawHeader ? rawHeader.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]).trim() : '';
  if (prefix) header = `${prefix}${header}`;
  const footer = rawFooter ? rawFooter.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]).trim() : '';
  const problematicTypes = ['video', 'audio', 'file', 'forward'];
  const placeholderMap = { video: '[视频]', audio: '[音频]', file: '[文件]', forward: '[合并转发]' };
  const containsProblematic = platform === 'onebot' && caveHElements.some(el => problematicTypes.includes(el.type) || (el.type === 'message' && el.attrs.forward));
  if (!containsProblematic) {
    const finalMessage: (string | h)[] = [];
    if (header) finalMessage.push(header + '\n');
    finalMessage.push(...caveHElements);
    if (footer) finalMessage.push('\n' + footer);
    return [finalMessage.length > 0 ? finalMessage : []];
  }
  const initialMessageContent: (string | h)[] = [];
  const followUpMessages: (string | h)[][] = [];
  for (const el of caveHElements) {
    if (problematicTypes.includes(el.type) || (el.type === 'message' && el.attrs.forward)) {
      initialMessageContent.push(h.text(placeholderMap['forward']));
      followUpMessages.push([el]);
    } else {
      initialMessageContent.push(el);
    }
  }
  const finalInitialMessage: (string | h)[] = [];
  if (header) finalInitialMessage.push(header + '\n');
  finalInitialMessage.push(...initialMessageContent);
  if (footer) finalInitialMessage.push('\n' + footer);
  return [finalInitialMessage, ...followUpMessages].filter(msg => msg.length > 0);
}


/**
 * @description 清理数据库中标记为 'delete' 状态的回声洞及其关联文件和哈希。
 * @param ctx Koishi 上下文。
 * @param fileManager 文件管理器实例。
 * @param logger 日志记录器实例。
 * @param reusableIds 可复用 ID 的内存缓存。
 */
export async function cleanupPendingDeletions(ctx: Context, fileManager: FileManager, logger: Logger, reusableIds: Set<number>): Promise<void> {
  try {
    const cavesToDelete = await ctx.database.get('cave', { status: 'delete' });
    if (!cavesToDelete.length) return;
    const idsToDelete = cavesToDelete.map(c => c.id);
    for (const cave of cavesToDelete) await Promise.all(cave.elements.filter(el => el.file).map(el => fileManager.deleteFile(el.file)));
    reusableIds.delete(0);
    idsToDelete.forEach(id => reusableIds.add(id));
    await ctx.database.remove('cave', { id: { $in: idsToDelete } });
    await ctx.database.remove('cave_hash', { cave: { $in: idsToDelete } });
  } catch (error) {
    logger.error('清理回声洞时发生错误:', error);
  }
}

/**
 * @description 根据配置和会话，生成数据库查询的范围条件。
 * @param session 当前会话。
 * @param config 插件配置。
 * @param includeStatus 是否包含 status: 'active' 条件，默认为 true。
 * @returns 数据库查询条件对象。
 */
export function getScopeQuery(session: Session, config: Config, includeStatus = true): object {
  const baseQuery = includeStatus ? { status: 'active' as const } : {};
  return config.perChannel && session.channelId ? { ...baseQuery, channelId: session.channelId } : baseQuery;
}

/**
 * @description 获取下一个可用的回声洞 ID，采用“回收ID > 扫描空缺 > 最大ID+1”策略。
 * @param ctx Koishi 上下文。
 * @param reusableIds 可复用 ID 的内存缓存。
 * @returns 可用的新 ID。
 */
export async function getNextCaveId(ctx: Context, reusableIds: Set<number>): Promise<number> {
  for (const id of reusableIds) {
    if (id > 0) {
      reusableIds.delete(id);
      return id;
    }
  }
  if (reusableIds.has(0)) {
    reusableIds.delete(0);
    const [lastCave] = await ctx.database.get('cave', {}, { sort: { id: 'desc' }, limit: 1 });
    const newId = (lastCave?.id || 0) + 1;
    reusableIds.add(0);
    return newId;
  }
  const allCaveIds = (await ctx.database.get('cave', {}, { fields: ['id'] })).map(c => c.id);
  const existingIds = new Set(allCaveIds);
  let newId = 1;
  while (existingIds.has(newId)) newId++;
  if (existingIds.size === (allCaveIds.length > 0 ? Math.max(...allCaveIds) : 0)) reusableIds.add(0);
  return newId;
}

/**
 * @description 检查用户是否处于指令冷却中。
 * @returns 若在冷却中则提示字符串，否则 null。
 */
export function checkCooldown(session: Session, config: Config, lastUsed: Map<string, number>): string | null {
  const adminChannelId = config.adminChannel?.split(':')[1];
  if (adminChannelId && session.channelId === adminChannelId) return null;
  if (config.coolDown <= 0 || !session.channelId) return null;
  const lastTime = lastUsed.get(session.channelId) || 0;
  const remainingTime = (lastTime + config.coolDown * 1000) - Date.now();
  if (remainingTime > 0) return `指令冷却中，请在 ${Math.ceil(remainingTime / 1000)} 秒后重试`;
  return null;
}

/**
 * @description 更新指定频道的指令使用时间戳。
 */
export function updateCooldownTimestamp(session: Session, config: Config, lastUsed: Map<string, number>) {
  if (config.coolDown > 0 && session.channelId) lastUsed.set(session.channelId, Date.now());
}

/**
 * @description 解析消息元素，分离出文本和待下载的媒体文件。
 * @param sourceElements 原始的 Koishi 消息元素数组。
 * @param newId 这条回声洞的新 ID。
 * @param session 触发操作的会话。
 * @param config 插件配置。
 * @param logger 日志实例。
 * @returns 包含数据库元素和待保存媒体列表的对象。
 */
export async function processMessageElements(sourceElements: h[], newId: number, session: Session, config: Config, logger: Logger): Promise<{ finalElementsForDb: StoredElement[], mediaToSave: { sourceUrl: string, fileName: string }[] }> {
  const mediaToSave: { sourceUrl: string, fileName: string }[] = [];
  let mediaIndex = 0;
  async function transform(elements: h[]): Promise<StoredElement[]> {
    const result: StoredElement[] = [];
    const typeMap = { 'img': 'image', 'image': 'image', 'video': 'video', 'audio': 'audio', 'file': 'file', 'text': 'text', 'at': 'at', 'forward': 'forward', 'reply': 'reply' };
    const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };
    for (const el of elements) {
      const type = typeMap[el.type];
      if (!type) {
        if (el.children) result.push(...await transform(el.children));
        continue;
      }
      if (type === 'text' && el.attrs.content?.trim()) {
        result.push({ type: 'text', content: el.attrs.content.trim() });
      } else if (type === 'at' && el.attrs.id) {
        result.push({ type: 'at', content: el.attrs.id as string });
      } else if (type === 'reply' && el.attrs.id) {
        result.push({ type: 'reply', content: el.attrs.id as string });
      } else if (type === 'forward' && Array.isArray(el.attrs.content)) {
        const forwardNodes: ForwardNode[] = [];
        for (const node of el.attrs.content) {
          if (!node.message || !Array.isArray(node.message)) continue;
          const userId = node.sender?.user_id;
          const userName = node.sender?.nickname;
          const elementsToProcess = node.message.map(segment => {
            const { type, data } = segment;
            const attrs = { ...data };
            if (type === 'text' && typeof data.text !== 'undefined') { attrs.content = data.text; delete attrs.text; }
            if (type === 'at' && typeof data.qq !== 'undefined') { attrs.id = data.qq; delete attrs.qq; }
            if (['image', 'video', 'audio'].includes(type) && typeof data.url !== 'undefined') { attrs.src = data.url; delete attrs.url; }
            return h(type, attrs);
          });
          const contentElements = await transform(elementsToProcess);
          if (contentElements.length > 0) forwardNodes.push({ userId, userName, elements: contentElements });
        }
        if (forwardNodes.length > 0) result.push({ type: 'forward', content: forwardNodes });
      } else if (['image', 'video', 'audio', 'file'].includes(type) && el.attrs.src) {
        let fileIdentifier = el.attrs.src as string;
        if (fileIdentifier.startsWith('http')) {
          const ext = path.extname(el.attrs.file as string || '') || defaultExtMap[type];
          const currentMediaIndex = ++mediaIndex;
          const fileName = `${newId}_${currentMediaIndex}_${session.channelId || session.guildId}_${session.userId}${ext}`;
          mediaToSave.push({ sourceUrl: fileIdentifier, fileName });
          fileIdentifier = fileName;
        }
        result.push({ type: type as any, file: fileIdentifier });
      }
    }
    return result;
  }
  const finalElementsForDb = await transform(sourceElements);
  return { finalElementsForDb, mediaToSave };
}

/**
 * @description 异步处理文件上传、查重和状态更新的后台任务。
 * @param ctx - Koishi 上下文。
 * @param config - 插件配置。
 * @param fileManager - FileManager 实例，用于保存文件。
 * @param logger - 日志记录器实例。
 * @param reviewManager - ReviewManager 实例，用于提交审核。
 * @param cave - 刚刚在数据库中创建的 `preload` 状态的回声洞对象。
 * @param mediaToSave - 需要下载和处理的媒体文件列表。
 * @param reusableIds - 可复用 ID 的内存缓存。
 * @param session - 触发此操作的用户会话，用于发送反馈。
 * @param hashManager - HashManager 实例，如果启用则用于哈希计算和比较。
 * @param textHashesToStore - 已预先计算好的、待存入数据库的文本哈希对象数组。
 */
export async function handleFileUploads(
  ctx: Context, config: Config, fileManager: FileManager, logger: Logger,
  reviewManager: PendManager, cave: CaveObject, mediaToToSave: { sourceUrl: string, fileName: string }[],
  reusableIds: Set<number>, session: Session, hashManager: HashManager, textHashesToStore: Omit<CaveHashObject, 'cave'>[]
) {
  try {
    const downloadedMedia: { fileName: string, buffer: Buffer }[] = [];
    const imageHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];
    const allExistingImageHashes = hashManager ? await ctx.database.get('cave_hash', { type: { $ne: 'simhash' } }) : [];
    const existingGlobalHashes = allExistingImageHashes.filter(h => h.type === 'phash_g');
    for (const media of mediaToToSave) {
      const buffer = Buffer.from(await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 }));
      downloadedMedia.push({ fileName: media.fileName, buffer });
      if (hashManager && ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(media.fileName).toLowerCase())) {
        const { globalHash, quadrantHashes } = await hashManager.generateAllImageHashes(buffer);
        for (const existing of existingGlobalHashes) {
          const similarity = hashManager.calculateSimilarity(globalHash, existing.hash);
          if (similarity >= config.imageThreshold) {
            await session.send(`图片与回声洞（${existing.cave}）的相似度（${similarity.toFixed(2)}%）超过阈值`);
            await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
            cleanupPendingDeletions(ctx, fileManager, logger, reusableIds);
            return;
          }
        }
        imageHashesToStore.push({ hash: globalHash, type: 'phash_g' });
        imageHashesToStore.push({ hash: quadrantHashes.q1, type: 'phash_q1' });
        imageHashesToStore.push({ hash: quadrantHashes.q2, type: 'phash_q2' });
        imageHashesToStore.push({ hash: quadrantHashes.q3, type: 'phash_q3' });
        imageHashesToStore.push({ hash: quadrantHashes.q4, type: 'phash_q4' });
      }
    }
    await Promise.all(downloadedMedia.map(item => fileManager.saveFile(item.fileName, item.buffer)));
    const finalStatus = config.enablePend ? 'pending' : 'active';
    await ctx.database.upsert('cave', [{ id: cave.id, status: finalStatus }]);
    if (hashManager) {
      const allHashesToInsert = [...textHashesToStore, ...imageHashesToStore].map(h => ({ ...h, cave: cave.id }));
      if (allHashesToInsert.length > 0) await ctx.database.upsert('cave_hash', allHashesToInsert);
    }
    if (finalStatus === 'pending' && reviewManager) {
      const [finalCave] = await ctx.database.get('cave', { id: cave.id });
      if (finalCave) reviewManager.sendForPend(finalCave);
    }
  } catch (fileProcessingError) {
    logger.error(`回声洞（${cave.id}）文件处理失败:`, fileProcessingError);
    await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
    cleanupPendingDeletions(ctx, fileManager, logger, reusableIds);
  }
}
