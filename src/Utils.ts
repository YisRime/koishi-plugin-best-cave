import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement } from './index';
import { FileManager } from './FileManager';
import { HashManager, CaveHashObject } from './HashManager';
import { ReviewManager } from './ReviewManager';

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
  }).filter(Boolean);
}

/**
 * @description 构建一条用于发送的完整回声洞消息，处理不同存储后端的资源链接。
 * @param cave 回声洞对象。
 * @param config 插件配置。
 * @param fileManager 文件管理器实例。
 * @param logger 日志记录器实例。
 * @returns 包含 h() 元素和字符串的消息数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger): Promise<(string | h)[]> {
  const caveHElements = storedFormatToHElements(cave.elements);

  const processedElements = await Promise.all(caveHElements.map(async (element) => {
    const isMedia = ['image', 'video', 'audio', 'file'].includes(element.type);
    const fileName = element.attrs.src as string;
    if (!isMedia || !fileName) return element;

    if (config.enableS3 && config.publicUrl) {
      return h(element.type, { ...element.attrs, src: new URL(fileName, config.publicUrl).href });
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
  const [header, footer] = config.caveFormat.split('|', 2).map(part => part.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]).trim());

  const finalMessage: (string | h)[] = [];
  if (header) finalMessage.push(header + '\n');
  finalMessage.push(...processedElements);
  if (footer) finalMessage.push('\n' + footer);
  return finalMessage;
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
    for (const cave of cavesToDelete) {
      await Promise.all(cave.elements.filter(el => el.file).map(el => fileManager.deleteFile(el.file)));
    }

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
 * @param query 查询范围条件。
 * @param reusableIds 可复用 ID 的内存缓存。
 * @returns 可用的新 ID。
 */
export async function getNextCaveId(ctx: Context, query: object = {}, reusableIds: Set<number>): Promise<number> {
  for (const id of reusableIds) {
    if (id > 0) {
      reusableIds.delete(id);
      return id;
    }
  }

  if (reusableIds.has(0)) {
    reusableIds.delete(0);
    const [lastCave] = await ctx.database.get('cave', query, { sort: { id: 'desc' }, limit: 1 });
    const newId = (lastCave?.id || 0) + 1;
    reusableIds.add(0);
    return newId;
  }

  const allCaveIds = (await ctx.database.get('cave', query, { fields: ['id'] })).map(c => c.id);
  const existingIds = new Set(allCaveIds);
  let newId = 1;
  while (existingIds.has(newId)) newId++;

  if (existingIds.size === (allCaveIds.length > 0 ? Math.max(...allCaveIds) : 0)) {
    reusableIds.add(0);
  }
  return newId;
}

/**
 * @description 检查用户是否处于指令冷却中。
 * @returns 若在冷却中则提示字符串，否则 null。
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
 * @param sourceElements 原始的 Koishi 消息元素数组。
 * @param newId 这条回声洞的新 ID。
 * @param session 触发操作的会话。
 * @returns 包含数据库元素和待保存媒体列表的对象。
 */
export async function processMessageElements(sourceElements: h[], newId: number, session: Session): Promise<{
  finalElementsForDb: StoredElement[],
  mediaToSave: { sourceUrl: string, fileName: string }[]
}> {
  const finalElementsForDb: StoredElement[] = [];
  const mediaToSave: { sourceUrl: string, fileName: string }[] = [];
  let mediaIndex = 0;

  const typeMap = { 'img': 'image', 'image': 'image', 'video': 'video', 'audio': 'audio', 'file': 'file', 'text': 'text' };
  const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };

  async function traverse(elements: h[]) {
    for (const el of elements) {
      const type = typeMap[el.type];
      if (!type) {
        if (el.children) await traverse(el.children);
        continue;
      }

      if (type === 'text' && el.attrs.content?.trim()) {
        finalElementsForDb.push({ type: 'text', content: el.attrs.content.trim() });
      } else if (type !== 'text' && el.attrs.src) {
        let fileIdentifier = el.attrs.src as string;
        if (fileIdentifier.startsWith('http')) {
          const ext = path.extname(el.attrs.file as string || '') || defaultExtMap[type];
          const fileName = `${newId}_${++mediaIndex}_${session.channelId || 'private'}_${session.userId}${ext}`;
          mediaToSave.push({ sourceUrl: fileIdentifier, fileName });
          fileIdentifier = fileName;
        }
        finalElementsForDb.push({ type: type as StoredElement['type'], file: fileIdentifier });
      }
      if (el.children) await traverse(el.children);
    }
  }

  await traverse(sourceElements);
  return { finalElementsForDb, mediaToSave };
}

export async function handleFileUploads(
  ctx: Context, config: Config, fileManager: FileManager, logger: Logger,
  reviewManager: ReviewManager, cave: CaveObject, mediaToToSave: { sourceUrl: string, fileName: string }[],
  reusableIds: Set<number>, session: Session, hashManager: HashManager, textHashesToStore: Omit<CaveHashObject, 'cave'>[]
) {
  try {
    const downloadedMedia: { fileName: string, buffer: Buffer }[] = [];
    const imageHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];

    const allExistingImageHashes = hashManager ? await ctx.database.get('cave_hash', { type: { $ne: 'simhash' } }) : [];
    const existingGlobalHashes = allExistingImageHashes.filter(h => h.type === 'phash_g');
    const existingQuadrantHashes = allExistingImageHashes.filter(h => h.type.startsWith('phash_q'));

    for (const media of mediaToToSave) {
      const buffer = Buffer.from(await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 }));
      downloadedMedia.push({ fileName: media.fileName, buffer });

      if (hashManager && ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(media.fileName).toLowerCase())) {
        const { globalHash, quadrantHashes } = await hashManager.generateAllImageHashes(buffer);

        for (const existing of existingGlobalHashes) {
          const similarity = hashManager.calculateSimilarity(globalHash, existing.hash);
          if (similarity >= config.imageWholeThreshold) {
            await session.send(`图片与回声洞（${existing.cave}）的相似度为 ${similarity.toFixed(2)}%，超过阈值`);
            await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
            cleanupPendingDeletions(ctx, fileManager, logger, reusableIds);
            return;
          }
        }

        const notifiedPartialCaves = new Set<number>();
        for (const newSubHash of Object.values(quadrantHashes)) {
          for (const existing of existingQuadrantHashes) {
            if (notifiedPartialCaves.has(existing.cave)) continue;
            // CHANGE: Compare hashes for equality instead of similarity
            if (newSubHash === existing.hash) {
              await session.send(`图片局部与回声洞（${existing.cave}）存在完全相同的区块`);
              notifiedPartialCaves.add(existing.cave);
            }
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

    const finalStatus = config.enableReview ? 'pending' : 'active';
    await ctx.database.upsert('cave', [{ id: cave.id, status: finalStatus }]);

    if (hashManager) {
      const allHashesToInsert = [...textHashesToStore, ...imageHashesToStore].map(h => ({ ...h, cave: cave.id }));
      if (allHashesToInsert.length > 0) {
        await ctx.database.upsert('cave_hash', allHashesToInsert);
      }
    }

    if (finalStatus === 'pending' && reviewManager) {
      const [finalCave] = await ctx.database.get('cave', { id: cave.id });
      if (finalCave) reviewManager.sendForReview(finalCave);
    }
  } catch (fileProcessingError) {
    logger.error(`回声洞（${cave.id}）文件处理失败:`, fileProcessingError);
    await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
    cleanupPendingDeletions(ctx, fileManager, logger, reusableIds);
  }
}
