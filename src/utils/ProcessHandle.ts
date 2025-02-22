import * as fs from 'fs'
import * as path from 'path'
import { Config } from '../index'
import { FileHandler } from './FileHandler'
import { IdManager } from './IdManager'
import { HashManager } from './HashManager'
import { Element, buildMessage, sendMessage } from './MediaHandler'

interface CaveObject {
  cave_id: number
  elements: Element[]
  contributor_number: string
  contributor_name: string
}

interface PendingCave extends CaveObject {}

// 处理列表查询
export async function processList(
  session: any,
  config: Config,
  idManager: IdManager,
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

export async function processView(
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

export async function processRandom(
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

export async function processDelete(
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string,
  session: any,
  config: Config,
  options: any,
  content: string[],
  idManager: IdManager,
  HashManager: HashManager
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
    await HashManager.updateCaveContent(caveId, {
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
