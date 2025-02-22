export interface BaseElement {
  type: 'text' | 'img' | 'video'
  index: number
}

export interface TextElement extends BaseElement {
  type: 'text'
  content: string
}

export interface MediaElement extends BaseElement {
  type: 'img' | 'video'
  file?: string
  fileName?: string
  fileSize?: string
  filePath?: string
}

export type Element = TextElement | MediaElement

export interface CaveObject {
  cave_id: number
  elements: Element[]
  contributor_number: string
  contributor_name: string
}

export interface PendingCave extends CaveObject {}
