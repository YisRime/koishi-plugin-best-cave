import { Context, Logger } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import { Config, Element, TextElement, MediaElement, CaveObject, PendingCave } from '..'
import { FileHandler } from './FileHandler'
import { IdManager } from './IdManager'

/**
 * 管理洞审核相关操作的类
 */
export class AuditManager {
  private logger = new Logger('AuditManager')

  /**
   * 创建审核管理器实例
   * @param ctx - Koishi 上下文
   * @param config - 配置对象
   * @param idManager - ID 管理器实例
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private idManager: IdManager
  ) {}

  /**
   * 处理审核操作
   * @param pendingData - 待审核的洞数据数组
   * @param isApprove - 是否通过审核
   * @param caveFilePath - 洞数据文件路径
   * @param resourceDir - 资源目录路径
   * @param pendingFilePath - 待审核数据文件路径
   * @param session - 会话对象
   * @param targetId - 目标洞ID（可选）
   * @returns 处理结果消息
   */
  async processAudit(
    pendingData: PendingCave[],
    isApprove: boolean,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any,
    targetId?: number
  ): Promise<string> {
    if (pendingData.length === 0) {
      return this.sendMessage(session, 'commands.cave.audit.noPending', [], true)
    }

    // 处理单条审核
    if (typeof targetId === 'number') {
      return await this.handleSingleAudit(
        pendingData,
        isApprove,
        caveFilePath,
        resourceDir,
        pendingFilePath,
        targetId,
        session
      )
    }

    // 处理批量审核
    return await this.handleBatchAudit(
      pendingData,
      isApprove,
      caveFilePath,
      resourceDir,
      pendingFilePath,
      session
    )
  }

  /**
   * 处理单条审核
   * @param pendingData - 待审核的洞数据数组
   * @param isApprove - 是否通过审核
   * @param caveFilePath - 洞数据文件路径
   * @param resourceDir - 资源目录路径
   * @param pendingFilePath - 待审核数据文件路径
   * @param targetId - 目标洞ID
   * @param session - 会话对象
   * @returns 处理结果消息
   * @private
   */
  private async handleSingleAudit(
    pendingData: PendingCave[],
    isApprove: boolean,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    targetId: number,
    session: any
  ): Promise<string> {
    const targetCave = pendingData.find(item => item.cave_id === targetId)
    if (!targetCave) {
      return this.sendMessage(session, 'commands.cave.audit.pendingNotFound', [], true)
    }

    const newPendingData = pendingData.filter(item => item.cave_id !== targetId)

    if (isApprove) {
      const oldCaveData = await FileHandler.readJsonData<CaveObject>(caveFilePath)
      const newCaveData = [...oldCaveData, {
        ...targetCave,
        cave_id: targetId,
        elements: this.cleanElementsForSave(targetCave.elements, false)
      }]

      await FileHandler.withTransaction([
        {
          filePath: caveFilePath,
          operation: async () => FileHandler.writeJsonData(caveFilePath, newCaveData),
          rollback: async () => FileHandler.writeJsonData(caveFilePath, oldCaveData)
        },
        {
          filePath: pendingFilePath,
          operation: async () => FileHandler.writeJsonData(pendingFilePath, newPendingData),
          rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
        }
      ])
      await this.idManager.addStat(targetCave.contributor_number, targetId)
    } else {
      await FileHandler.writeJsonData(pendingFilePath, newPendingData)
      await this.idManager.markDeleted(targetId)
      await this.deleteMediaFiles(targetCave, resourceDir)
    }

    const remainingCount = newPendingData.length
    if (remainingCount > 0) {
      const remainingIds = newPendingData.map(c => c.cave_id).join(', ')
      const action = isApprove ? 'auditPassed' : 'auditRejected'
      return this.sendMessage(session, 'commands.cave.audit.pendingResult', [
        session.text(`commands.cave.audit.${action}`),
        remainingCount,
        remainingIds
      ], false)
    }
    return this.sendMessage(
      session,
      isApprove ? 'commands.cave.audit.auditPassed' : 'commands.cave.audit.auditRejected',
      [],
      false
    )
  }

