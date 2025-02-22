import * as fs from 'fs'
import * as path from 'path'
import { Config, Element } from '..'
import { FileHandler } from './FileHandler'
import { IdManager } from './IdManager'
import { HashManager } from './HashManager'
import { buildMessage, sendMessage } from './MediaHandler'

interface CaveObject {
  cave_id: number
  elements: Element[]
  contributor_number: string
  contributor_name: string
}

interface PendingCave extends CaveObject {}

/**
 * 处理回声洞列表查询
 * @param session - 会话对象
 * @param config - 配置对象
 * @param idManager - ID管理器实例
 * @param userId - 可选的用户ID，用于筛选特定用户的回声洞
 * @param pageNum - 页码，默认为1
 * @returns 格式化后的回声洞列表字符串
 */
export async function processList(
  session: any,
  config: Config,
  idManager: IdManager,
  userId?: string,
  pageNum: number = 1
): Promise<string> {
  const stats = idManager.getStats();

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

/**
 * 查看指定ID的回声洞内容
 * @param caveFilePath - 回声洞数据文件路径
 * @param resourceDir - 资源文件目录路径
 * @param session - 会话对象
 * @param options - 命令选项
 * @param content - 命令内容数组
 * @returns 回声洞内容的格式化字符串
 */
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

/**
 * 随机获取一个回声洞
 * @param caveFilePath - 回声洞数据文件路径
 * @param resourceDir - 资源文件目录路径
 * @param session - 会话对象
 * @returns 随机回声洞的格式化字符串，如果没有可用的回声洞则返回错误消息
 */
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

/**
 * 删除指定ID的回声洞
 * @param caveFilePath - 回声洞数据文件路径
 * @param resourceDir - 资源文件目录路径
 * @param pendingFilePath - 待审核回声洞数据文件路径
 * @param session - 会话对象
 * @param config - 配置对象
 * @param options - 命令选项
 * @param content - 命令内容数组
 * @param idManager - ID管理器实例
 * @param HashManager - 哈希管理器实例
 * @returns 删除操作的结果消息
 */
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
  const targetInData = data.find(item => item.cave_id === caveId);
  const targetInPending = pendingData.find(item => item.cave_id === caveId);

  if (!targetInData && !targetInPending) {
    return sendMessage(session, 'commands.cave.error.notFound', [], true);
  }

  const targetCave = targetInData || targetInPending;
  const isPending = !targetInData;

  if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
    return sendMessage(session, 'commands.cave.remove.noPermission', [], true);
  }

  const caveContent = await buildMessage(targetCave, resourceDir, session);

  if (targetCave.elements) {
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

  if (isPending) {
    const newPendingData = pendingData.filter(item => item.cave_id !== caveId);
    await FileHandler.writeJsonData(pendingFilePath, newPendingData);
  } else {
    const newData = data.filter(item => item.cave_id !== caveId);
    await FileHandler.writeJsonData(caveFilePath, newData);
    await idManager.removeStat(targetCave.contributor_number, caveId);
  }

  await idManager.markDeleted(caveId);

  const deleteStatus = isPending
    ? session.text('commands.cave.remove.deletePending')
    : '';
  const deleteMessage = session.text('commands.cave.remove.deleted');
  return `${deleteMessage}${deleteStatus}${caveContent}`;
}
