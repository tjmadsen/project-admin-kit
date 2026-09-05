import { Fragment, type ReactNode } from 'react'
import { itemRef, matchesItemReference } from '../lib/format'
import type { WorkItem } from '../lib/types'

const httpUrlPattern = /\bhttps?:\/\/[^\s<>"']+/gi
const itemReferencePattern = /\b(FR-\d+|BUG-\d+)\b/g
const sentencePunctuationPattern = /[.,!?;:]$/
const bracketPairs = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
])

interface Token {
  start: number
  end: number
  node: ReactNode
}

function countCharacter(value: string, character: string) {
  return [...value].filter((current) => current === character).length
}

function splitTrailingPunctuation(candidate: string) {
  let url = candidate
  let trailing = ''

  while (url) {
    const lastCharacter = url.at(-1)!
    const openingBracket = bracketPairs.get(lastCharacter)
    const isUnmatchedClosingBracket = openingBracket
      ? countCharacter(url, lastCharacter) > countCharacter(url, openingBracket)
      : false
    if (!sentencePunctuationPattern.test(lastCharacter) && !isUnmatchedClosingBracket) break
    trailing = lastCharacter + trailing
    url = url.slice(0, -1)
  }

  return { url, trailing }
}

function urlTokens(text: string): Token[] {
  return [...text.matchAll(httpUrlPattern)].map((match) => {
    const start = match.index
    const { url, trailing } = splitTrailingPunctuation(match[0])
    return {
      start,
      end: start + match[0].length,
      node: <Fragment key={`url-${start}`}><a className="work-item-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>{trailing}</Fragment>,
    }
  })
}

function itemReferenceTokens(text: string, items: WorkItem[], onSelectItem: (item: WorkItem) => void): Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(itemReferencePattern)) {
    const start = match.index
    const token = match[0]
    const target = items.find((candidate) => matchesItemReference(candidate, token))
    if (!target) continue
    tokens.push({
      start,
      end: start + token.length,
      node: <button type="button" key={`ref-${start}`} className="work-item-ref-link" onClick={() => onSelectItem(target)}>{itemRef(target.kind, target.number)}</button>,
    })
  }
  return tokens
}

// Renders bare https URLs and FR-N/BUG-N references as links. FR-N/BUG-N
// only linkify when both `items` and `onSelectItem` are given and the
// reference resolves; unresolved references render as plain text.
export default function LinkifiedText({ text, items, onSelectItem }: { text: string; items?: WorkItem[]; onSelectItem?: (item: WorkItem) => void }) {
  const tokens = [...urlTokens(text), ...(items && onSelectItem ? itemReferenceTokens(text, items, onSelectItem) : [])].sort((a, b) => a.start - b.start)

  const parts: ReactNode[] = []
  let textStart = 0
  for (const token of tokens) {
    if (token.start < textStart) continue
    if (token.start > textStart) parts.push(text.slice(textStart, token.start))
    parts.push(token.node)
    textStart = token.end
  }
  if (textStart < text.length) parts.push(text.slice(textStart))
  return <>{parts}</>
}