  /**
   * 处理批量审核
   * @param pendingData - 待审核的洞数据数组
   * @param isApprove - 是否通过审核
   * @param caveFilePath - 洞数据文件路径
   * @param resourceDir - 资源目录路径
   * @param pendingFilePath - 待审核数据文件路径
   * @param session - 会话对象
   * @returns 处理结果消息
   * @private
   */
  private async handleBatchAudit(
    pendingData: PendingCave[],
    isApprove: boolean,
    caveFilePath: string,
    resourceDir: string,
    pendingFilePath: string,
    session: any
  ): Promise<string> {
    const data = isApprove ? await FileHandler.readJsonData<CaveObject>(caveFilePath) : null
    let processedCount = 0

    if (isApprove && data) {
      const oldData = [...data]
      const newData = [...data]

      await FileHandler.withTransaction([
        {
          filePath: caveFilePath,
          operation: async () => {
            for (const cave of pendingData) {
              newData.push({
                ...cave,
                cave_id: cave.cave_id,
                elements: this.cleanElementsForSave(cave.elements, false)
              })
              processedCount++
              await this.idManager.addStat(cave.contributor_number, cave.cave_id)
            }
            return FileHandler.writeJsonData(caveFilePath, newData)
          },
          rollback: async () => FileHandler.writeJsonData(caveFilePath, oldData)
        },
        {
          filePath: pendingFilePath,
          operation: async () => FileHandler.writeJsonData(pendingFilePath, []),
          rollback: async () => FileHandler.writeJsonData(pendingFilePath, pendingData)
        }
      ])
    } else {
      for (const cave of pendingData) {
        await this.idManager.markDeleted(cave.cave_id)
        await this.deleteMediaFiles(cave, resourceDir)
        processedCount++
      }
      await FileHandler.writeJsonData(pendingFilePath, [])
    }

    return this.sendMessage(session, 'commands.cave.audit.batchAuditResult', [
      isApprove ? '通过' : '拒绝',
      processedCount,
      pendingData.length
    ], false)
  }

  /**
   * 发送审核消息给管理员
   * @param cave - 待审核的洞数据
   * @param content - 消息内容
   * @param session - 会话对象
   */
  async sendAuditMessage(cave: PendingCave, content: string, session: any) {
    const auditMessage = `${session.text('commands.cave.audit.title')}\n${content}
${session.text('commands.cave.audit.from')}${cave.contributor_number}`

    for (const managerId of this.config.manager) {
      const bot = this.ctx.bots[0]
      if (bot) {
        try {
          await bot.sendPrivateMessage(managerId, auditMessage)
        } catch (error) {
          this.logger.error(session.text('commands.cave.audit.sendFailed', [managerId]))
        }
      }
    }
  }

  /**
   * 删除媒体文件
   * @param cave - 洞数据
   * @param resourceDir - 资源目录路径
   * @private
   */
  private async deleteMediaFiles(cave: PendingCave, resourceDir: string) {
    if (cave.elements) {
      for (const element of cave.elements) {
        if ((element.type === 'img' || element.type === 'video') && element.file) {
          const fullPath = path.join(resourceDir, element.file)
          if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath)
          }
        }
      }
    }
  }

  /**
   * 清理元素数据用于保存
   * @param elements - 元素数组
   * @param keepIndex - 是否保留索引
   * @returns 清理后的元素数组
   * @private
   */
  private cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
    if (!elements?.length) return []

    const cleanedElements = elements.map(element => {
      if (element.type === 'text') {
        const cleanedElement: Partial<TextElement> = {
          type: 'text' as const,
          content: (element as TextElement).content
        }
        if (keepIndex) cleanedElement.index = element.index
        return cleanedElement as TextElement
      } else if (element.type === 'img' || element.type === 'video') {
        const mediaElement = element as MediaElement
        const cleanedElement: Partial<MediaElement> = {
          type: mediaElement.type
        }
        if (mediaElement.file) cleanedElement.file = mediaElement.file
        if (keepIndex) cleanedElement.index = element.index
        return cleanedElement as MediaElement
      }
      return element
    })

    return keepIndex ? cleanedElements.sort((a, b) => (a.index || 0) - (b.index || 0)) : cleanedElements
  }

  /**
   * 发送消息
   * @param session - 会话对象
   * @param key - 消息key
   * @param params - 消息参数
   * @param isTemp - 是否为临时消息
   * @param timeout - 临时消息超时时间
   * @returns 空字符串
   * @private
   */
  private async sendMessage(
    session: any,
    key: string,
    params: any[] = [],
    isTemp = true,
    timeout = 10000
  ): Promise<string> {
    try {
      const msg = await session.send(session.text(key, params))
      if (isTemp && msg) {
        setTimeout(async () => {
          try {
            await session.bot.deleteMessage(session.channelId, msg)
          } catch (error) {
            this.logger.debug(`Failed to delete temporary message: ${error.message}`)
          }
        }, timeout)
      }
    } catch (error) {
      this.logger.error(`Failed to send message: ${error.message}`)
    }
    return ''
  }
}
