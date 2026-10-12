import { createContext, Fragment, memo, useContext, useMemo, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

type SyntaxNode = {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: SyntaxNode[]
}

export type MarkdownLinkRenderer = (link: { href: string; children: ReactNode; external: boolean }) => ReactNode
export type MarkdownTextRenderer = (text: string) => ReactNode

type MarkdownProps = {
  source: string
  className?: string
  renderLink?: MarkdownLinkRenderer
  renderText?: MarkdownTextRenderer
}

// react-markdown's skipHtml drops source HTML. Convert those syntax nodes to
// text first so suspicious input stays visible for review without becoming DOM.
function preserveRawHtmlAsText() {
  return (tree: SyntaxNode) => {
    const visit = (node: SyntaxNode) => {
      node.children?.forEach((child, index) => {
        if (child.type === 'html') node.children![index] = { type: 'text', value: child.value || '' }
        else visit(child)
      })
    }
    visit(tree)
  }
}

// A future reference-linker can supply renderText without needing to fork the
// Markdown pipeline. Links and code are excluded so their contents stay intact.
function exposeTextNodes() {
  return (tree: SyntaxNode) => {
    const visit = (node: SyntaxNode, excluded = false) => {
      const isExcluded = excluded || (node.type === 'element' && ['a', 'code', 'pre'].includes(node.tagName || ''))
      if (!node.children || isExcluded) return
      node.children = node.children.map((child) => {
        if (child.type === 'text') {
          return {
            type: 'element',
            tagName: 'span',
            properties: { 'data-markdown-text': true },
            children: [child],
          }
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}

type MarkdownRenderers = Pick<MarkdownProps, 'renderLink' | 'renderText'>

// react-markdown remounts every element whose renderer changes identity, so the
// renderers live at module level and read the caller's hooks from context.
// Rebuilding them on each render replaced every link and text node in the open
// thread on each keystroke and each live update (BUG-162).
const MarkdownRenderersContext = createContext<MarkdownRenderers>({})

function MarkdownLink({ node: _node, href = '', children, ...props }: ComponentProps<'a'> & ExtraProps) {
  const { renderLink } = useContext(MarkdownRenderersContext)
  const external = /^https?:\/\//i.test(href)
  if (renderLink) return <Fragment>{renderLink({ href, children, external })}</Fragment>
  return <a {...props} className="work-item-link" href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a>
}

function MarkdownSpan({ node: _node, children, ...props }: ComponentProps<'span'> & ExtraProps) {
  const { renderText } = useContext(MarkdownRenderersContext)
  const isExposedText = Boolean((props as Record<string, unknown>)['data-markdown-text'])
  if (isExposedText && renderText) return <Fragment>{renderText(String(children ?? ''))}</Fragment>
  return <span {...props}>{children}</span>
}

const components: Components = { a: MarkdownLink, span: MarkdownSpan }
const remarkPlugins = [remarkGfm, remarkBreaks, preserveRawHtmlAsText]
const textRehypePlugins = [exposeTextNodes]

function Markdown({ source, className = '', renderLink, renderText }: MarkdownProps) {
  const renderers = useMemo(() => ({ renderLink, renderText }), [renderLink, renderText])

  return <MarkdownRenderersContext.Provider value={renderers}>
    <div className={`markdown ${className}`.trim()}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={renderText ? textRehypePlugins : undefined}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  </MarkdownRenderersContext.Provider>
}

// A note re-renders only when its own source or hooks change, so typing in the
// composer no longer re-parses every note in the thread.
export default memo(Markdown)
